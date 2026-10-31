import assert from "node:assert/strict";
import test from "node:test";

import { computeSignedNonce, decryptData, encryptData } from "../src/crypto.js";
import { createWorker } from "../src/index.js";
import { TOKEN_KEY } from "../src/xiaomi.js";

const AUTH_TOKEN = "test-mcp-bearer";
const SSECURITY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

class MemoryKv {
  constructor(initial = {}) {
    this.values = new Map(Object.entries(initial));
  }
  async get(key) {
    return this.values.get(key) ?? null;
  }
  async put(key, value) {
    this.values.set(key, value);
  }
  async delete(key) {
    this.values.delete(key);
  }
}

function tokenRecord() {
  return {
    user_id: "account-user",
    c_user_id: "c-user-secret",
    service_token: "service-token-secret",
    ssecurity: SSECURITY,
    device_id: "an_test",
    auth_state: "valid",
  };
}

function envWithKv(kv) {
  return { AUTH_TOKEN, MI_HEALTH_KV: kv };
}

function callMcp(worker, env, id, name, args) {
  return worker.fetch(
    new Request("https://worker.example/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${AUTH_TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
    env,
  ).then(async (response) => {
    const json = await response.json();
    return {
      isError: json.result.isError,
      text: json.result.content[0].text,
      value: json.result.isError ? null : JSON.parse(json.result.content[0].text),
    };
  });
}

function encryptedApiMock(routes) {
  const calls = [];
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    const route = routes[url.pathname];
    if (!route) throw new Error(`unexpected network request: ${url}`);
    const form =
      options.method === "POST"
        ? new URLSearchParams(options.body)
        : url.searchParams;
    const nonce = form.get("_nonce");
    const signedNonce = await computeSignedNonce(SSECURITY, nonce);
    const encryptedData = form.get("data");
    const params = encryptedData
      ? JSON.parse(await decryptData(signedNonce, encryptedData))
      : {};
    calls.push({ url, params });
    const payload = typeof route === "function" ? await route(params, calls.length) : route;
    if (payload instanceof Response) return payload;
    return new Response(await encryptData(signedNonce, JSON.stringify(payload)), {
      status: 200,
    });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

const HEALTH_PATH = "/app/v1/data/get_fitness_data_by_time";
const RELATIVE_LIST_PATH = "/app/v1/relatives/get_relative_list";
const RELATIVE_AGG_PATH = "/app/v1/relatives/get_aggregated_data";

function dateRange(startIso, days) {
  return Array.from({ length: days }, (_, index) =>
    new Date(Date.parse(`${startIso}T00:00:00Z`) + index * 86_400_000)
      .toISOString()
      .slice(0, 10),
  );
}

test("90-day range is split into ≤30-day segments, merged, and sorted", async () => {
  const kv = new MemoryKv({ [TOKEN_KEY]: JSON.stringify(tokenRecord()) });
  // 90 天范围：2026-01-01 到 2026-03-31（2026 非闰年）。
  const segments = [
    { start_date: "2026-01-01", end_date: "2026-01-30", days: 30 },
    { start_date: "2026-01-31", end_date: "2026-03-01", days: 30 },
    { start_date: "2026-03-02", end_date: "2026-03-31", days: 30 },
  ];
  const fetchImpl = encryptedApiMock({
    [HEALTH_PATH]: (params, callIndex) => {
      const segment = segments[callIndex - 1];
      assert.equal(params.start_time, Date.parse(`${segment.start_date}T00:00:00Z`) / 1000 - 8 * 3600 - 18 * 3600);
      assert.equal(
        params.end_time,
        (Date.parse(`${segment.end_date}T00:00:00Z`) + 86_400_000) / 1000 - 8 * 3600 - 1 + 18 * 3600,
      );
      return {
        code: 0,
        result: {
          // 每段返回段内每天的 sleep 记录，边界日期在两段都出现，验证合并去重。
          data_list: dateRange(segment.start_date, segment.days).map((date) => ({
            time: Date.parse(`${date}T23:00:00Z`) / 1000,
            zone_offset: 0,
            value: JSON.stringify({ total_duration: 420 }),
          })),
          has_more: false,
        },
      };
    },
  });
  const worker = createWorker({ fetchImpl });
  const result = await callMcp(worker, envWithKv(kv), "seg", "health_history", {
    metric: "sleep",
    start_date: "2026-01-01",
    end_date: "2026-03-31",
  });
  const value = result.value;
  assert.equal(value.metric, "sleep");
  assert.equal(value.start_date, "2026-01-01");
  assert.equal(value.end_date, "2026-03-31");
  assert.equal(value.days_requested, 90);
  assert.equal(value.days_returned, 90);
  assert.equal(value.data.length, 90);
  const dates = value.data.map((record) => record.date);
  assert.deepEqual([...dates].sort(), dates, "data sorted by date");
  assert.equal(new Set(dates).size, 90, "no duplicate dates");
  assert.equal(value.data[0].date, "2026-01-01");
  assert.equal(value.data[89].date, "2026-03-31");
  assert.deepEqual(value.data_quality.missing_dates, []);
  assert.equal(value.data_quality.coverage, 1);
  assert.equal(fetchImpl.calls.length, 3);
});

test("argument validation rejects invalid ranges before any network call", async () => {
  const kv = new MemoryKv({ [TOKEN_KEY]: JSON.stringify(tokenRecord()) });
  const fetchImpl = encryptedApiMock({
    [HEALTH_PATH]: () => {
      throw new Error("no network expected");
    },
  });
  const worker = createWorker({ fetchImpl });
  const cases = [
    [{ metric: "sleep", start_date: "2026-03-10", end_date: "2026-03-01" }, /start_date 必须不晚于 end_date/],
    [{ metric: "sleep", start_date: "2025-01-01", end_date: "2026-01-02" }, /最多 366 天/],
    [{ metric: "sleep", start_date: "2026-02-30", end_date: "2026-03-05" }, /start_date 必须是/],
    [{ metric: "sleep", start_date: "not-a-date", end_date: "2026-03-05" }, /start_date 必须是/],
    [{ metric: "sleep", start_date: "2026-01-01" }, /end_date 必须是/],
  ];
  for (const [args, expected] of cases) {
    const result = await callMcp(worker, envWithKv(kv), "bad-args", "health_history", args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(result.text, expected, JSON.stringify(args));
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test("future end_date truncates to today and flags partial_today", async () => {
  const kv = new MemoryKv({ [TOKEN_KEY]: JSON.stringify(tokenRecord()) });
  // 工具默认按 Asia/Shanghai 判定“今天”；此用例显式传 timezone=UTC，
  // 避免结果取决于运行机器的挂钟时刻。mock 只返回起点日和今天的数据。
  const today = new Date().toISOString().slice(0, 10);
  const fetchImpl = encryptedApiMock({
    [HEALTH_PATH]: (params) => {
      const start = new Date((params.start_time + 8 * 3600 + 18 * 3600) * 1000)
        .toISOString()
        .slice(0, 10);
      const end = new Date((params.end_time + 8 * 3600 - 18 * 3600 + 1) * 1000)
        .toISOString()
        .slice(0, 10);
      const dates = [start, end].filter((date) => date >= "2026-09-01" && date <= today);
      return {
        code: 0,
        result: {
          data_list: dates.map((date, index) => ({
            time: Date.parse(`${date}T08:00:00Z`) / 1000,
            zone_offset: 0,
            value: JSON.stringify({ steps: 1000 + index }),
          })),
          has_more: false,
        },
      };
    },
  });
  const worker = createWorker({ fetchImpl });
  const result = await callMcp(worker, envWithKv(kv), "future", "health_history", {
    metric: "steps",
    start_date: "2026-09-01",
    end_date: "2099-12-31",
    timezone: "UTC",
  });
  const value = result.value;
  assert.equal(value.end_date, today);
  const expectedDays = Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse("2026-09-01T00:00:00Z")) / 86_400_000,
  ) + 1;
  assert.equal(value.days_requested, expectedDays);
  assert.equal(value.days_requested,
    value.days_returned +
    (value.data_quality.missing_dates_count ?? value.data_quality.missing_dates.length));
  const last = value.data.at(-1);
  assert.equal(last.date, today);
  assert.equal(last.partial_today, true);
  assert.equal(value.data.filter((record) => record.partial_today).length, 1);
});

test("missing_dates lists absent days and coverage reflects them", async () => {
  const kv = new MemoryKv({ [TOKEN_KEY]: JSON.stringify(tokenRecord()) });
  const present = new Set(["2026-01-01", "2026-01-03", "2026-01-05", "2026-01-07"]);
  const fetchImpl = encryptedApiMock({
    [HEALTH_PATH]: () => ({
      code: 0,
      result: {
        data_list: [...present].map((date) => ({
          time: Date.parse(`${date}T12:00:00Z`) / 1000,
          zone_offset: 0,
          value: JSON.stringify({ steps: 3000 }),
        })),
        has_more: false,
      },
    }),
  });
  const worker = createWorker({ fetchImpl });
  const result = await callMcp(worker, envWithKv(kv), "missing", "health_history", {
    metric: "steps",
    start_date: "2026-01-01",
    end_date: "2026-01-10",
  });
  const value = result.value;
  assert.equal(value.days_requested, 10);
  assert.equal(value.days_returned, 4);
  assert.deepEqual(value.data_quality.missing_dates, [
    "2026-01-02",
    "2026-01-04",
    "2026-01-06",
    "2026-01-08",
    "2026-01-09",
    "2026-01-10",
  ]);
  assert.equal(value.data_quality.coverage, 0.4);
});

test("missing_dates caps at 30 entries and reports the total count", async () => {
  const kv = new MemoryKv({ [TOKEN_KEY]: JSON.stringify(tokenRecord()) });
  const fetchImpl = encryptedApiMock({
    [HEALTH_PATH]: () => ({
      code: 0,
      result: {
        data_list: [{
          time: Date.parse("2026-01-01T12:00:00Z") / 1000,
          zone_offset: 0,
          value: JSON.stringify({ steps: 100 }),
        }],
        has_more: false,
      },
    }),
  });
  const worker = createWorker({ fetchImpl });
  // 90 天里只有 1 天有数据 → 89 天缺失，只列前 30 个。
  const result = await callMcp(worker, envWithKv(kv), "cap", "health_history", {
    metric: "steps",
    start_date: "2026-01-01",
    end_date: "2026-03-31",
  });
  const value = result.value;
  assert.equal(value.days_requested, 90);
  assert.equal(value.data_quality.missing_dates.length, 30);
  assert.equal(value.data_quality.missing_dates[0], "2026-01-02");
  assert.equal(value.data_quality.missing_dates_count, 89);
  assert.equal(value.data_quality.coverage, Math.round((1 / 90) * 100) / 100);
});

test("relative target uses the relatives aggregated endpoint per segment", async () => {
  const kv = new MemoryKv({ [TOKEN_KEY]: JSON.stringify(tokenRecord()) });
  const segmentCalls = [];
  const fetchImpl = encryptedApiMock({
    [RELATIVE_LIST_PATH]: {
      code: 0,
      result: { relative_list: [{ relative_uid: 42, relative_note: "家人" }] },
    },
    [RELATIVE_AGG_PATH]: (params) => {
      segmentCalls.push({
        relative_uid: params.relative_uid,
        key: params.key,
        tag: params.tag,
        limit: params.limit,
      });
      return {
        code: 0,
        result: {
          data_list: [
            {
              time: Date.parse("2026-02-15T12:00:00Z") / 1000,
              value: JSON.stringify({ steps: 5555 }),
            },
            {
              time: Date.parse("2026-03-20T12:00:00Z") / 1000,
              value: JSON.stringify({ steps: 6666 }),
            },
          ],
        },
      };
    },
  });
  const worker = createWorker({ fetchImpl });
  const result = await callMcp(worker, envWithKv(kv), "relative", "health_history", {
    target: "relative",
    relative_uid: 42,
    metric: "steps",
    start_date: "2026-01-01",
    end_date: "2026-03-31",
  });
  const value = result.value;
  assert.equal(value.target, "relative");
  assert.equal(value.relative_uid, "42");
  assert.equal(value.days_returned, 2);
  assert.equal(value.data[0].date, "2026-02-15");
  assert.equal(value.data[0].steps, 5555);
  assert.equal(value.data[1].date, "2026-03-20");
  assert.equal(value.data[1].steps, 6666);
  assert.equal(segmentCalls.length, 3);
  assert.ok(segmentCalls.every((call) => call.relative_uid === "42"));
  assert.ok(segmentCalls.every((call) => call.key === "steps"));
  assert.ok(segmentCalls.every((call) => call.tag === "daily_report"));
  assert.ok(segmentCalls.every((call) => call.limit === 30));
});

test("366-day range is allowed and 367 is rejected", async () => {
  const kv = new MemoryKv({ [TOKEN_KEY]: JSON.stringify(tokenRecord()) });
  const fetchImpl = encryptedApiMock({
    [HEALTH_PATH]: () => ({ code: 0, result: { data_list: [], has_more: false } }),
  });
  const worker = createWorker({ fetchImpl });

  const rejected = await callMcp(worker, envWithKv(kv), "over", "health_history", {
    metric: "sleep",
    start_date: "2025-01-01",
    end_date: "2026-01-02",
  });
  assert.equal(rejected.isError, true);
  assert.match(rejected.text, /最多 366 天/);

  const accepted = await callMcp(worker, envWithKv(kv), "max", "health_history", {
    metric: "sleep",
    start_date: "2025-01-01",
    end_date: "2026-01-01",
  });
  assert.equal(accepted.isError, undefined);
  assert.equal(accepted.value.days_requested, 366);
  // ceil(366/30) = 13 段
  assert.equal(fetchImpl.calls.length, 13);
  assert.deepEqual(accepted.value.data_quality.missing_dates.length, 30);
  assert.equal(accepted.value.data_quality.missing_dates_count, 366);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  computeSignedNonce,
  decryptData,
  encryptData,
} from "../src/crypto.js";
import { createWorker } from "../src/index.js";
import {
  LOGIN_SESSION_KEY,
  TOKEN_KEY,
} from "../src/xiaomi.js";

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

function tokenRecord(overrides = {}) {
  return {
    user_id: "account-user",
    c_user_id: "c-user-secret",
    service_token: "service-token-secret",
    ssecurity: SSECURITY,
    pass_token: "pass-token-secret",
    device_id: "an_test",
    auth_state: "valid",
    updated_at: "2026-08-24T08:00:00.000Z",
    last_checked_at: null,
    last_error: null,
    ...overrides,
  };
}

function envWithKv(kv = new MemoryKv(), overrides = {}) {
  return { AUTH_TOKEN, MI_HEALTH_KV: kv, ...overrides };
}

function mcpRequest(body, bearer = AUTH_TOKEN) {
  const headers = { "Content-Type": "application/json" };
  if (bearer !== null) headers.Authorization = `Bearer ${bearer}`;
  return new Request("https://worker.example/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function callMcp(worker, env, body, bearer = AUTH_TOKEN) {
  const response = await worker.fetch(mcpRequest(body, bearer), env);
  const json = response.status === 202 ? null : await response.json();
  return { response, json };
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
    assert.ok(nonce, "encrypted Xiaomi request includes _nonce");
    const signedNonce = await computeSignedNonce(SSECURITY, nonce);
    const encryptedData = form.get("data");
    const params = encryptedData
      ? JSON.parse(await decryptData(signedNonce, encryptedData))
      : {};
    calls.push({ url, options, params });
    const payload = typeof route === "function" ? await route(url, options, params) : route;
    if (payload instanceof Response) return payload;
    const ciphertext = await encryptData(
      signedNonce,
      JSON.stringify(payload),
    );
    return new Response(ciphertext, { status: 200 });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function passTokenSessionMock({
  healthRoute,
  serviceLoginCode = 0,
  expectedDeviceId,
  directLogin = false,
} = {}) {
  const healthFetch = encryptedApiMock({
    "/app/v1/data/get_fitness_data_by_time": healthRoute || {
      code: 0,
      result: { data_list: [], has_more: false },
    },
  });
  const accountCalls = [];
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    if (url.hostname === "account.xiaomi.com" && url.pathname === "/pass/serviceLogin") {
      accountCalls.push({ url, options });
      assert.equal(url.searchParams.get("_json"), "true");
      assert.equal(url.searchParams.get("sid"), "miothealth");
      assert.match(options.headers.Cookie, /userId=synthetic-user/);
      assert.match(options.headers.Cookie, /passToken=synthetic-pass-token/);
      assert.match(options.headers.Cookie, /sdkVersion=3\.9/);
      if (expectedDeviceId) assert.match(options.headers.Cookie, new RegExp(`deviceId=${expectedDeviceId}`));
      return new Response(
        `&&&START&&&${JSON.stringify({
          code: 0,
          ...(directLogin
            ? {
                userId: "account-user",
                cUserId: "c-user-secret",
                ssecurity: SSECURITY,
                nonce: "nonce-value",
                location: "https://sts.api.io.mi.com/login-complete?sid=miothealth",
              }
            : {
                _sign: "sign-value",
                callback: "https://sts-hlth.io.mi.com/healthapp/sts",
                qs: "%3Fsid%3Dmiothealth%26_json%3Dtrue",
              }),
        })}`,
        { status: 200 },
      );
    }
    if (url.hostname === "account.xiaomi.com" && url.pathname === "/pass/serviceLoginAuth2") {
      accountCalls.push({ url, options });
      assert.equal(options.method, "POST");
      assert.match(options.headers.Cookie, /userId=synthetic-user/);
      assert.match(options.headers.Cookie, /passToken=synthetic-pass-token/);
      assert.match(options.headers.Cookie, /sdkVersion=3\.9/);
      if (expectedDeviceId) assert.match(options.headers.Cookie, new RegExp(`deviceId=${expectedDeviceId}`));
      const form = new URLSearchParams(options.body);
      assert.equal(form.get("user"), "synthetic-user");
      assert.equal(form.get("sid"), "miothealth");
      assert.equal(form.get("_sign"), "sign-value");
      return new Response(
        `&&&START&&&${JSON.stringify(
          serviceLoginCode === 0
            ? {
                code: 0,
                userId: "account-user",
                cUserId: "c-user-secret",
                ssecurity: SSECURITY,
                nonce: "nonce-value",
                location: "https://sts.api.io.mi.com/login-complete?sid=miothealth",
              }
            : { code: serviceLoginCode },
        )}`,
        { status: 200 },
      );
    }
    if (url.hostname === "sts.api.io.mi.com" && url.pathname === "/login-complete") {
      assert.ok(url.searchParams.get("clientSign"));
      return new Response(null, {
        status: 302,
        headers: { "Set-Cookie": "serviceToken=service-token-secret; Path=/; HttpOnly" },
      });
    }
    return healthFetch(input, options);
  };
  fetchImpl.accountCalls = accountCalls;
  fetchImpl.healthCalls = healthFetch.calls;
  return fetchImpl;
}

test("MCP endpoint rejects missing and invalid Bearer tokens", async () => {
  const worker = createWorker({ fetchImpl: async () => assert.fail("no network") });
  const env = envWithKv();

  const missing = await worker.fetch(mcpRequest({ jsonrpc: "2.0", id: 1, method: "initialize" }, null), env);
  assert.equal(missing.status, 401);

  const invalid = await worker.fetch(mcpRequest({ jsonrpc: "2.0", id: 1, method: "initialize" }, "wrong"), env);
  assert.equal(invalid.status, 401);
});

test("Worker health check is available without MCP authorization", async () => {
  const worker = createWorker({ fetchImpl: async () => assert.fail("no network") });
  const response = await worker.fetch(new Request("https://worker.example/"), envWithKv());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    service: "mi-health-mcp",
    mcp_endpoint: "/mcp",
  });
});

test("initialize, tools/list, and initialized notification follow JSON-RPC", async () => {
  const worker = createWorker({ fetchImpl: async () => assert.fail("no network") });
  const env = envWithKv();

  const initialized = await callMcp(worker, env, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05" },
  });
  assert.equal(initialized.response.status, 200);
  assert.equal(initialized.json.result.serverInfo.name, "mi-health-mcp");
  assert.deepEqual(initialized.json.result.capabilities, {
    tools: { listChanged: false },
  });

  const listed = await callMcp(worker, env, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
  });
  assert.deepEqual(
    listed.json.result.tools.map((tool) => tool.name),
    [
      "health_latest",
      "health_sleep",
      "health_heart",
      "health_steps",
      "health_auth_status",
      "health_me",
      "health_relatives",
      "health_login_status",
      "health_login_refresh",
      "health_login_start",
      "health_login_poll",
    ],
  );

  const notification = await callMcp(worker, env, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  assert.equal(notification.response.status, 202);
  assert.equal(notification.json, null);
});

test("health_auth_status reports metadata without exposing credentials", async () => {
  const kv = new MemoryKv({
    [TOKEN_KEY]: JSON.stringify(tokenRecord()),
  });
  const worker = createWorker({ fetchImpl: async () => assert.fail("no network") });
  const result = await callMcp(worker, envWithKv(kv), {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "health_auth_status", arguments: {} },
  });

  const status = JSON.parse(result.json.result.content[0].text);
  assert.deepEqual(status, {
    token_present: true,
    status: "valid",
    user_id: "account-user",
    updated_at: "2026-08-24T08:00:00.000Z",
    last_checked_at: null,
    message: "凭证已就绪",
  });
  assert.doesNotMatch(JSON.stringify(result.json), /service-token-secret|pass-token-secret|c-user-secret/);
});

test("health_me reports the current account without exposing credentials", async () => {
  const kv = new MemoryKv({ [TOKEN_KEY]: JSON.stringify(tokenRecord()) });
  const worker = createWorker({ fetchImpl: async () => assert.fail("no network") });
  const result = await callMcp(worker, envWithKv(kv), {
    jsonrpc: "2.0",
    id: 31,
    method: "tools/call",
    params: { name: "health_me", arguments: {} },
  });

  const value = JSON.parse(result.json.result.content[0].text);
  assert.deepEqual(value, {
    logged_in: true,
    user_id: "account-user",
    status: "valid",
    updated_at: "2026-08-24T08:00:00.000Z",
  });
  assert.doesNotMatch(JSON.stringify(result.json), /service-token-secret|pass-token-secret|c-user-secret/);
});

test("health_me explains how to log in when no credential is stored", async () => {
  const worker = createWorker({ fetchImpl: async () => assert.fail("no network") });
  const result = await callMcp(worker, envWithKv(), {
    jsonrpc: "2.0",
    id: 32,
    method: "tools/call",
    params: { name: "health_me", arguments: {} },
  });

  assert.equal(result.json.result.isError, true);
  assert.match(result.json.result.content[0].text, /health_login_start/);
});

test("health_login_status is usable when passToken secrets are absent", async () => {
  const worker = createWorker({ fetchImpl: async () => assert.fail("no network") });
  const result = await callMcp(worker, envWithKv(), {
    jsonrpc: "2.0",
    id: 33,
    method: "tools/call",
    params: { name: "health_login_status", arguments: {} },
  });
  const value = JSON.parse(result.json.result.content[0].text);
  assert.equal(value.logged_in, false);
  assert.equal(value.session_valid, false);
  assert.match(value.message, /XIAOMI_USER_ID/);
});

test("health_latest defaults to the signed-in account and uses the self data endpoint", async () => {
  const kv = new MemoryKv({
    [TOKEN_KEY]: JSON.stringify(tokenRecord()),
  });
  const fetchImpl = encryptedApiMock({
    "/app/v1/data/get_fitness_data_by_time": (url, options, params) => {
      assert.equal(options.method, "POST");
      assert.equal(params.key === "sleep" || params.key === "heart_rate" || params.key === "steps", true);
      assert.equal(
        params.end_time - params.start_time + 1,
        (params.key === "sleep" ? 2 * 86400 : 86400) + 36 * 3600,
      );
      return {
        code: 0,
        result: {
          data_list: [
            {
              time: 1_787_558_400,
              value: JSON.stringify(
                params.key === "sleep"
                  ? { total_duration: 455, sleep_score: 86 }
                  : params.key === "heart_rate"
                    ? { bpm: 72 }
                    : { steps: 1234 },
              ),
            },
          ],
          has_more: false,
        },
      };
    },
  });
  const worker = createWorker({ fetchImpl });
  const result = await callMcp(worker, envWithKv(kv), {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "health_latest", arguments: {} },
  });
  const value = JSON.parse(result.json.result.content[0].text);

  assert.equal(value.target, "self");
  assert.equal(value.user_id, "account-user");
  assert.equal(value.data.sleep.total_duration, 455);
  assert.equal(value.data.heart_rate.avg_hr, 72);
  assert.equal(value.data.heart_rate.sample_count, 1);
  assert.equal(value.data.steps.steps, 1234);
  assert.equal(fetchImpl.calls.length, 3);
  assert.equal(
    fetchImpl.calls.every((call) => call.url.pathname === "/app/v1/data/get_fitness_data_by_time"),
    true,
  );
  assert.doesNotMatch(JSON.stringify(result.json), /service-token-secret/);
});

test("self daily series defaults to seven days, accepts empty data, and rejects over 30", async () => {
  const kv = new MemoryKv({
    [TOKEN_KEY]: JSON.stringify(tokenRecord()),
  });
  const fetchImpl = encryptedApiMock({
    "/app/v1/data/get_fitness_data_by_time": {
      code: 0,
      result: { data_list: [], has_more: false },
    },
  });
  const worker = createWorker({ fetchImpl });
  const valid = await callMcp(worker, envWithKv(kv), {
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "health_sleep", arguments: {} },
  });
  const value = JSON.parse(valid.json.result.content[0].text);
  assert.equal(value.target, "self");
  assert.equal(value.user_id, "account-user");
  assert.equal(value.days, 7);
  assert.deepEqual(value.data, []);
  assert.match(value.message, /暂无数据/);

  const invalid = await callMcp(worker, envWithKv(kv), {
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: { name: "health_steps", arguments: { days: 31 } },
  });
  assert.equal(invalid.json.result.isError, true);
  assert.match(invalid.json.result.content[0].text, /1 到 30/);
});

test("self steps, sleep, and heart queries use the self data endpoint", async () => {
  const kv = new MemoryKv({ [TOKEN_KEY]: JSON.stringify(tokenRecord()) });
  const fetchImpl = encryptedApiMock({
    "/app/v1/data/get_fitness_data_by_time": (url, options, params) => {
      assert.equal(options.method, "POST");
      assert.equal("relative_uid" in params, false);
      const values = {
        steps: { steps: 1234 },
        sleep: { duration: 455, sleep_score: 86 },
        heart_rate: { bpm: 72 },
      };
      return {
        code: 0,
        result: {
          data_list: [{ time: 1_787_558_400, value: JSON.stringify(values[params.key]) }],
          has_more: false,
        },
      };
    },
  });
  const worker = createWorker({ fetchImpl });
  const cases = [
    ["health_steps", "steps"],
    ["health_sleep", "sleep"],
    ["health_heart", "heart_rate"],
  ];

  for (const [name, metric] of cases) {
    const result = await callMcp(worker, envWithKv(kv), {
      jsonrpc: "2.0",
      id: name,
      method: "tools/call",
      params: { name, arguments: { target: "self", relative_uid: "42", days: 1 } },
    });
    const value = JSON.parse(result.json.result.content[0].text);
    assert.equal(value.target, "self");
    assert.equal(value.user_id, "account-user");
    assert.equal(value.metric, metric);
    assert.equal(value.data.length, 1);
  }
  assert.equal(fetchImpl.calls.length, 3);
});

test("health_relatives returns safe identifiers and a missing relative_uid is explicit", async () => {
  const kv = new MemoryKv({
    [TOKEN_KEY]: JSON.stringify(tokenRecord()),
  });
  const fetchImpl = encryptedApiMock({
    "/app/v1/relatives/get_relative_list": {
      code: 0,
      result: {
        relative_list: [
          { relative_uid: 42, relative_note: "妈妈", nickname: "小米用户" },
          { relative_uid: 99, relative_note: "爸爸", service_token: "must-not-return" },
        ],
      },
    },
  });
  const worker = createWorker({ fetchImpl });
  const listed = await callMcp(worker, envWithKv(kv), {
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "health_relatives", arguments: {} },
  });
  const relatives = JSON.parse(listed.json.result.content[0].text);
  assert.deepEqual(relatives, [
    { relative_uid: "42", relative_note: "妈妈", nickname: "小米用户" },
    { relative_uid: "99", relative_note: "爸爸" },
  ]);
  assert.doesNotMatch(JSON.stringify(listed.json), /must-not-return/);

  const missing = await callMcp(worker, envWithKv(kv), {
    jsonrpc: "2.0",
    id: 71,
    method: "tools/call",
    params: {
      name: "health_steps",
      arguments: { target: "relative", relative_uid: "123" },
    },
  });
  assert.equal(missing.json.result.isError, true);
  assert.match(missing.json.result.content[0].text, /未找到 relative_uid=123/);
});

test("relative queries require relative_uid and use relatives endpoints", async () => {
  const kv = new MemoryKv({ [TOKEN_KEY]: JSON.stringify(tokenRecord()) });
  const fetchImpl = encryptedApiMock({
    "/app/v1/relatives/get_relative_list": {
      code: 0,
      result: { relative_list: [{ relative_uid: 42, relative_note: "妈妈" }] },
    },
    "/app/v1/relatives/get_aggregated_data": {
      code: 0,
      result: { data_list: [{ time: 1_787_558_400, value: '{"steps":456}' }] },
    },
  });
  const worker = createWorker({ fetchImpl });
  const missingUid = await callMcp(worker, envWithKv(kv), {
    jsonrpc: "2.0",
    id: 72,
    method: "tools/call",
    params: { name: "health_steps", arguments: { target: "relative" } },
  });
  assert.equal(missingUid.json.result.isError, true);
  assert.match(missingUid.json.result.content[0].text, /relative_uid/);

  const result = await callMcp(worker, envWithKv(kv), {
    jsonrpc: "2.0",
    id: 73,
    method: "tools/call",
    params: {
      name: "health_steps",
      arguments: { target: "relative", relative_uid: 42, days: 1 },
    },
  });
  const value = JSON.parse(result.json.result.content[0].text);
  assert.equal(value.target, "relative");
  assert.equal(value.relative_uid, "42");
  assert.equal(value.data[0].steps, 456);
  assert.equal(fetchImpl.calls.at(-1).url.pathname, "/app/v1/relatives/get_aggregated_data");
});

test("passToken secrets create and persist a miothealth session without storing passToken", async () => {
  const kv = new MemoryKv();
  const fetchImpl = passTokenSessionMock();
  const env = envWithKv(kv, {
    XIAOMI_USER_ID: "synthetic-user",
    XIAOMI_PASS_TOKEN: "synthetic-pass-token",
  });
  const worker = createWorker({ fetchImpl });
  const status = await callMcp(worker, env, {
    jsonrpc: "2.0",
    id: 74,
    method: "tools/call",
    params: { name: "health_login_status", arguments: {} },
  });

  const value = JSON.parse(status.json.result.content[0].text);
  assert.deepEqual(value, {
    logged_in: true,
    method: "pass_token",
    user_id: "account-user",
    session_valid: true,
  });
  const stored = JSON.parse(await kv.get(TOKEN_KEY));
  assert.equal(stored.auth_method, "pass_token");
  assert.equal("pass_token" in stored, false);
  assert.doesNotMatch(JSON.stringify({ value, stored }), /synthetic-pass-token/);
  assert.equal(fetchImpl.accountCalls.length, 2);
});

test("health_login_refresh uses the configured browser deviceId without exposing credentials", async () => {
  const kv = new MemoryKv({
    [TOKEN_KEY]: JSON.stringify(tokenRecord({ auth_method: "qr" })),
  });
  const fetchImpl = passTokenSessionMock({
    expectedDeviceId: "wb_test_device",
    directLogin: true,
  });
  const env = envWithKv(kv, {
    XIAOMI_USER_ID: "synthetic-user",
    XIAOMI_PASS_TOKEN: "synthetic-pass-token",
    XIAOMI_DEVICE_ID: "wb_test_device",
  });
  const worker = createWorker({ fetchImpl });
  const refreshed = await callMcp(worker, env, {
    jsonrpc: "2.0",
    id: "refresh-login",
    method: "tools/call",
    params: { name: "health_login_refresh", arguments: {} },
  });

  const value = JSON.parse(refreshed.json.result.content[0].text);
  assert.deepEqual(value, {
    logged_in: true,
    method: "pass_token",
    user_id: "account-user",
    session_valid: true,
  });
  const stored = JSON.parse(await kv.get(TOKEN_KEY));
  assert.equal(stored.device_id, "wb_test_device");
  assert.equal(stored.auth_method, "pass_token");
  assert.equal("pass_token" in stored, false);
  assert.doesNotMatch(JSON.stringify({ value, stored }), /synthetic-pass-token/);
  assert.equal(fetchImpl.accountCalls.length, 1);
});

test("passToken session survives a Worker restart and serves self health data", async () => {
  const kv = new MemoryKv();
  const fetchImpl = passTokenSessionMock({
    healthRoute: (url, options, params) => {
      const values = {
        steps: { steps: 1 },
        sleep: { duration: 1 },
        heart_rate: { bpm: 60 },
      };
      return {
        code: 0,
        result: {
          data_list: [{ time: 1_787_558_400, value: JSON.stringify(values[params.key]) }],
          has_more: false,
        },
      };
    },
  });
  const env = envWithKv(kv, {
    XIAOMI_USER_ID: "synthetic-user",
    XIAOMI_PASS_TOKEN: "synthetic-pass-token",
  });
  const firstWorker = createWorker({ fetchImpl });
  await callMcp(firstWorker, env, {
    jsonrpc: "2.0",
    id: 75,
    method: "tools/call",
    params: { name: "health_login_status", arguments: {} },
  });

  const restartedWorker = createWorker({ fetchImpl });
  for (const name of ["health_steps", "health_sleep", "health_heart"]) {
    const result = await callMcp(restartedWorker, env, {
      jsonrpc: "2.0",
      id: name,
      method: "tools/call",
      params: { name, arguments: { target: "self", days: 1 } },
    });
    const value = JSON.parse(result.json.result.content[0].text);
    assert.equal(value.target, "self");
    assert.equal(value.data.length, 1);
  }
  assert.equal(fetchImpl.accountCalls.length, 2);
  assert.equal(fetchImpl.healthCalls.length, 3);
});

test("30-day self series stay compact and use each record's zone offset", async () => {
  const kv = new MemoryKv({ [TOKEN_KEY]: JSON.stringify(tokenRecord()) });
  const firstLocalMidnight = Date.UTC(2026, 6, 1) / 1000 - 8 * 60 * 60;
  const fetchImpl = encryptedApiMock({
    "/app/v1/data/get_fitness_data_by_time": (url, options, params) => {
      const data_list = [];
      for (let day = 0; day < 30; day += 1) {
        const dayStart = firstLocalMidnight + day * 86400;
        if (params.key === "steps") {
          for (let sample = 0; sample < 48; sample += 1) {
            data_list.push({
              time: dayStart + sample * 1800,
              zone_offset: 8 * 60 * 60,
              value: JSON.stringify({ steps: 100, distance: 70, calories: 4 }),
            });
          }
        } else if (params.key === "heart_rate") {
          for (let sample = 0; sample < 100; sample += 1) {
            data_list.push({
              time: dayStart + sample * 300,
              zone_offset: 8 * 60 * 60,
              value: JSON.stringify({ bpm: 60 + (sample % 21) }),
            });
          }
        } else {
          data_list.push(
            {
              time: dayStart + 8 * 3600,
              update_time: dayStart + 9 * 3600,
              zone_offset: 8 * 60 * 60,
              value: JSON.stringify({ duration: 40, is_nap: true, sleep_score: 70 }),
            },
            {
              time: dayStart + 7 * 3600,
              update_time: dayStart + 8 * 3600,
              zone_offset: 8 * 60 * 60,
              value: JSON.stringify({ duration: 450, is_nap: false, sleep_score: 85 }),
            },
          );
        }
      }
      return { code: 0, result: { data_list, has_more: false } };
    },
  });
  const worker = createWorker({ fetchImpl });

  for (const name of ["health_steps", "health_heart", "health_sleep"]) {
    const result = await callMcp(worker, envWithKv(kv), {
      jsonrpc: "2.0",
      id: name,
      method: "tools/call",
      params: { name, arguments: { target: "self", days: 30 } },
    });
    const text = result.json.result.content[0].text;
    const value = JSON.parse(text);
    assert.equal(value.data.length, 30);
    assert.equal(text, JSON.stringify(value));
    assert.ok(text.length < 20_000, `${name} result should remain compact`);
  }

  const steps = JSON.parse((await callMcp(worker, envWithKv(kv), {
    jsonrpc: "2.0",
    id: "steps-check",
    method: "tools/call",
    params: { name: "health_steps", arguments: { days: 30 } },
  })).json.result.content[0].text);
  assert.equal(steps.data[0].date, "2026-07-01");
  assert.equal(steps.data[0].steps, 4800);
  assert.equal(steps.data[0].distance, 3360);

  const heart = JSON.parse((await callMcp(worker, envWithKv(kv), {
    jsonrpc: "2.0",
    id: "heart-check",
    method: "tools/call",
    params: { name: "health_heart", arguments: { days: 30 } },
  })).json.result.content[0].text);
  assert.equal(heart.data[0].sample_count, 100);
  assert.equal(heart.data[0].min_hr, 60);
  assert.equal(heart.data[0].max_hr, 80);
  assert.equal(heart.data[0].avg_hr, 69.6);
  assert.equal(heart.data[0].latest_hr.bpm, 75);
  assert.equal("bpm_total" in heart.data[0], false);
});

test("sleep selects one main session per wake date deterministically", async () => {
  const kv = new MemoryKv({ [TOKEN_KEY]: JSON.stringify(tokenRecord()) });
  const zoneOffset = -5 * 60 * 60;
  const localMidnight = Date.UTC(2026, 7, 20) / 1000 - zoneOffset;
  const wakeUpTime = localMidnight + 7 * 3600;
  const fetchImpl = encryptedApiMock({
    "/app/v1/data/get_fitness_data_by_time": {
      code: 0,
      result: {
        data_list: [
          {
            time: localMidnight - 1800,
            update_time: localMidnight + 15 * 3600,
            zone_offset: zoneOffset,
            value: JSON.stringify({ duration: 60, is_nap: true, sleep_score: 95, wake_up_time: wakeUpTime }),
          },
          {
            time: localMidnight - 1800,
            update_time: localMidnight + 8 * 3600,
            zone_offset: zoneOffset,
            value: JSON.stringify({ duration: 420, is_nap: false, sleep_score: 80, wake_up_time: wakeUpTime }),
          },
          {
            time: localMidnight - 1800,
            update_time: localMidnight + 9 * 3600,
            zone_offset: zoneOffset,
            value: JSON.stringify({
              duration: 450,
              is_nap: false,
              sleep_score: 86,
              wake_up_time: wakeUpTime,
              passToken: "must-not-return-pass",
              cUserId: "must-not-return-c-user",
            }),
          },
          {
            time: localMidnight - 1800,
            update_time: localMidnight + 10 * 3600,
            zone_offset: zoneOffset,
            value: JSON.stringify({
              duration: 450,
              is_nap: false,
              sleep_score: 90,
              wake_up_time: wakeUpTime,
              serviceToken: "must-not-return-service",
              ssecurity: "must-not-return-security",
              Cookie: "must-not-return-cookie",
            }),
          },
        ],
        has_more: false,
      },
    },
  });
  const worker = createWorker({ fetchImpl });
  const result = await callMcp(worker, envWithKv(kv), {
    jsonrpc: "2.0",
    id: "sleep-dedup",
    method: "tools/call",
    params: { name: "health_sleep", arguments: { days: 1 } },
  });
  const text = result.json.result.content[0].text;
  const value = JSON.parse(text);
  assert.equal(value.data.length, 1);
  assert.equal(value.data[0].date, "2026-08-20");
  assert.equal(value.data[0].total_duration, 450);
  assert.equal(value.data[0].sleep_score, 90);
  assert.equal(value.data[0].wake_up_time, wakeUpTime);
  assert.doesNotMatch(text, /must-not-return/);
});

test("health_latest selects the newest sleep by actual time across time zones", async () => {
  const kv = new MemoryKv({ [TOKEN_KEY]: JSON.stringify(tokenRecord()) });
  const newerEpoch = Date.UTC(2026, 7, 21, 1) / 1000;
  const olderEpoch = Date.UTC(2026, 7, 20, 23) / 1000;
  const fetchImpl = encryptedApiMock({
    "/app/v1/data/get_fitness_data_by_time": (url, options, params) => ({
      code: 0,
      result: {
        data_list: params.key === "sleep"
          ? [
              {
                time: newerEpoch,
                zone_offset: -12 * 3600,
                value: JSON.stringify({ duration: 420, sleep_score: 90 }),
              },
              {
                time: olderEpoch,
                zone_offset: 14 * 3600,
                value: JSON.stringify({ duration: 430, sleep_score: 70 }),
              },
            ]
          : [],
        has_more: false,
      },
    }),
  });
  const worker = createWorker({ fetchImpl });
  const result = await callMcp(worker, envWithKv(kv), {
    jsonrpc: "2.0",
    id: "latest-timezone",
    method: "tools/call",
    params: { name: "health_latest", arguments: {} },
  });
  const value = JSON.parse(result.json.result.content[0].text);
  assert.equal(value.data.sleep.sleep_score, 90);
  assert.equal(value.data.sleep.time, newerEpoch);
});

test("relative series validates and sends only the requested relative_uid", async () => {
  const kv = new MemoryKv({ [TOKEN_KEY]: JSON.stringify(tokenRecord()) });
  const fetchImpl = encryptedApiMock({
    "/app/v1/relatives/get_relative_list": {
      code: 0,
      result: { relative_list: [{ relative_uid: 42, relative_note: "家人" }] },
    },
    "/app/v1/relatives/get_aggregated_data": (url, options, params) => {
      assert.equal(params.relative_uid, "42");
      assert.equal(params.tag, "daily_report");
      return {
        code: 0,
        result: {
          data_list: [
            {
              time: 1_787_558_400,
              update_time: 1_787_558_500,
              value: JSON.stringify({ steps: 456, cUserId: "must-not-return-c-user" }),
            },
            {
              time: 1_787_558_400,
              update_time: 1_787_558_600,
              value: JSON.stringify({ steps: 789, serviceToken: "must-not-return-service" }),
            },
          ],
        },
      };
    },
  });
  const worker = createWorker({ fetchImpl });
  const result = await callMcp(worker, envWithKv(kv), {
    jsonrpc: "2.0",
    id: "relative-uid",
    method: "tools/call",
    params: {
      name: "health_steps",
      arguments: { target: "relative", relative_uid: "42", days: 1 },
    },
  });
  assert.equal(result.json.result.isError, undefined);
  assert.equal(JSON.parse(result.json.result.content[0].text).data[0].steps, 789);
  assert.doesNotMatch(result.json.result.content[0].text, /must-not-return/);
});

test("login tool descriptions recommend passToken and disclose QR 70036", async () => {
  const worker = createWorker({ fetchImpl: async () => assert.fail("no network") });
  const listed = await callMcp(worker, envWithKv(), {
    jsonrpc: "2.0",
    id: "login-descriptions",
    method: "tools/list",
  });
  const tools = new Map(listed.json.result.tools.map((tool) => [tool.name, tool]));
  assert.match(tools.get("health_login_status").description, /推荐.*XIAOMI_USER_ID.*XIAOMI_PASS_TOKEN/);
  assert.match(tools.get("health_login_start").description, /70036/);
  assert.match(tools.get("health_login_poll").description, /70036/);
});

test("an expired health session is renewed from passToken secrets and retried", async () => {
  const kv = new MemoryKv({
    [TOKEN_KEY]: JSON.stringify(tokenRecord({ auth_state: "expired", auth_method: "pass_token" })),
  });
  const fetchImpl = passTokenSessionMock({
    healthRoute: {
      code: 0,
      result: {
        data_list: [{ time: 1_787_558_400, value: '{"steps":1234}' }],
        has_more: false,
      },
    },
  });
  const worker = createWorker({ fetchImpl });
  const result = await callMcp(worker, envWithKv(kv, {
    XIAOMI_USER_ID: "synthetic-user",
    XIAOMI_PASS_TOKEN: "synthetic-pass-token",
  }), {
    jsonrpc: "2.0",
    id: 76,
    method: "tools/call",
    params: { name: "health_steps", arguments: { target: "self", days: 1 } },
  });
  const value = JSON.parse(result.json.result.content[0].text);
  assert.equal(value.data[0].steps, 1234);
  assert.equal(fetchImpl.accountCalls.length, 2);
  assert.equal(JSON.parse(await kv.get(TOKEN_KEY)).auth_state, "valid");
});

test("an invalid passToken returns a safe login status error", async () => {
  const kv = new MemoryKv();
  const fetchImpl = passTokenSessionMock({ serviceLoginCode: 70036 });
  const worker = createWorker({ fetchImpl });
  const result = await callMcp(worker, envWithKv(kv, {
    XIAOMI_USER_ID: "synthetic-user",
    XIAOMI_PASS_TOKEN: "synthetic-pass-token",
  }), {
    jsonrpc: "2.0",
    id: 77,
    method: "tools/call",
    params: { name: "health_login_status", arguments: {} },
  });
  const value = JSON.parse(result.json.result.content[0].text);
  assert.equal(value.logged_in, false);
  assert.equal(value.method, "pass_token");
  assert.match(value.message, /passToken 无效或已过期/);
  assert.doesNotMatch(JSON.stringify(result.json), /synthetic-pass-token/);
});

test("a health API 401 refreshes the passToken session before retrying", async () => {
  const kv = new MemoryKv({
    [TOKEN_KEY]: JSON.stringify(tokenRecord({ auth_method: "pass_token" })),
  });
  let healthAttempts = 0;
  const fetchImpl = passTokenSessionMock({
    healthRoute: () => {
      healthAttempts += 1;
      if (healthAttempts === 1) return new Response("unauthorized", { status: 401 });
      return {
        code: 0,
        result: {
          data_list: [{ time: 1_787_558_400, value: '{"steps":1234}' }],
          has_more: false,
        },
      };
    },
  });
  const worker = createWorker({ fetchImpl });
  const result = await callMcp(worker, envWithKv(kv, {
    XIAOMI_USER_ID: "synthetic-user",
    XIAOMI_PASS_TOKEN: "synthetic-pass-token",
  }), {
    jsonrpc: "2.0",
    id: 78,
    method: "tools/call",
    params: { name: "health_steps", arguments: { target: "self", days: 1 } },
  });
  const value = JSON.parse(result.json.result.content[0].text);
  assert.equal(value.data[0].steps, 1234);
  assert.equal(fetchImpl.accountCalls.length, 2);
  assert.equal(healthAttempts, 2);
});

test("a health API region error is reported without exposing the Xiaomi response", async () => {
  const kv = new MemoryKv({ [TOKEN_KEY]: JSON.stringify(tokenRecord()) });
  const fetchImpl = encryptedApiMock({
    "/app/v1/data/get_fitness_data_by_time": {
      code: 40001,
      message: "region cn is unavailable for synthetic-account",
    },
  });
  const worker = createWorker({ fetchImpl });
  const result = await callMcp(worker, envWithKv(kv), {
    jsonrpc: "2.0",
    id: 79,
    method: "tools/call",
    params: { name: "health_steps", arguments: { target: "self", days: 1 } },
  });
  assert.equal(result.json.result.isError, true);
  assert.match(result.json.result.content[0].text, /地区不匹配/);
  assert.doesNotMatch(JSON.stringify(result.json), /synthetic-account/);
});

test("a Xiaomi 401 marks the stored credential expired", async () => {
  const kv = new MemoryKv({
    [TOKEN_KEY]: JSON.stringify(tokenRecord()),
  });
  const fetchImpl = async () => new Response("unauthorized", { status: 401 });
  const worker = createWorker({ fetchImpl });
  const result = await callMcp(worker, envWithKv(kv), {
    jsonrpc: "2.0",
    id: 8,
    method: "tools/call",
    params: { name: "health_latest", arguments: {} },
  });

  const stored = JSON.parse(await kv.get(TOKEN_KEY));
  assert.equal(stored.auth_state, "expired");
  assert.equal(result.json.result.isError, true);
  assert.match(result.json.result.content[0].text, /重新扫码登录/);
});

test("QR start and poll store refreshed credentials without returning them", async () => {
  const kv = new MemoryKv();
  const calls = [];
  const fetchImpl = async (input) => {
    const url = new URL(input);
    calls.push(url.toString());

    if (url.pathname === "/longPolling/loginUrl") {
      return new Response(
        `&&&START&&&${JSON.stringify({
          qr: "https://account.xiaomi.com/qr-image",
          loginUrl: "https://account.xiaomi.com/qr-login",
          lp: "https://account.xiaomi.com/long-poll-result",
          timeout: 300,
        })}`,
        {
          status: 200,
          headers: { "Set-Cookie": "sdkVersion=accountsdk-1; Path=/" },
        },
      );
    }
    if (url.pathname === "/long-poll-result") {
      return new Response(
        `&&&START&&&${JSON.stringify({
          ssecurity: SSECURITY,
          userId: "new-user",
          cUserId: "new-c-user-secret",
          passToken: "new-pass-secret",
          location: "https://sts.api.io.mi.com/login-complete?sid=miothealth",
        })}`,
        { status: 200 },
      );
    }
    if (url.pathname === "/login-complete") {
      return new Response(null, {
        status: 302,
        headers: {
          Location: "https://sts.api.io.mi.com/done",
          "Set-Cookie": "serviceToken=new-service-secret; Path=/; HttpOnly",
        },
      });
    }
    if (url.pathname === "/healthapp/sts") {
      return new Response("ok", { status: 200 });
    }
    throw new Error(`unexpected network request: ${url}`);
  };
  const worker = createWorker({ fetchImpl });
  const env = envWithKv(kv);

  const started = await callMcp(worker, env, {
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: { name: "health_login_start", arguments: {} },
  });
  const startValue = JSON.parse(started.json.result.content[0].text);
  assert.equal(startValue.status, "pending");
  assert.equal(startValue.loginUrl, "https://account.xiaomi.com/qr-login");
  assert.ok(await kv.get(LOGIN_SESSION_KEY));

  const polled = await callMcp(worker, env, {
    jsonrpc: "2.0",
    id: 10,
    method: "tools/call",
    params: { name: "health_login_poll", arguments: {} },
  });
  const pollValue = JSON.parse(polled.json.result.content[0].text);
  assert.equal(pollValue.status, "success");
  assert.equal(pollValue.user_id, "new-user");
  assert.equal(await kv.get(LOGIN_SESSION_KEY), null);

  const stored = JSON.parse(await kv.get(TOKEN_KEY));
  assert.equal(stored.service_token, "new-service-secret");
  assert.equal("pass_token" in stored, false);
  assert.equal(stored.auth_method, "qr");
  assert.equal(stored.auth_state, "valid");
  assert.doesNotMatch(
    JSON.stringify({ started: started.json, polled: polled.json }),
    /new-service-secret|new-pass-secret|new-c-user-secret/,
  );
  assert.equal(calls.some((url) => url.includes("/healthapp/sts")), true);
});

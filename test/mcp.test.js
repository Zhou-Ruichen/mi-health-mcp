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

function envWithKv(kv = new MemoryKv()) {
  return { AUTH_TOKEN, MI_HEALTH_KV: kv };
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

test("health_latest defaults to the signed-in account and uses the self data endpoint", async () => {
  const kv = new MemoryKv({
    [TOKEN_KEY]: JSON.stringify(tokenRecord()),
  });
  const fetchImpl = encryptedApiMock({
    "/app/v1/data/get_fitness_data_by_time": (url, options, params) => {
      assert.equal(options.method, "POST");
      assert.equal(params.key === "sleep" || params.key === "heart_rate" || params.key === "steps", true);
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
  assert.equal(value.data.heart_rate.bpm, 72);
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
      params: { name, arguments: { target: "self", days: 1 } },
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
  assert.equal(stored.pass_token, "new-pass-secret");
  assert.equal(stored.auth_state, "valid");
  assert.doesNotMatch(
    JSON.stringify({ started: started.json, polled: polled.json }),
    /new-service-secret|new-pass-secret|new-c-user-secret/,
  );
  assert.equal(calls.some((url) => url.includes("/healthapp/sts")), true);
});

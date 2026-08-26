import assert from "node:assert/strict";
import test from "node:test";

import {
  computeSignedNonce,
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
    calls.push({ url, options });
    const route = routes[url.pathname];
    if (!route) throw new Error(`unexpected network request: ${url}`);
    const payload = typeof route === "function" ? await route(url, options) : route;
    if (payload instanceof Response) return payload;

    const form =
      options.method === "POST"
        ? new URLSearchParams(options.body)
        : url.searchParams;
    const nonce = form.get("_nonce");
    assert.ok(nonce, "encrypted Xiaomi request includes _nonce");
    const signedNonce = await computeSignedNonce(SSECURITY, nonce);
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

test("health_latest resolves the first relative and returns only available metrics", async () => {
  const kv = new MemoryKv({
    [TOKEN_KEY]: JSON.stringify(tokenRecord()),
  });
  const fetchImpl = encryptedApiMock({
    "/app/v1/relatives/get_relative_list": {
      code: 0,
      result: {
        relative_list: [
          { relative_uid: 42, relative_note: "first" },
          { relative_uid: 99, relative_note: "second" },
        ],
      },
    },
    "/app/v1/relatives/get_latest_data": {
      code: 0,
      result: {
        latest_data_time: 1_787_558_400,
        data_list: [
          {
            key: "sleep",
            time: 1_787_500_800,
            value: JSON.stringify({ total_duration: 455, sleep_score: 86 }),
          },
          {
            key: "heart_rate",
            time: 1_787_558_300,
            value: JSON.stringify({ bpm: 72 }),
          },
          {
            key: "weight",
            time: 1_787_550_000,
            value: "{\"weight\":52.3}",
          },
        ],
      },
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

  assert.equal(value.relative_uid, 42);
  assert.equal(value.data.sleep.total_duration, 455);
  assert.equal(value.data.heart_rate.bpm, 72);
  assert.equal("steps" in value.data, false);
  assert.equal("weight" in value.data, false);
  assert.equal(fetchImpl.calls.length, 2);
  assert.doesNotMatch(JSON.stringify(result.json), /service-token-secret/);
});

test("daily series defaults to seven days, accepts empty data, and rejects over 30", async () => {
  const kv = new MemoryKv({
    [TOKEN_KEY]: JSON.stringify(tokenRecord()),
  });
  const fetchImpl = encryptedApiMock({
    "/app/v1/relatives/get_relative_list": {
      code: 0,
      result: { relative_list: [{ relative_uid: 42 }] },
    },
    "/app/v1/relatives/get_aggregated_data": {
      code: 0,
      result: { data_list: [] },
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

test("an empty relative list returns the required explicit error", async () => {
  const kv = new MemoryKv({
    [TOKEN_KEY]: JSON.stringify(tokenRecord()),
  });
  const fetchImpl = encryptedApiMock({
    "/app/v1/relatives/get_relative_list": {
      code: 0,
      result: { relative_list: [] },
    },
  });
  const worker = createWorker({ fetchImpl });
  const result = await callMcp(worker, envWithKv(kv), {
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "health_latest", arguments: {} },
  });

  assert.equal(result.json.result.isError, true);
  assert.match(result.json.result.content[0].text, /亲友列表为空/);
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

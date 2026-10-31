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

function envWithKv(kv, overrides = {}) {
  return { AUTH_TOKEN, MI_HEALTH_KV: kv, ...overrides };
}

function tokenRecord(overrides = {}) {
  return {
    user_id: "account-user",
    c_user_id: "c-user-secret",
    service_token: "service-token-secret",
    ssecurity: SSECURITY,
    device_id: "an_test",
    auth_state: "valid",
    updated_at: "2026-08-24T08:00:00.000Z",
    last_checked_at: null,
    last_error: null,
    ...overrides,
  };
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
    const ciphertext = await encryptData(signedNonce, JSON.stringify(payload));
    return new Response(ciphertext, { status: 200 });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function passTokenSessionMock({ serviceLoginCode = 0 } = {}) {
  const healthFetch = encryptedApiMock({
    "/app/v1/data/get_fitness_data_by_time": {
      code: 0,
      result: { data_list: [], has_more: false },
    },
  });
  let accountCalls = 0;
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    if (url.hostname === "account.xiaomi.com" && url.pathname === "/pass/serviceLogin") {
      accountCalls += 1;
      return new Response(
        `&&&START&&&${JSON.stringify({
          code: serviceLoginCode,
          ...(serviceLoginCode === 0
            ? {
                userId: "account-user",
                cUserId: "c-user-secret",
                ssecurity: SSECURITY,
                location: "https://sts.api.io.mi.com/login-complete?sid=miothealth",
              }
            : {}),
        })}`,
        { status: 200 },
      );
    }
    if (url.hostname === "sts.api.io.mi.com" && url.pathname === "/login-complete") {
      return new Response(null, {
        status: 302,
        headers: { "Set-Cookie": "serviceToken=service-token-secret; Path=/; HttpOnly" },
      });
    }
    return healthFetch(input, options);
  };
  fetchImpl.accountCallCount = () => accountCalls;
  fetchImpl.healthCalls = healthFetch.calls;
  return fetchImpl;
}

async function loginStatus(worker, env, id) {
  const result = await worker.fetch(
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
        params: { name: "health_login_status", arguments: {} },
      }),
    }),
    env,
  );
  const json = await result.json();
  return JSON.parse(json.result.content[0].text);
}

async function callTool(worker, env, name, args, id) {
  const result = await worker.fetch(
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
  );
  const json = await result.json();
  return JSON.parse(json.result.content[0].text);
}

function hoursAgo(hours, now = Date.now()) {
  return new Date(now - hours * 3_600_000).toISOString();
}

test("fresh last_verified_at reports session_state=verified", async () => {
  const kv = new MemoryKv({
    [TOKEN_KEY]: JSON.stringify(
      tokenRecord({ last_verified_at: hoursAgo(1) }),
    ),
  });
  const worker = createWorker({ fetchImpl: async () => assert.fail("no network") });
  const value = await loginStatus(worker, envWithKv(kv), 1);
  assert.equal(value.logged_in, true);
  assert.equal(value.session_state, "verified");
  assert.equal(value.session_valid, true);
  assert.equal(value.method, "qr");
});

test("stale or missing last_verified_at reports session_state=cached with session_valid=true", async () => {
  const worker = createWorker({ fetchImpl: async () => assert.fail("no network") });
  const verifiedAt = hoursAgo(25);
  const stale = await loginStatus(
    worker,
    envWithKv(new MemoryKv({
      [TOKEN_KEY]: JSON.stringify(
        tokenRecord({ last_verified_at: verifiedAt }),
      ),
    })),
    2,
  );
  assert.equal(stale.session_state, "cached");
  assert.equal(stale.session_valid, true);
  assert.equal(stale.last_verified_at, verifiedAt);

  const absent = await loginStatus(
    worker,
    envWithKv(new MemoryKv({ [TOKEN_KEY]: JSON.stringify(tokenRecord()) })),
    3,
  );
  assert.equal(absent.session_state, "cached");
  assert.equal(absent.session_valid, true);
  assert.equal(absent.last_verified_at, null);
});

test("auth_state=expired reports session_state=expired", async () => {
  const kv = new MemoryKv({
    [TOKEN_KEY]: JSON.stringify(
      tokenRecord({ auth_state: "expired", last_verified_at: hoursAgo(30) }),
    ),
  });
  const worker = createWorker({ fetchImpl: async () => assert.fail("no network") });
  const value = await loginStatus(worker, envWithKv(kv), 4);
  assert.equal(value.logged_in, false);
  assert.equal(value.session_state, "expired");
  assert.equal(value.session_valid, false);
});

test("no cache and no passToken secrets reports session_state=missing", async () => {
  const worker = createWorker({ fetchImpl: async () => assert.fail("no network") });
  const value = await loginStatus(worker, envWithKv(new MemoryKv()), 5);
  assert.equal(value.logged_in, false);
  assert.equal(value.session_state, "missing");
  assert.equal(value.session_valid, false);
});

test("configured passToken with successful exchange reports verified and persists last_verified_at", async () => {
  const kv = new MemoryKv();
  const fetchImpl = passTokenSessionMock();
  const env = envWithKv(kv, {
    XIAOMI_USER_ID: "synthetic-user",
    XIAOMI_PASS_TOKEN: "synthetic-pass-token",
  });
  const worker = createWorker({ fetchImpl });
  const before = Date.now();
  const value = await loginStatus(worker, env, 6);
  assert.equal(value.logged_in, true);
  assert.equal(value.method, "pass_token");
  assert.equal(value.session_state, "verified");
  assert.equal(value.session_valid, true);
  const verifiedMs = Date.parse(value.last_verified_at);
  assert.ok(verifiedMs >= before - 1000 && verifiedMs <= Date.now() + 1000);
  const stored = JSON.parse(await kv.get(TOKEN_KEY));
  assert.equal(stored.last_verified_at, value.last_verified_at);
});

test("a successful upstream data call writes last_verified_at into KV", async () => {
  const kv = new MemoryKv({
    [TOKEN_KEY]: JSON.stringify(tokenRecord({ last_verified_at: null })),
  });
  const fetchImpl = encryptedApiMock({
    "/app/v1/data/get_fitness_data_by_time": {
      code: 0,
      result: { data_list: [{ time: 1_787_558_400, value: '{"steps":1234}' }], has_more: false },
    },
  });
  const worker = createWorker({ fetchImpl });
  const value = await callTool(
    worker,
    envWithKv(kv),
    "health_steps",
    { target: "self", days: 1 },
    7,
  );
  assert.equal(value.target, "self");
  const stored = JSON.parse(await kv.get(TOKEN_KEY));
  const verifiedMs = Date.parse(stored.last_verified_at);
  assert.ok(Number.isFinite(verifiedMs) && verifiedMs <= Date.now() + 1000);
  assert.equal(stored.auth_state, "valid");
  assert.equal("pass_token" in stored, false);

  // 随后 health_login_status 基于刚写入的时间报告 verified，且缓存命中不打上游。
  const status = await loginStatus(worker, envWithKv(kv), 8);
  assert.equal(status.session_state, "verified");
});

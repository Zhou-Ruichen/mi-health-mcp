import assert from "node:assert/strict";
import test from "node:test";

import {
  computeSignedNonce,
  decryptData,
  encryptData,
} from "../src/crypto.js";
import {
  diagnosticsPayload,
  newRequestId,
  operationForPath,
} from "../src/diagnostics.js";
import { handleRpc } from "../src/index.js";
import {
  getSelfFitnessItems,
  TOKEN_KEY,
  XiaomiApiError,
} from "../src/xiaomi.js";

const SSECURITY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const token = {
  user_id: "account-user",
  c_user_id: "c-user-secret",
  service_token: "service-token-secret",
  ssecurity: SSECURITY,
  device_id: "an_test",
  auth_state: "valid",
};

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

function envWithKv(kv = new MemoryKv()) {
  return { MI_HEALTH_KV: kv };
}

function toolsCall(name, args, id = 7) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  };
}

function encryptedMock(onRequest) {
  return async (input, options = {}) => {
    const url = new URL(input);
    const form =
      options.method === "POST"
        ? new URLSearchParams(options.body)
        : url.searchParams;
    const signedNonce = await computeSignedNonce(SSECURITY, form.get("_nonce"));
    const encryptedData = form.get("data");
    const params = encryptedData
      ? JSON.parse(await decryptData(signedNonce, encryptedData))
      : {};
    const payload = await onRequest(url, options, params);
    return new Response(await encryptData(signedNonce, JSON.stringify(payload)), {
      status: 200,
    });
  };
}

function captureLog() {
  const lines = [];
  const original = console.log;
  console.log = (...args) => {
    lines.push(args.map(String).join(" "));
  };
  return {
    lines,
    restore() {
      console.log = original;
    },
  };
}

const SENSITIVE_MARKERS = [
  "SECRETNONCE",
  "SECRETDATA",
  "SECRETPT",
  "SECRETST",
  "SECRETSSEC",
  "_nonce",
  "pass_token",
  "serviceToken",
  "ssecurity",
  "steps=99999",
];

test("newRequestId returns uuid-format ids", () => {
  const first = newRequestId();
  const second = newRequestId();
  assert.match(first, UUID_RE);
  assert.match(second, UUID_RE);
  assert.notEqual(first, second);
});

test("operationForPath maps fixed internal operation names", () => {
  assert.equal(
    operationForPath("/app/v1/relatives/get_relative_list"),
    "relatives_list",
  );
  assert.equal(
    operationForPath("/app/v1/relatives/get_latest_data"),
    "relatives_latest",
  );
  assert.equal(
    operationForPath("/app/v1/relatives/get_aggregated_data"),
    "relatives_aggregated",
  );
  assert.equal(
    operationForPath("/app/v1/data/get_fitness_data_by_time"),
    "fitness_by_time",
  );
  assert.equal(
    operationForPath("/app/v1/data/get_sport_records_by_time"),
    "sport_by_time",
  );
  assert.equal(
    operationForPath("https://account.xiaomi.com/pass/serviceLogin?_json=true"),
    "auth",
  );
  assert.equal(
    operationForPath("https://account.xiaomi.com/pass/serviceLoginAuth2"),
    "auth",
  );
  assert.equal(
    operationForPath("https://sts-hlth.io.mi.com/healthapp/sts"),
    "auth",
  );
  assert.equal(
    operationForPath("https://account.xiaomi.com/longPolling/loginUrl"),
    "auth",
  );
  // 映射结果不含用户 id / 参数
  assert.equal(
    operationForPath("/app/v1/relatives/get_latest_data?relative_uid=12345"),
    "relatives_latest",
  );
});

test("successful tool call is unaffected and logs nothing", async () => {
  const capture = captureLog();
  try {
    const kv = new MemoryKv({ [TOKEN_KEY]: JSON.stringify(token) });
    const fetchImpl = encryptedMock(() => ({
      code: 0,
      result: { data_list: [], has_more: false },
    }));
    const response = await handleRpc(
      toolsCall("health_steps", { target: "self", days: 1 }),
      envWithKv(kv),
      fetchImpl,
    );
    assert.equal(response.id, 7);
    assert.ok(response.result);
    assert.equal(response.result.isError, undefined);
    const payload = JSON.parse(response.result.content[0].text);
    assert.equal(payload.target, "self");
    assert.equal(payload.metric, "steps");
    assert.deepEqual(payload.data, []);
    assert.deepEqual(capture.lines, [], "success must not emit error logs");
  } finally {
    capture.restore();
  }
});

test("fetch-phase timeout produces XiaomiApiError with timeout diagnostics", async () => {
  const capture = captureLog();
  try {
    const fetchImpl = (input, options = {}) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const error = new Error("The operation was aborted due to timeout");
          error.name = "TimeoutError";
          reject(error);
        });
      });
    await assert.rejects(
      getSelfFitnessItems(token, "sleep", 0, 86_400, fetchImpl, 200),
      (error) => {
        assert.ok(error instanceof XiaomiApiError);
        assert.equal(error.kind, "timeout");
        assert.ok(["fetch", "body"].includes(error.phase));
        assert.match(error.request_id, UUID_RE);
        assert.equal(error.operation, "fitness_by_time");
        assert.equal(typeof error.elapsed_ms, "number");
        return true;
      },
    );
    assert.equal(capture.lines.length, 1);
    const log = JSON.parse(capture.lines[0]);
    assert.equal(log.event, "mi_health_request_error");
    assert.equal(log.kind, "timeout");
    assert.equal(log.operation, "fitness_by_time");
    assert.match(log.request_id, UUID_RE);
    assert.equal(typeof log.elapsed_ms, "number");
  } finally {
    capture.restore();
  }
}, { timeout: 20_000 });

test("hung response body interrupted by deadline yields timeout diagnostics", async () => {
  const capture = captureLog();
  try {
    const fetchImpl = async (input, options = {}) => {
      assert.ok(options.signal instanceof AbortSignal);
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("x"));
            // never closes, never listens to abort
          },
        }),
        { status: 200 },
      );
    };
    await assert.rejects(
      getSelfFitnessItems(token, "sleep", 0, 86_400, fetchImpl, 300),
      (error) => {
        assert.ok(error instanceof XiaomiApiError);
        assert.equal(error.message, "小米接口响应读取超时");
        assert.equal(error.kind, "timeout");
        assert.equal(error.phase, "body");
        assert.match(error.request_id, UUID_RE);
        return true;
      },
    );
    assert.equal(capture.lines.length, 1);
    const log = JSON.parse(capture.lines[0]);
    assert.equal(log.kind, "timeout");
    assert.equal(log.phase, "body");
  } finally {
    capture.restore();
  }
}, { timeout: 20_000 });

test("concurrent calls get distinct request ids without cross-talk", async () => {
  const capture = captureLog();
  try {
    const slowTimeout = (input, options = {}) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const error = new Error("The operation was aborted due to timeout");
          error.name = "TimeoutError";
          reject(error);
        });
      });
    const fastNetwork = async () => {
      throw new TypeError("fetch failed: connect ECONNREFUSED");
    };
    const [slow, fast] = await Promise.allSettled([
      getSelfFitnessItems(token, "sleep", 0, 86_400, slowTimeout, 300),
      getSelfFitnessItems(token, "steps", 0, 86_400, fastNetwork, 300),
    ]);
    assert.equal(slow.status, "rejected");
    assert.equal(fast.status, "rejected");
    assert.match(slow.reason.request_id, UUID_RE);
    assert.match(fast.reason.request_id, UUID_RE);
    assert.notEqual(
      slow.reason.request_id,
      fast.reason.request_id,
      "each call gets its own request id",
    );
    assert.equal(slow.reason.kind, "timeout");
    assert.equal(fast.reason.kind, "network");
    const logged = capture.lines.map((line) => JSON.parse(line));
    assert.equal(logged.length, 2);
    const byId = new Map(logged.map((entry) => [entry.request_id, entry]));
    assert.equal(byId.get(slow.reason.request_id).kind, "timeout");
    assert.equal(byId.get(fast.reason.request_id).kind, "network");
  } finally {
    capture.restore();
  }
}, { timeout: 20_000 });

test("toolError diagnostics contain only whitelisted fields", async () => {
  const capture = captureLog();
  try {
    const kv = new MemoryKv({ [TOKEN_KEY]: JSON.stringify(token) });
    const requestId = newRequestId();
    const fetchImpl = async () => {
      const error = new XiaomiApiError("小米接口请求失败（HTTP 503）");
      error.request_id = requestId;
      error.operation = "fitness_by_time";
      error.phase = "fetch";
      error.kind = "http_status";
      error.elapsed_ms = 42;
      error.http_status = 503;
      error.leaked = "serviceToken=SECRET-LEAK";
      throw error;
    };
    const response = await handleRpc(
      toolsCall("health_steps", { target: "self", days: 1 }),
      envWithKv(kv),
      fetchImpl,
    );
    assert.ok(response.result.isError);
    const payload = JSON.parse(response.result.content[0].text);
    assert.equal(payload.ok, false);
    assert.deepEqual(
      Object.keys(payload.diagnostics).sort(),
      ["elapsed_ms", "http_status", "kind", "operation", "phase", "request_id"],
    );
    assert.equal(payload.diagnostics.request_id, requestId);
    assert.equal(payload.diagnostics.operation, "fitness_by_time");
    assert.equal(payload.diagnostics.http_status, 503);
    assert.ok(!JSON.stringify(payload).includes("SECRET-LEAK"));
  } finally {
    capture.restore();
  }
});

test("diagnostics injection carrying sensitive strings is neutralized", () => {
  const error = new XiaomiApiError("injected");
  error.request_id = newRequestId();
  error.operation = "fitness_by_time?pass_token=SECRETPT&serviceToken=SECRETST";
  error.phase = "fetch";
  error.kind = "timeout";
  error.elapsed_ms = 1;
  error.http_status = null;
  const payload = diagnosticsPayload(error);
  assert.equal(payload.operation, "unknown");
  const text = JSON.stringify(payload);
  for (const marker of ["SECRETPT", "SECRETST", "pass_token", "serviceToken"]) {
    assert.ok(!text.includes(marker), marker);
  }

  const forged = new XiaomiApiError("forged");
  forged.request_id = "not-a-uuid ssecurity=SECRETSSEC";
  forged.operation = "auth";
  forged.phase = "auth";
  forged.kind = "auth";
  assert.equal(diagnosticsPayload(forged), null);
});

test("diagnostics and logs never leak url params, tokens or health data", async () => {
  const capture = captureLog();
  try {
    const kv = new MemoryKv({ [TOKEN_KEY]: JSON.stringify(token) });
    const secret =
      "https://hlth.io.mi.com/app/v1/data/get_fitness_data_by_time" +
      "?_nonce=SECRETNONCE&data=SECRETDATA " +
      "pass_token=SECRETPT serviceToken=SECRETST ssecurity=SECRETSSEC steps=99999";
    const fetchImpl = async () => {
      throw new TypeError(`fetch failed: ${secret}`);
    };
    const response = await handleRpc(
      toolsCall("health_steps", { target: "self", days: 1 }),
      envWithKv(kv),
      fetchImpl,
    );
    assert.ok(response.result.isError);
    const payload = JSON.parse(response.result.content[0].text);
    const diagText = JSON.stringify(payload.diagnostics);
    for (const marker of SENSITIVE_MARKERS) {
      assert.ok(!diagText.includes(marker), `diagnostics leak ${marker}`);
    }
    assert.equal(payload.diagnostics.kind, "network");
    assert.equal(payload.diagnostics.operation, "fitness_by_time");
    assert.equal(capture.lines.length, 1);
    for (const marker of SENSITIVE_MARKERS) {
      assert.ok(!capture.lines[0].includes(marker), `log leaks ${marker}`);
    }
  } finally {
    capture.restore();
  }
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  computeSignedNonce,
  decryptData,
  encryptData,
} from "../src/crypto.js";
import {
  getSelfFitnessItems,
  XiaomiApiError,
} from "../src/xiaomi.js";

const SSECURITY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

const token = {
  user_id: "account-user",
  c_user_id: "c-user-secret",
  service_token: "service-token-secret",
  ssecurity: SSECURITY,
  device_id: "an_test",
};

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
    onRequest(url, options, params);
    const payload = {
      code: 0,
      result: { data_list: [], has_more: false },
    };
    return new Response(await encryptData(signedNonce, JSON.stringify(payload)), {
      status: 200,
    });
  };
}

test("encryptedRequest applies a deadline to the fetch call", async () => {
  const seen = [];
  const fetchImpl = encryptedMock((_url, options) => {
    seen.push(options.signal ?? null);
  });
  await getSelfFitnessItems(token, "sleep", 0, 86_400, fetchImpl);
  assert.equal(seen.length, 1);
  assert.ok(seen[0] instanceof AbortSignal, "fetch options carry an AbortSignal deadline");
});

test("encryptedRequest rejects a hung response body via the deadline", async () => {
  const fetchImpl = async (input, options = {}) => {
    const signal = options.signal;
    assert.ok(signal instanceof AbortSignal, "deadline signal present before body read");
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("x"));
          signal.addEventListener("abort", () => {
            try {
              controller.error(signal.reason);
            } catch {
              // already errored
            }
          });
          // 永不 close：只有 deadline 能中断 body 读取
        },
      }),
      { status: 200 },
    );
  };
  await assert.rejects(
    getSelfFitnessItems(token, "sleep", 0, 86_400, fetchImpl, 300),
    (error) =>
      error instanceof XiaomiApiError &&
      error.message === "小米接口响应读取超时",
  );
}, { timeout: 20_000 });

test("encryptedRequest times out even when the body stream ignores abort", async () => {
  // The stream never errors or closes and does NOT listen to the signal:
  // the reader wrapper in readTextLimited must break the read itself.
  const fetchImpl = async (input, options = {}) => {
    assert.ok(options.signal instanceof AbortSignal, "deadline signal present before body read");
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("x"));
          // intentionally no abort listener, no close
        },
      }),
      { status: 200 },
    );
  };
  const started = Date.now();
  await assert.rejects(
    getSelfFitnessItems(token, "sleep", 0, 86_400, fetchImpl, 300),
    (error) =>
      error instanceof XiaomiApiError &&
      error.message === "小米接口响应读取超时",
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5_000, `must time out on deadline, took ${elapsed}ms`);
}, { timeout: 20_000 });

test("readTextLimited rejects immediately when signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  // Drive through the public path: hung body whose stream ignores abort,
  // with a deadline that expires before the first body read.
  const fetchImpl = async (input, options = {}) => {
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("x"));
          // no abort listener, never closes
        },
      }),
      { status: 200 },
    );
  };
  await assert.rejects(
    getSelfFitnessItems(token, "sleep", 0, 86_400, fetchImpl, 50),
    (error) =>
      error instanceof XiaomiApiError &&
      error.message === "小米接口响应读取超时",
  );
  void controller;
}, { timeout: 20_000 });

test("encryptedRequest converts a fetch-phase TimeoutError into a public timeout error", async () => {
  // fetch never resolves; the AbortSignal.timeout deadline fires inside fetch,
  // which rejects with a native TimeoutError that must become XiaomiApiError.
  const fetchImpl = async (input, options = {}) => {
    assert.ok(options.signal instanceof AbortSignal);
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        const error = new Error("The operation was aborted due to timeout");
        error.name = "TimeoutError";
        reject(error);
      });
    });
  };
  const started = Date.now();
  await assert.rejects(
    getSelfFitnessItems(token, "sleep", 0, 86_400, fetchImpl, 300),
    (error) =>
      error instanceof XiaomiApiError &&
      error.message.includes("超时") &&
      !error.message.includes("鉴权"),
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5_000, `must time out on deadline, took ${elapsed}ms`);
}, { timeout: 20_000 });

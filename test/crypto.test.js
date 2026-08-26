import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEncryptedParams,
  computeSignedNonce,
  generateNonce,
  rc4Crypt,
  timingSafeTextEqual,
} from "../src/crypto.js";

const encoder = new TextEncoder();

function hex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

test("RC4 matches the published standard vector", () => {
  const encrypted = rc4Crypt(
    encoder.encode("Key"),
    encoder.encode("Plaintext"),
    { skip: 0 },
  );
  assert.equal(hex(encrypted), "bbf316e8d940af0ad3");
});

test("nonce and signed nonce match an independent Python fixture", async () => {
  const nonce = generateNonce({
    now: 1_234_567_890_000,
    randomBytes: Uint8Array.from({ length: 8 }, (_, index) => index + 8),
  });
  assert.equal(nonce, "CAkKCwwNDg8BOfeD");

  const signed = await computeSignedNonce(
    "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
    nonce,
  );
  assert.equal(signed, "+o/HS3inzona74UNQJOtkVNj0P+Zasg/MEPJlrA2N98=");
});

test("encrypted request params match the reference implementation", async () => {
  const actual = await buildEncryptedParams(
    "GET",
    "/app/v1/test",
    "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
    { relative_uid: 123, key: "sleep" },
    { nonce: "CAkKCwwNDg8BOfeD" },
  );

  assert.deepEqual(actual, {
    data: "jNmc1JTcI0GWG2BctjcEZJOxLB7Yh8KvnmelWbZeaaHC5w==",
    rc4_hash__: "KlWvmXll+uCtldDo8P36ywP+JLFOYJIREvBbAA==",
    signature: "4HJ85gllqfZZBDcVuzrinTwAfWw=",
    _nonce: "CAkKCwwNDg8BOfeD",
  });
});

test("secret comparison accepts only the same text", async () => {
  assert.equal(await timingSafeTextEqual("same-token", "same-token"), true);
  assert.equal(await timingSafeTextEqual("wrong", "same-token"), false);
});

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export function base64ToBytes(value) {
  const binary = atob(String(value).replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function rc4Crypt(key, data, { skip = 1024 } = {}) {
  if (!(key instanceof Uint8Array) || key.length === 0) {
    throw new TypeError("RC4 key must be a non-empty Uint8Array");
  }
  if (!(data instanceof Uint8Array)) {
    throw new TypeError("RC4 data must be a Uint8Array");
  }

  const state = new Uint8Array(256);
  for (let index = 0; index < 256; index += 1) state[index] = index;

  let j = 0;
  for (let index = 0; index < 256; index += 1) {
    j = (j + state[index] + key[index % key.length]) & 0xff;
    [state[index], state[j]] = [state[j], state[index]];
  }

  let i = 0;
  j = 0;
  const nextByte = () => {
    i = (i + 1) & 0xff;
    j = (j + state[i]) & 0xff;
    [state[i], state[j]] = [state[j], state[i]];
    return state[(state[i] + state[j]) & 0xff];
  };

  for (let index = 0; index < skip; index += 1) nextByte();

  const result = new Uint8Array(data.length);
  for (let index = 0; index < data.length; index += 1) {
    result[index] = data[index] ^ nextByte();
  }
  return result;
}

async function digestBytes(algorithm, data) {
  return new Uint8Array(await globalThis.crypto.subtle.digest(algorithm, data));
}

async function sha1Base64(message) {
  return bytesToBase64(await digestBytes("SHA-1", encoder.encode(message)));
}

export function generateNonce({
  now = Date.now(),
  randomBytes,
} = {}) {
  const random = randomBytes
    ? new Uint8Array(randomBytes)
    : globalThis.crypto.getRandomValues(new Uint8Array(8));
  if (random.length !== 8) throw new TypeError("nonce random part must be 8 bytes");

  const nonce = new Uint8Array(12);
  nonce.set(random, 0);
  new DataView(nonce.buffer).setUint32(8, Math.floor(now / 60000), false);
  return bytesToBase64(nonce);
}

export async function computeSignedNonce(ssecurity, nonce) {
  const securityBytes = base64ToBytes(ssecurity);
  const nonceBytes = base64ToBytes(nonce);
  const material = new Uint8Array(securityBytes.length + nonceBytes.length);
  material.set(securityBytes, 0);
  material.set(nonceBytes, securityBytes.length);
  return bytesToBase64(await digestBytes("SHA-256", material));
}

function buildSignatureMessage(method, path, params, signedNonce) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const parts = [String(method).toUpperCase(), normalizedPath];
  for (const key of Object.keys(params).sort()) {
    parts.push(`${key}=${params[key]}`);
  }
  parts.push(signedNonce);
  return parts.join("&");
}

function encryptSortedValues(key, entries) {
  const encoded = entries.map(([, value]) => encoder.encode(value));
  const totalLength = encoded.reduce((total, bytes) => total + bytes.length, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const bytes of encoded) {
    combined.set(bytes, offset);
    offset += bytes.length;
  }

  const encrypted = rc4Crypt(key, combined);
  const result = {};
  offset = 0;
  entries.forEach(([name], index) => {
    const length = encoded[index].length;
    result[name] = bytesToBase64(encrypted.subarray(offset, offset + length));
    offset += length;
  });
  return result;
}

export async function buildEncryptedParams(
  method,
  path,
  ssecurity,
  params,
  { nonce = generateNonce() } = {},
) {
  const signedNonce = await computeSignedNonce(ssecurity, nonce);
  const raw = {};
  if (params && Object.keys(params).length > 0) {
    raw.data = JSON.stringify(params);
  }

  raw.rc4_hash__ = await sha1Base64(
    buildSignatureMessage(method, path, raw, signedNonce),
  );

  const encrypted = encryptSortedValues(
    base64ToBytes(signedNonce),
    Object.entries(raw).sort(([left], [right]) => left.localeCompare(right)),
  );
  const signature = await sha1Base64(
    buildSignatureMessage(method, path, encrypted, signedNonce),
  );

  return { ...encrypted, signature, _nonce: nonce };
}

export async function encryptData(signedNonce, plaintext) {
  const encrypted = rc4Crypt(
    base64ToBytes(signedNonce),
    encoder.encode(plaintext),
  );
  return bytesToBase64(encrypted);
}

export async function decryptData(signedNonce, ciphertext) {
  const plaintext = rc4Crypt(
    base64ToBytes(signedNonce),
    base64ToBytes(ciphertext),
  );
  return decoder.decode(plaintext);
}

export async function decryptResponse(ssecurity, nonce, ciphertext) {
  const signedNonce = await computeSignedNonce(ssecurity, nonce);
  const plaintext = await decryptData(signedNonce, ciphertext);
  try {
    return JSON.parse(plaintext);
  } catch {
    return plaintext;
  }
}

export async function timingSafeTextEqual(provided, expected) {
  const [providedHash, expectedHash] = await Promise.all([
    digestBytes("SHA-256", encoder.encode(String(provided))),
    digestBytes("SHA-256", encoder.encode(String(expected))),
  ]);

  if (typeof globalThis.crypto.subtle.timingSafeEqual === "function") {
    return globalThis.crypto.subtle.timingSafeEqual(providedHash, expectedHash);
  }

  let difference = 0;
  for (let index = 0; index < providedHash.length; index += 1) {
    difference |= providedHash[index] ^ expectedHash[index];
  }
  return difference === 0;
}

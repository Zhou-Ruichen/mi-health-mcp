import {
  buildEncryptedParams,
  bytesToBase64,
  decryptResponse,
} from "./crypto.js";

export const TOKEN_KEY = "mi_fitness_token";
export const LOGIN_SESSION_KEY = "mi_fitness_login_session";

const XIAOMI_QR_LOGIN_URL = "https://account.xiaomi.com/longPolling/loginUrl";
const XIAOMI_SERVICE_LOGIN_URL = "https://account.xiaomi.com/pass/serviceLogin";
const STS_HEALTH_URL = "https://sts-hlth.io.mi.com/healthapp/sts";
const HEALTH_API_BASE = "https://hlth.io.mi.com";
const SERVICE_SID = "miothealth";

const RELATIVES_LIST_PATH = "/app/v1/relatives/get_relative_list";
const RELATIVES_LATEST_PATH = "/app/v1/relatives/get_latest_data";
const RELATIVES_AGGREGATED_PATH = "/app/v1/relatives/get_aggregated_data";
const SELF_FITNESS_BY_TIME_PATH = "/app/v1/data/get_fitness_data_by_time";

const API_USER_AGENT = "Android-12-3.53.1-vivo-V2284A";
const LOGIN_USER_AGENT =
  "Dalvik/2.1.0 (Linux; U; Android 12; V2284A Build/ab8c0d1.1) " +
  "APP/mi.health APPV/353001 MK/VjIyODRB " +
  "SDKV/5.3.0.release.68 CPN/com.mi.health PassportSDK/";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const CST_OFFSET_SECONDS = 8 * 60 * 60;

export class XiaomiError extends Error {}

export class XiaomiAuthError extends XiaomiError {
  constructor(message, { authExpired = true } = {}) {
    super(message);
    this.authExpired = authExpired;
  }
}

export class XiaomiApiError extends XiaomiError {
  constructor(message, { code = null, authExpired = false } = {}) {
    super(message);
    this.code = code;
    this.authExpired = authExpired;
  }
}

function requireKv(env) {
  if (!env?.MI_HEALTH_KV) {
    throw new XiaomiError("MI_HEALTH_KV 未绑定");
  }
  return env.MI_HEALTH_KV;
}

async function readTextLimited(response, maxBytes = MAX_RESPONSE_BYTES) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new XiaomiApiError("小米接口响应过大");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function parseMiResponse(text) {
  const body = text.startsWith("&&&START&&&")
    ? text.slice("&&&START&&&".length)
    : text;
  try {
    return JSON.parse(body);
  } catch {
    throw new XiaomiApiError("小米登录响应不是有效 JSON");
  }
}

function parseEmbeddedValue(value) {
  if (value && typeof value === "object") return value;
  if (typeof value === "number") return value;
  if (typeof value !== "string" || value.length === 0) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function randomDeviceId() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return `an_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function getSetCookieValues(headers) {
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }
  const combined = headers.get("set-cookie");
  return combined ? [combined] : [];
}

function extractCookies(headers) {
  const cookies = {};
  for (const header of getSetCookieValues(headers)) {
    const pattern = /(?:^|,\s*)([^=;,\s]+)=([^;,\s]*)/g;
    let match;
    while ((match = pattern.exec(header)) !== null) {
      const [, name, value] = match;
      if (!["path", "expires", "domain", "samesite", "max-age"].includes(name.toLowerCase())) {
        cookies[name] = value;
      }
    }
  }
  return cookies;
}

function cookieHeader(cookies) {
  return Object.entries(cookies)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

function assertXiaomiUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new XiaomiApiError("小米登录返回了无效 URL");
  }
  const allowedHost =
    url.protocol === "https:" &&
    (url.hostname === "xiaomi.com" ||
      url.hostname.endsWith(".xiaomi.com") ||
      url.hostname === "mi.com" ||
      url.hostname.endsWith(".mi.com"));
  if (!allowedHost) throw new XiaomiApiError("小米登录返回了不受信任的 URL");
  return url;
}

function authFailure(code, message) {
  if ([401, 403, 70001, 70002, 70014].includes(code)) return true;
  return /auth|token|login|credential|expired|鉴权|认证|登录|过期|失效/i.test(message);
}

function healthRegionMismatch(message) {
  return /region|地区|区域|country/i.test(message);
}

function apiMessage(result) {
  for (const key of ["message", "msg", "desc", "description"]) {
    if (typeof result?.[key] === "string" && result[key].trim()) {
      return result[key].trim();
    }
  }
  return "未知错误";
}

export async function loadToken(env) {
  const raw = await requireKv(env).get(TOKEN_KEY);
  if (!raw) return null;
  try {
    const token = JSON.parse(raw);
    if (Object.hasOwn(token, "pass_token")) {
      const { pass_token, ...withoutPassToken } = token;
      await saveToken(env, withoutPassToken);
      return withoutPassToken;
    }
    return token;
  } catch {
    throw new XiaomiError("KV 中的登录凭证损坏，请重新扫码登录");
  }
}

async function saveToken(env, token) {
  const { pass_token, ...withoutPassToken } = token;
  await requireKv(env).put(TOKEN_KEY, JSON.stringify(withoutPassToken));
}

export async function markTokenExpired(env, reason) {
  const token = await loadToken(env);
  if (!token) return;
  await saveToken(env, {
    ...token,
    auth_state: "expired",
    last_checked_at: new Date().toISOString(),
    last_error: String(reason || "小米鉴权失败"),
  });
}

export async function getAuthStatus(env) {
  const token = await loadToken(env);
  if (!token) {
    return {
      token_present: false,
      status: "missing",
      user_id: null,
      updated_at: null,
      message: "尚未登录，请调用 health_login_start",
    };
  }

  const complete = Boolean(
    token.user_id && token.service_token && token.ssecurity,
  );
  return {
    token_present: true,
    status: complete ? token.auth_state || "valid" : "incomplete",
    user_id: token.user_id || null,
    updated_at: token.updated_at || null,
    last_checked_at: token.last_checked_at || null,
    message:
      token.auth_state === "expired"
        ? hasPassTokenConfiguration(env)
          ? "缓存会话已过期，查询时会使用已配置的 passToken 换取新会话"
          : "凭证已过期，请重新扫码登录"
        : complete
          ? "凭证已就绪"
          : "凭证不完整，请重新扫码登录",
  };
}

export async function getLoginStatus(env, fetchImpl = fetch) {
  const token = await loadToken(env);
  if (token?.service_token && token?.ssecurity && token.auth_state !== "expired") {
    return {
      logged_in: true,
      method: token.auth_method || "qr",
      user_id: token.user_id || null,
      session_valid: true,
    };
  }
  if (!hasPassTokenConfiguration(env)) {
    return {
      logged_in: false,
      method: null,
      user_id: token?.user_id || null,
      session_valid: false,
      message: "未配置 XIAOMI_USER_ID/XIAOMI_PASS_TOKEN；可使用 health_login_start 扫码登录",
    };
  }
  try {
    const refreshed = await exchangePassTokenSession(env, fetchImpl);
    return {
      logged_in: true,
      method: "pass_token",
      user_id: refreshed.user_id,
      session_valid: true,
    };
  } catch (error) {
    return {
      logged_in: false,
      method: "pass_token",
      user_id: null,
      session_valid: false,
      message: String(error?.message || "miothealth session 获取失败"),
    };
  }
}

export function hasPassTokenConfiguration(env) {
  return Boolean(env?.XIAOMI_USER_ID || env?.XIAOMI_PASS_TOKEN);
}

function passTokenCredentials(env) {
  const userId = typeof env?.XIAOMI_USER_ID === "string"
    ? env.XIAOMI_USER_ID.trim()
    : "";
  const passToken = typeof env?.XIAOMI_PASS_TOKEN === "string"
    ? env.XIAOMI_PASS_TOKEN
    : "";
  if (!userId && !passToken) return null;
  if (!userId || !passToken) {
    throw new XiaomiAuthError(
      "Cloudflare Secret 配置不完整：XIAOMI_USER_ID 和 XIAOMI_PASS_TOKEN 必须同时设置",
      { authExpired: false },
    );
  }
  return { userId, passToken };
}

async function clientSign(nonce, ssecurity) {
  const source = new TextEncoder().encode(`nonce=${nonce || ""}&${ssecurity}`);
  return bytesToBase64(
    new Uint8Array(await globalThis.crypto.subtle.digest("SHA-1", source)),
  );
}

export async function exchangePassTokenSession(
  env,
  fetchImpl = fetch,
  now = Date.now(),
) {
  const credentials = passTokenCredentials(env);
  if (!credentials) {
    throw new XiaomiAuthError(
      "Cloudflare Secret 未配置：请设置 XIAOMI_USER_ID 和 XIAOMI_PASS_TOKEN，或使用 health_login_start 扫码登录",
      { authExpired: false },
    );
  }
  const deviceId = randomDeviceId();
  const url = new URL(XIAOMI_SERVICE_LOGIN_URL);
  url.searchParams.set("_json", "true");
  url.searchParams.set("sid", SERVICE_SID);
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      headers: {
        "User-Agent": LOGIN_USER_AGENT,
        Cookie: cookieHeader({
          userId: credentials.userId,
          passToken: credentials.passToken,
          deviceId,
        }),
      },
    });
  } catch {
    throw new XiaomiAuthError("Xiaomi Account serviceLogin 请求失败", {
      authExpired: false,
    });
  }
  const body = await readTextLimited(response);
  if (response.status === 401 || response.status === 403) {
    throw new XiaomiAuthError("passToken 无效或已过期", { authExpired: false });
  }
  if (!response.ok) {
    throw new XiaomiApiError(`Xiaomi Account serviceLogin 失败（HTTP ${response.status}）`);
  }
  const data = parseMiResponse(body);
  if (Number(data?.code ?? 0) !== 0) {
    throw new XiaomiAuthError(
      `passToken 无效或已过期（Xiaomi Account code=${Number(data.code)}）`,
      { authExpired: false },
    );
  }
  if (!data.ssecurity || !data.userId || !data.location) {
    throw new XiaomiAuthError("miothealth session 获取失败：serviceLogin 响应不完整", {
      authExpired: false,
    });
  }

  const location = assertXiaomiUrl(data.location);
  location.searchParams.set("clientSign", await clientSign(data.nonce, data.ssecurity));
  const cookies = {
    userId: String(data.userId),
    passToken: credentials.passToken,
    deviceId,
  };
  let extracted;
  try {
    extracted = await extractServiceToken(
      fetchImpl,
      location.toString(),
      cookies,
      "miothealth session 获取失败：未能取得 serviceToken",
    );
  } catch (error) {
    if (error instanceof XiaomiError) throw error;
    throw new XiaomiAuthError("miothealth session 获取失败", { authExpired: false });
  }
  const updatedAt = new Date(now).toISOString();
  const token = {
    user_id: String(data.userId),
    c_user_id: data.cUserId || "",
    service_token: extracted.serviceToken,
    ssecurity: data.ssecurity,
    device_id: deviceId,
    auth_method: "pass_token",
    auth_state: "valid",
    updated_at: updatedAt,
    last_checked_at: null,
    last_error: null,
  };
  await saveToken(env, token);
  return token;
}

async function requireActiveToken(env, fetchImpl = fetch) {
  const token = await loadToken(env);
  if (token?.service_token && token?.ssecurity && token.auth_state !== "expired") {
    return token;
  }
  if (hasPassTokenConfiguration(env)) {
    return exchangePassTokenSession(env, fetchImpl);
  }
  if (!token?.service_token || !token?.ssecurity) {
    throw new XiaomiAuthError(
      "尚未登录，且未配置 XIAOMI_USER_ID/XIAOMI_PASS_TOKEN；请设置 Cloudflare Secret 或调用 health_login_start",
      { authExpired: false },
    );
  }
  throw new XiaomiAuthError(
    "凭证已过期且未配置 XIAOMI_USER_ID/XIAOMI_PASS_TOKEN，请重新扫码登录",
    { authExpired: false },
  );
}

async function requireSelfToken(env, fetchImpl = fetch) {
  const token = await requireActiveToken(env, fetchImpl);
  if (!token.user_id) {
    throw new XiaomiAuthError("登录信息缺少 user_id，请重新扫码登录", {
      authExpired: false,
    });
  }
  return token;
}

async function encryptedRequest(fetchImpl, token, method, path, params) {
  const encrypted = await buildEncryptedParams(
    method,
    path,
    token.ssecurity,
    params,
  );
  const url = new URL(path, HEALTH_API_BASE);
  const headers = {
    "User-Agent": API_USER_AGENT,
    region_tag: "cn",
    handleparams: "true",
    Cookie: cookieHeader({
      cUserId: token.c_user_id,
      serviceToken: token.service_token,
    }),
  };
  const options = { method, headers };

  if (method === "GET") {
    for (const [name, value] of Object.entries(encrypted)) {
      url.searchParams.set(name, value);
    }
  } else {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    options.body = new URLSearchParams(encrypted).toString();
  }

  const response = await fetchImpl(url, options);
  const body = await readTextLimited(response);
  if (response.status === 401 || response.status === 403) {
    throw new XiaomiAuthError(`小米鉴权失败（HTTP ${response.status}）`);
  }
  if (!response.ok) {
    throw new XiaomiApiError(`小米接口请求失败（HTTP ${response.status}）`);
  }

  let result;
  try {
    result = await decryptResponse(token.ssecurity, encrypted._nonce, body);
  } catch {
    throw new XiaomiApiError("小米接口响应解密失败");
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new XiaomiApiError("小米接口响应格式异常");
  }

  const code = Number(result.code ?? -1);
  if (code !== 0) {
    const message = apiMessage(result);
    if (healthRegionMismatch(message)) {
      throw new XiaomiApiError("小米健康 API 地区不匹配", {
        code: Number.isFinite(code) ? code : null,
      });
    }
    throw new XiaomiApiError(
      `小米接口错误（code=${Number.isFinite(code) ? code : "unknown"}）：${message}`,
      {
        code: Number.isFinite(code) ? code : null,
        authExpired: authFailure(code, message),
      },
    );
  }
  return result;
}

function responseResult(response) {
  return response?.result && typeof response.result === "object"
    ? response.result
    : {};
}

function normalizeRelativeUid(value) {
  const validUid =
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) ||
    (typeof value === "string" && /^\d+$/.test(value));
  if (!validUid) throw new XiaomiApiError("relative_uid 必须是有效的小米用户 ID");
  return String(value);
}

async function listRelatives(env, fetchImpl) {
  const token = await requireActiveToken(env, fetchImpl);
  const response = await encryptedRequest(
    fetchImpl,
    token,
    "GET",
    RELATIVES_LIST_PATH,
  );
  const relatives = responseResult(response).relative_list;
  return { token, relatives: Array.isArray(relatives) ? relatives : [] };
}

async function requireRelative(env, relativeUid, fetchImpl) {
  const normalizedUid = normalizeRelativeUid(relativeUid);
  const { token, relatives } = await listRelatives(env, fetchImpl);
  const relative = relatives.find((item) => {
    try {
      return normalizeRelativeUid(item?.relative_uid) === normalizedUid;
    } catch {
      return false;
    }
  });
  if (!relative) {
    throw new XiaomiApiError(`未找到 relative_uid=${normalizedUid} 的亲友，请先调用 health_relatives`);
  }
  return { token, relativeUid: normalizedUid };
}

export async function getRelatives(env, fetchImpl = fetch) {
  const { relatives } = await listRelatives(env, fetchImpl);
  return relatives.flatMap((item) => {
    try {
      const relative_uid = normalizeRelativeUid(item?.relative_uid);
      const result = { relative_uid, relative_note: String(item?.relative_note || "") };
      if (typeof item?.nickname === "string" && item.nickname) {
        result.nickname = item.nickname;
      }
      return [result];
    } catch {
      return [];
    }
  });
}

export async function getHealthMe(env, fetchImpl = fetch) {
  const token = await requireSelfToken(env, fetchImpl);
  return {
    logged_in: true,
    user_id: token.user_id,
    status: token.auth_state || "valid",
    updated_at: token.updated_at || null,
  };
}

function normalizeLatestItem(item) {
  const value = parseEmbeddedValue(item?.value);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { time: Number(item?.time || 0), ...value };
  }
  return { time: Number(item?.time || 0), value };
}

async function getSelfFitnessItems(env, token, key, start, end, fetchImpl) {
  const items = [];
  const seenNextKeys = new Set();
  let nextKey;
  while (true) {
    const params = { start_time: start, end_time: end, key };
    if (nextKey) params.next_key = nextKey;
    const response = await encryptedRequest(
      fetchImpl,
      token,
      "POST",
      SELF_FITNESS_BY_TIME_PATH,
      params,
    );
    const result = responseResult(response);
    if (Array.isArray(result.data_list)) items.push(...result.data_list);
    if (!result.has_more) return items;
    if (typeof result.next_key !== "string" || !result.next_key || seenNextKeys.has(result.next_key)) {
      throw new XiaomiApiError("小米本人健康数据分页响应异常");
    }
    seenNextKeys.add(result.next_key);
    nextKey = result.next_key;
  }
}

function selectLatest(items) {
  return items.reduce((latest, item) =>
    Number(item?.time || 0) > Number(latest?.time || 0) ? item : latest,
  null);
}

function latestResponse(itemsByMetric, target) {
  const data = {};
  let latestDataTime = 0;
  for (const [metric, items] of Object.entries(itemsByMetric)) {
    const item = selectLatest(items);
    if (!item) continue;
    data[metric] = normalizeLatestItem(item);
    latestDataTime = Math.max(latestDataTime, Number(item.time || 0));
  }
  return {
    ...target,
    latest_data_time: latestDataTime,
    data,
    message:
      Object.keys(data).length === 0
        ? "暂无睡眠、心率或步数数据（设备可能未佩戴或尚未同步）"
        : undefined,
  };
}

export async function getLatestHealth(env, target, fetchImpl = fetch, now = Date.now()) {
  if (target.target === "self") {
    const token = await requireSelfToken(env, fetchImpl);
    const { start, end } = cstTodayWindow(now, 1);
    const [sleep, heart_rate, steps] = await Promise.all(
      ["sleep", "heart_rate", "steps"].map((key) =>
        getSelfFitnessItems(env, token, key, start, end, fetchImpl),
      ),
    );
    return latestResponse(
      { sleep, heart_rate, steps },
      { target: "self", user_id: token.user_id || null },
    );
  }

  const { token, relativeUid } = await requireRelative(
    env,
    target.relative_uid,
    fetchImpl,
  );
  const response = await encryptedRequest(
    fetchImpl,
    token,
    "GET",
    RELATIVES_LATEST_PATH,
    { relative_uid: relativeUid },
  );
  const result = responseResult(response);
  const items = Array.isArray(result.data_list) ? result.data_list : [];
  const itemsByMetric = { sleep: [], heart_rate: [], steps: [] };
  for (const item of items) {
    if (itemsByMetric[item?.key]) itemsByMetric[item.key].push(item);
  }
  const output = latestResponse(itemsByMetric, {
    target: "relative",
    relative_uid: relativeUid,
  });
  output.latest_data_time = Number(result.latest_data_time || output.latest_data_time);
  return output;
}

function cstTodayWindow(now, days) {
  const shifted = new Date(now + CST_OFFSET_SECONDS * 1000);
  const utcMidnight = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  );
  const end = Math.floor(utcMidnight / 1000) - CST_OFFSET_SECONDS + 86400 - 1;
  return { start: end - 86400 * days + 1, end };
}

function cstDate(timestamp) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  return new Date((timestamp + CST_OFFSET_SECONDS) * 1000)
    .toISOString()
    .slice(0, 10);
}

function normalizeSeriesItem(item) {
  const time = Number(item?.time || 0);
  const value = parseEmbeddedValue(item?.value);
  const data =
    value && typeof value === "object" && !Array.isArray(value)
      ? value
      : { value };
  return { date: cstDate(time), time, ...data };
}

export async function getHealthSeries(
  env,
  metric,
  days,
  target,
  fetchImpl = fetch,
  now = Date.now(),
) {
  const { start, end } = cstTodayWindow(now, days);
  if (target.target === "self") {
    const token = await requireSelfToken(env, fetchImpl);
    const items = await getSelfFitnessItems(
      env,
      token,
      metric,
      start,
      end,
      fetchImpl,
    );
    const data = items
      .map(normalizeSeriesItem)
      .sort((left, right) => left.time - right.time);
    return {
      target: "self",
      user_id: token.user_id || null,
      metric,
      days,
      data,
      message:
        data.length === 0
          ? "暂无数据（设备可能未佩戴或尚未同步）"
          : undefined,
    };
  }

  const { token, relativeUid } = await requireRelative(
    env,
    target.relative_uid,
    fetchImpl,
  );
  const response = await encryptedRequest(
    fetchImpl,
    token,
    "GET",
    RELATIVES_AGGREGATED_PATH,
    {
      relative_uid: relativeUid,
      key: metric,
      tag: "daily_report",
      start_time: start,
      end_time: end,
      limit: days,
    },
  );
  const items = responseResult(response).data_list;
  const data = (Array.isArray(items) ? items : [])
    .map(normalizeSeriesItem)
    .sort((left, right) => left.time - right.time);

  return {
    target: "relative",
    relative_uid: relativeUid,
    metric,
    days,
    data,
    message:
      data.length === 0
        ? "暂无数据（设备可能未佩戴或尚未同步）"
        : undefined,
  };
}

export async function startQrLogin(env, fetchImpl = fetch, now = Date.now()) {
  const deviceId = randomDeviceId();
  const url = new URL(XIAOMI_QR_LOGIN_URL);
  const params = {
    _qrsize: "480",
    qs: `%3Fsid%3D${SERVICE_SID}%26_json%3Dtrue`,
    callback: STS_HEALTH_URL,
    _hasLogo: "false",
    sid: SERVICE_SID,
    serviceParam: "",
    _locale: "zh_CN",
    _dc: String(now),
  };
  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(name, value);
  }

  const response = await fetchImpl(url, {
    method: "GET",
    redirect: "manual",
    headers: {
      "User-Agent": LOGIN_USER_AGENT,
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: `deviceId=${deviceId}`,
    },
  });
  const body = await readTextLimited(response);
  if (!response.ok) {
    throw new XiaomiApiError(`获取扫码登录地址失败（HTTP ${response.status}）`);
  }
  const data = parseMiResponse(body);
  if (!data.loginUrl || !data.lp) {
    throw new XiaomiApiError("获取扫码登录地址失败：响应缺少 loginUrl 或 lp");
  }
  assertXiaomiUrl(data.loginUrl);
  assertXiaomiUrl(data.lp);

  const timeoutSeconds = Math.max(
    1,
    Math.min(Number(data.timeout) || 300, 300),
  );
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + timeoutSeconds * 1000).toISOString();
  const session = {
    login_url: data.loginUrl,
    long_polling_url: data.lp,
    device_id: deviceId,
    cookies: {
      deviceId,
      ...extractCookies(response.headers),
    },
    created_at: createdAt,
    expires_at: expiresAt,
  };
  await requireKv(env).put(LOGIN_SESSION_KEY, JSON.stringify(session), {
    expirationTtl: Math.ceil(timeoutSeconds) + 60,
  });

  return {
    status: "pending",
    loginUrl: data.loginUrl,
    expires_at: expiresAt,
    message: "请将 loginUrl 渲染为二维码并用小米账号 App 扫描",
  };
}

async function loadLoginSession(env) {
  const raw = await requireKv(env).get(LOGIN_SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new XiaomiError("KV 中的扫码登录会话损坏，请重新发起登录");
  }
}

async function extractServiceToken(
  fetchImpl,
  location,
  cookies,
  failureMessage = "未能取得 serviceToken",
) {
  const url = assertXiaomiUrl(location);
  const response = await fetchImpl(url, {
    method: "GET",
    redirect: "manual",
    headers: {
      "User-Agent": LOGIN_USER_AGENT,
      Cookie: cookieHeader(cookies),
    },
  });
  if (response.status >= 400) {
    await response.body?.cancel();
    throw new XiaomiApiError(`${failureMessage}（HTTP ${response.status}）`);
  }
  await response.body?.cancel();
  const responseCookies = extractCookies(response.headers);
  const redirectLocation = response.headers.get("location");
  const candidateUrls = [url.toString(), redirectLocation].filter(Boolean);
  let serviceToken = responseCookies.serviceToken || cookies.serviceToken || "";
  for (const candidate of candidateUrls) {
    try {
      serviceToken ||= new URL(candidate, url).searchParams.get("serviceToken") || "";
    } catch {
      // Ignore malformed optional redirect locations.
    }
  }
  if (!serviceToken) {
    throw new XiaomiApiError(failureMessage);
  }
  return { serviceToken, cookies: { ...cookies, ...responseCookies } };
}

async function exchangeSts(fetchImpl, deviceId, cookies, now) {
  const url = new URL(STS_HEALTH_URL);
  const params = {
    d: deviceId,
    ticket: "0",
    pwd: "0",
    p_ts: String(now),
    fid: "0",
    p_lm: "2",
    p_ur: "CN",
  };
  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(name, value);
  }
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      headers: {
        "User-Agent": LOGIN_USER_AGENT,
        Cookie: cookieHeader(cookies),
      },
    });
    await response.body?.cancel();
  } catch {
    // The reference client treats STS exchange as best-effort.
  }
}

export async function pollQrLogin(env, fetchImpl = fetch, now = Date.now()) {
  const session = await loadLoginSession(env);
  if (!session) {
    return {
      status: "missing",
      message: "没有待处理的扫码登录，请先调用 health_login_start",
    };
  }
  if (Date.parse(session.expires_at) <= now) {
    await requireKv(env).delete(LOGIN_SESSION_KEY);
    return {
      status: "expired",
      message: "二维码已过期，请重新调用 health_login_start",
    };
  }

  const pollUrl = assertXiaomiUrl(session.long_polling_url);
  let response;
  try {
    response = await fetchImpl(pollUrl, {
      method: "GET",
      redirect: "manual",
      headers: {
        "User-Agent": LOGIN_USER_AGENT,
        Cookie: cookieHeader(session.cookies || {}),
      },
      // 小米 lp 是长轮询会挂起数分钟，worker 侧 25 秒主动断开，
      // 把长等待变成客户端多次短轮询，避免边缘超时 529
      signal: AbortSignal.timeout(25_000),
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      return {
        status: "pending",
        message: "等待扫码确认中，请稍后再次调用 health_login_poll",
      };
    }
    throw error;
  }
  if (!response.ok) {
    return {
      status: "pending",
      message: "尚未确认扫码，请稍后再次调用 health_login_poll",
    };
  }
  const body = await readTextLimited(response);
  const data = parseMiResponse(body);
  if (!data.ssecurity || !data.userId || !data.location) {
    return {
      status: "pending",
      message: "尚未确认扫码，请稍后再次调用 health_login_poll",
    };
  }

  const cookies = {
    ...(session.cookies || {}),
    ...extractCookies(response.headers),
    deviceId: session.device_id,
    userId: String(data.userId),
    passToken: data.passToken || "",
  };
  const extracted = await extractServiceToken(
    fetchImpl,
    data.location,
    cookies,
  );
  const updatedAt = new Date(now).toISOString();
  const token = {
    user_id: String(data.userId),
    c_user_id: data.cUserId || "",
    service_token: extracted.serviceToken,
    ssecurity: data.ssecurity,
    device_id: session.device_id,
    auth_method: "qr",
    auth_state: "valid",
    updated_at: updatedAt,
    last_checked_at: null,
    last_error: null,
  };

  await exchangeSts(
    fetchImpl,
    session.device_id,
    extracted.cookies,
    now,
  );
  await saveToken(env, token);
  await requireKv(env).delete(LOGIN_SESSION_KEY);
  return {
    status: "success",
    user_id: token.user_id,
    updated_at: updatedAt,
    message: "扫码登录成功，凭证已写入 KV",
  };
}

// 错误定位（diagnostics）：只产出固定枚举/数字/uuid 的安全字段，
// 绝不包含 URL 参数、响应正文、用户 id 或凭证。

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function newRequestId() {
  return globalThis.crypto.randomUUID();
}

// 固定 operation 名映射：内部小米查询路径 → 固定名称（不含用户 id/参数）。
const API_OPERATIONS = new Map([
  ["/app/v1/relatives/get_relative_list", "relatives_list"],
  ["/app/v1/relatives/get_latest_data", "relatives_latest"],
  ["/app/v1/relatives/get_aggregated_data", "relatives_aggregated"],
  ["/app/v1/data/get_fitness_data_by_time", "fitness_by_time"],
  ["/app/v1/data/get_sport_records_by_time", "sport_by_time"],
]);

// 登录路径（serviceLogin/serviceLoginAuth2/sts/qr）→ auth
const AUTH_PATH_PATTERN =
  /serviceLogin|serviceLoginAuth2|\/sts(?:\/|$|\?)|longPolling\/loginUrl|qr/i;

export function operationForPath(path) {
  const value = String(path ?? "");
  let pathname = value;
  try {
    pathname = new URL(value).pathname;
  } catch {
    // 相对路径：剥掉查询串后再匹配，参数不进入映射
    pathname = value.split(/[?#]/, 1)[0];
  }
  if (API_OPERATIONS.has(pathname)) return API_OPERATIONS.get(pathname);
  if (AUTH_PATH_PATTERN.test(value)) return "auth";
  return "unknown";
}

const PHASES = new Set(["fetch", "body", "parse", "auth"]);
const KINDS = new Set([
  "timeout",
  "too_large",
  "decrypt",
  "http_status",
  "api_code",
  "auth",
  "parse",
  "network",
  "unknown",
]);
const OPERATIONS = new Set([...API_OPERATIONS.values(), "auth", "unknown"]);

function classifyKind(error, phase, httpStatus) {
  const name = typeof error?.name === "string" ? error.name : "";
  const message = typeof error?.message === "string" ? error.message : "";
  if (
    name === "TimeoutError" ||
    name === "AbortError" ||
    /超时|timed?[\s-]*out/i.test(message)
  ) {
    return "timeout";
  }
  if (/响应过大|too[\s_-]?large/i.test(message)) return "too_large";
  if (/解密/.test(message)) return "decrypt";
  if (
    error?.constructor?.name === "XiaomiAuthError" ||
    /鉴权|凭证|登录|passToken/i.test(message)
  ) {
    return "auth";
  }
  if (/JSON|格式异常/.test(message)) return "parse";
  if (typeof error?.code === "number" || /code=\S+/.test(message)) {
    return "api_code";
  }
  if (
    (typeof httpStatus === "number" && httpStatus >= 400) ||
    /HTTP \d{3}/.test(message)
  ) {
    return "http_status";
  }
  if (phase === "auth") return "auth";
  if (phase === "fetch") return "network";
  return "unknown";
}

export class RequestDiagnostics {
  constructor(operation) {
    this.requestId = newRequestId();
    this.operation = OPERATIONS.has(operation) ? operation : "unknown";
    this.phase = "fetch";
    this.started = Date.now();
    this.httpStatus = null;
  }

  setPhase(phase) {
    if (PHASES.has(phase)) this.phase = phase;
  }

  setHttpStatus(status) {
    if (Number.isInteger(status)) this.httpStatus = status;
  }

  // 失败时：把安全诊断字段附到抛出的错误上，并打一行结构化日志。
  // 已带 request_id 的错误（内层已诊断）原样返回，不重复打日志。
  fail(error) {
    if (error && typeof error === "object" && typeof error.request_id === "string") {
      return error;
    }
    const elapsedMs = Math.max(0, Date.now() - this.started);
    const kind = classifyKind(error, this.phase, this.httpStatus);
    // http_status 仅附 401/403/5xx 等数字错误状态
    const httpStatus =
      Number.isInteger(this.httpStatus) && this.httpStatus >= 400
        ? this.httpStatus
        : null;
    if (error && typeof error === "object") {
      error.request_id = this.requestId;
      error.operation = this.operation;
      error.phase = this.phase;
      error.kind = kind;
      error.elapsed_ms = elapsedMs;
      error.http_status = httpStatus;
    }
    console.log(
      JSON.stringify({
        event: "mi_health_request_error",
        request_id: this.requestId,
        operation: this.operation,
        phase: this.phase,
        kind,
        elapsed_ms: elapsedMs,
        http_status: httpStatus,
      }),
    );
    return error;
  }
}

export function beginRequest(operation) {
  return new RequestDiagnostics(operation);
}

// auth 阶段（登录路径）等价包装：整个 fn 处于 auth phase。
export async function diagnoseAuth(fn) {
  const diag = beginRequest("auth");
  diag.setPhase("auth");
  try {
    return await fn();
  } catch (error) {
    throw diag.fail(error);
  }
}

// 白名单提取：只放行固定枚举/数字/uuid，注入的敏感字段/字符串不透出。
export function diagnosticsPayload(error) {
  if (!error || typeof error !== "object") return null;
  if (
    typeof error.request_id !== "string" ||
    !UUID_PATTERN.test(error.request_id)
  ) {
    return null;
  }
  return {
    request_id: error.request_id,
    operation: OPERATIONS.has(error.operation) ? error.operation : "unknown",
    phase: PHASES.has(error.phase) ? error.phase : "unknown",
    kind: KINDS.has(error.kind) ? error.kind : "unknown",
    elapsed_ms: Number.isFinite(error.elapsed_ms)
      ? Math.max(0, Math.round(error.elapsed_ms))
      : 0,
    http_status: Number.isInteger(error.http_status) ? error.http_status : null,
  };
}

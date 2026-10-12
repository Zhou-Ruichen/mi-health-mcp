import { timingSafeTextEqual } from "./crypto.js";
import { diagnosticsPayload } from "./diagnostics.js";
import { callTool, ToolPublicError, TOOLS } from "./tools.js";
import { XiaomiError } from "./xiaomi.js";

const PROTOCOL_VERSION = "2024-11-05";
const MAX_REQUEST_BYTES = 1024 * 1024;

function jsonResponse(value, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

function rpcError(id, code, message) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message },
  };
}

async function readJsonLimited(request) {
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_REQUEST_BYTES) {
    throw new Error("PAYLOAD_TOO_LARGE");
  }
  if (!request.body) throw new SyntaxError("empty body");

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_REQUEST_BYTES) {
      await reader.cancel();
      throw new Error("PAYLOAD_TOO_LARGE");
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return JSON.parse(text);
}

function toolResult(value) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value),
      },
    ],
  };
}

function toolError(error) {
  const publicError = error instanceof ToolPublicError || error instanceof XiaomiError;
  const message = publicError
    ? String(error?.message || "请求失败")
      .replace(/https?:\/\/[^\s"'<>]+/gi, "[REDACTED_URL]")
      .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
      .replace(
        /\b(passToken|cUserId|serviceToken|ssecurity|cookie|authorization|token|password|secret)\b\s*[:=]\s*[^\s,;]+/gi,
        "$1=[REDACTED]",
      )
      .slice(0, 2000)
    : "请求失败；详情已隐藏";
  const result = { ok: false, error: message };
  const diagnostics = diagnosticsPayload(error);
  if (diagnostics) result.diagnostics = diagnostics;
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result),
      },
    ],
    isError: true,
  };
}

export async function handleRpc(message, env, fetchImpl = fetch) {
  if (
    !message ||
    typeof message !== "object" ||
    Array.isArray(message) ||
    message.jsonrpc !== "2.0" ||
    typeof message.method !== "string"
  ) {
    return rpcError(message?.id, -32600, "invalid request");
  }

  const { id, method } = message;
  const params =
    message.params && typeof message.params === "object"
      ? message.params
      : {};

  if (method === "notifications/initialized") return null;

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "mi-health-mcp", version: "1.2.0" },
        instructions:
          "查询当前登录小米账号本人或已授权亲友的健康数据。默认 target=self；查询亲友前先调用 health_relatives，并以 target=relative 和 relative_uid 指定目标。需要趋势或合理分析时优先调用 health_analyze，并传入用户当前 IANA 时区以区分未结束的当日数据。未登录时用 health_login_start 取得二维码、再用 health_login_poll 轮询结果；扫码是目前唯一实测可用的登录方式。",
      },
    };
  }

  if (method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }

  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: { tools: TOOLS },
    };
  }

  if (method === "tools/call") {
    const name = params.name;
    if (typeof name !== "string") {
      return {
        jsonrpc: "2.0",
        id,
        result: toolError(new Error("缺少工具名")),
      };
    }
    try {
      const value = await callTool(
        name,
        Object.hasOwn(params, "arguments") ? params.arguments : {},
        env,
        fetchImpl,
      );
      return { jsonrpc: "2.0", id, result: toolResult(value) };
    } catch (error) {
      return { jsonrpc: "2.0", id, result: toolError(error) };
    }
  }

  if (method === "resources/list") {
    return { jsonrpc: "2.0", id, result: { resources: [] } };
  }
  if (method === "prompts/list") {
    return { jsonrpc: "2.0", id, result: { prompts: [] } };
  }

  if (id === undefined || id === null) return null;
  return rpcError(id, -32601, `method not found: ${method}`);
}

// Bearer 头只认主 AUTH_TOKEN；URL 里的凭证只认独立的 CONNECTOR_TOKEN。
// 两者分开，主 token 就永远不会出现在 URL 中，也就不会落进 Cloudflare 的边缘访问日志。
function bearerToken(request) {
  const authorization = request.headers.get("Authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

async function authorized(request, url, env) {
  if (await timingSafeTextEqual(bearerToken(request), env.AUTH_TOKEN)) {
    return true;
  }
  const connectorToken =
    typeof env.CONNECTOR_TOKEN === "string" ? env.CONNECTOR_TOKEN.trim() : "";
  const urlToken = (url.searchParams.get("token") || "").trim();
  if (!connectorToken || !urlToken) return false;
  return timingSafeTextEqual(urlToken, connectorToken);
}

async function handleMcpRequest(request, env, fetchImpl, url) {
  if (!env?.AUTH_TOKEN) {
    return jsonResponse(
      { error: "server misconfigured: AUTH_TOKEN not set" },
      500,
    );
  }
  if (!(await authorized(request, url, env))) {
    return jsonResponse(
      { error: "unauthorized" },
      401,
      { "WWW-Authenticate": "Bearer" },
    );
  }
  if (request.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405, {
      Allow: "POST",
    });
  }

  let payload;
  try {
    payload = await readJsonLimited(request);
  } catch (error) {
    if (error?.message === "PAYLOAD_TOO_LARGE") {
      return jsonResponse(rpcError(null, -32600, "payload too large"), 413);
    }
    return jsonResponse(rpcError(null, -32700, "parse error"));
  }

  if (Array.isArray(payload)) {
    if (payload.length === 0) {
      return jsonResponse(rpcError(null, -32600, "invalid request"));
    }
    const responses = [];
    for (const message of payload) {
      const response = await handleRpc(message, env, fetchImpl);
      if (response) responses.push(response);
    }
    return responses.length > 0
      ? jsonResponse(responses)
      : new Response(null, { status: 202 });
  }

  const response = await handleRpc(payload, env, fetchImpl);
  return response
    ? jsonResponse(response)
    : new Response(null, { status: 202 });
}

export function createWorker({ fetchImpl = fetch } = {}) {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (url.pathname === "/" || url.pathname === "/health") {
        return jsonResponse({
          ok: true,
          service: "mi-health-mcp",
          mcp_endpoint: "/mcp",
        });
      }
      if (url.pathname !== "/mcp") {
        return jsonResponse({ error: "not found" }, 404);
      }
      return handleMcpRequest(request, env, fetchImpl, url);
    },
  };
}

export default createWorker();

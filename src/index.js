import { timingSafeTextEqual } from "./crypto.js";
import { callTool, TOOLS } from "./tools.js";

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
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function toolError(error) {
  const message = String(error?.message || error || "未知错误").slice(0, 2000);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ ok: false, error: message }, null, 2),
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
        serverInfo: { name: "mi-health-mcp", version: "1.0.0" },
        instructions:
          "查询当前登录小米账号本人或已授权亲友的健康数据。默认 target=self；查询亲友前先调用 health_relatives，并以 target=relative 和 relative_uid 指定目标。配置 XIAOMI_USER_ID 和 XIAOMI_PASS_TOKEN 后会自动换取 miothealth 会话；否则可调用 health_login_start 后轮询 health_login_poll。",
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
        params.arguments || {},
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

async function bearerAuthorized(request, expected) {
  const authorization = request.headers.get("Authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  const provided = match ? match[1].trim() : "";
  return timingSafeTextEqual(provided, expected);
}

async function handleMcpRequest(request, env, fetchImpl) {
  if (!env?.AUTH_TOKEN) {
    return jsonResponse(
      { error: "server misconfigured: AUTH_TOKEN not set" },
      500,
    );
  }
  if (!(await bearerAuthorized(request, env.AUTH_TOKEN))) {
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
      return handleMcpRequest(request, env, fetchImpl);
    },
  };
}

export default createWorker();

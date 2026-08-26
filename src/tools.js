import {
  getAuthStatus,
  getHealthMe,
  getHealthSeries,
  getLoginStatus,
  getLatestHealth,
  getRelatives,
  hasPassTokenConfiguration,
  markTokenExpired,
  pollQrLogin,
  exchangePassTokenSession,
  startQrLogin,
} from "./xiaomi.js";

const emptySchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

const targetProperties = {
  target: {
    type: "string",
    enum: ["self", "relative"],
    default: "self",
    description: "查询本人时使用 self（默认）；查询亲友、家人或指定用户时使用 relative。",
  },
  relative_uid: {
    oneOf: [
      { type: "string", pattern: "^[0-9]+$" },
      { type: "integer" },
    ],
    description: "target=relative 时必填。先调用 health_relatives 获取。",
  },
};

const targetSchema = {
  type: "object",
  properties: {
    ...targetProperties,
  },
  allOf: [
    {
      if: { properties: { target: { const: "relative" } }, required: ["target"] },
      then: { required: ["relative_uid"] },
    },
  ],
  additionalProperties: false,
};

const daysSchema = {
  type: "object",
  properties: {
    ...targetProperties,
    days: {
      type: "integer",
      minimum: 1,
      maximum: 30,
      default: 7,
      description: "查询天数，默认 7，最多 30。",
    },
  },
  allOf: targetSchema.allOf,
  additionalProperties: false,
};

export const TOOLS = [
  {
    name: "health_latest",
    description: "查询本人或指定亲友最新的睡眠、心率和步数快照。用户说“我、我的、本人”时 target=self；说“亲友、家人、指定用户”时 target=relative 并提供 relative_uid。",
    inputSchema: targetSchema,
  },
  {
    name: "health_sleep",
    description: "查询本人或指定亲友最近的睡眠记录。用户说“我、我的、本人”时 target=self；查询亲友时 target=relative 并提供 relative_uid。",
    inputSchema: daysSchema,
  },
  {
    name: "health_heart",
    description: "查询本人或指定亲友最近的心率记录。用户说“我、我的、本人”时 target=self；查询亲友时 target=relative 并提供 relative_uid。",
    inputSchema: daysSchema,
  },
  {
    name: "health_steps",
    description: "查询本人或指定亲友最近的步数记录。用户说“我、我的、本人”时 target=self；查询亲友时 target=relative 并提供 relative_uid。",
    inputSchema: daysSchema,
  },
  {
    name: "health_auth_status",
    description: "查看小米凭证是否存在、用户 ID、状态和最后更新时间；不会返回凭证本体。",
    inputSchema: emptySchema,
  },
  {
    name: "health_me",
    description: "查看当前登录的小米账号状态和 user_id，不会返回任何认证凭证。未登录或凭证不完整时提示配置 passToken Secret 或运行登录工具。",
    inputSchema: emptySchema,
  },
  {
    name: "health_relatives",
    description: "列出当前登录账号可查询的亲友。返回 relative_uid 和备注；查询亲友健康数据时将 target 设为 relative 并提供该 relative_uid。",
    inputSchema: emptySchema,
  },
  {
    name: "health_login_status",
    description: "查看当前健康 API 会话状态。配置 XIAOMI_USER_ID 和 XIAOMI_PASS_TOKEN 后会自动换取 miothealth 会话；不会返回任何 token 或 cookie。",
    inputSchema: emptySchema,
  },
  {
    name: "health_login_start",
    description: "发起小米账号扫码登录，返回供调用方自行渲染二维码的 loginUrl。",
    inputSchema: emptySchema,
  },
  {
    name: "health_login_poll",
    description: "轮询扫码结果；成功后将新凭证写入 Cloudflare KV。",
    inputSchema: emptySchema,
  },
];

function parseDays(args) {
  if (args.days === undefined) return 7;
  if (!Number.isInteger(args.days) || args.days < 1 || args.days > 30) {
    throw new Error("days 必须是 1 到 30 的整数");
  }
  return args.days;
}

function parseTarget(args) {
  const target = args.target === undefined ? "self" : args.target;
  if (target !== "self" && target !== "relative") {
    throw new Error("target 必须是 self 或 relative");
  }
  if (target === "self") return { target };
  const relativeUid = args.relative_uid;
  const validUid =
    (typeof relativeUid === "number" && Number.isInteger(relativeUid)) ||
    (typeof relativeUid === "string" && /^\d+$/.test(relativeUid));
  if (!validUid) {
    throw new Error("target=relative 时必须提供有效的 relative_uid；请先调用 health_relatives");
  }
  return { target, relative_uid: String(relativeUid) };
}

async function withAuthTracking(env, fetchImpl, operation) {
  try {
    return await operation();
  } catch (error) {
    if (error?.authExpired) {
      await markTokenExpired(env, error.message);
      if (hasPassTokenConfiguration(env)) {
        await exchangePassTokenSession(env, fetchImpl);
        return operation();
      }
      throw new Error(`小米凭证已过期，请重新扫码登录：${error.message}`);
    }
    throw error;
  }
}

export async function callTool(
  name,
  args,
  env,
  fetchImpl = fetch,
) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("arguments 必须是 JSON 对象");
  }

  switch (name) {
    case "health_latest":
      return withAuthTracking(env, fetchImpl, () =>
        getLatestHealth(env, parseTarget(args), fetchImpl),
      );
    case "health_sleep":
      return withAuthTracking(env, fetchImpl, () =>
        getHealthSeries(env, "sleep", parseDays(args), parseTarget(args), fetchImpl),
      );
    case "health_heart":
      return withAuthTracking(env, fetchImpl, () =>
        getHealthSeries(env, "heart_rate", parseDays(args), parseTarget(args), fetchImpl),
      );
    case "health_steps":
      return withAuthTracking(env, fetchImpl, () =>
        getHealthSeries(env, "steps", parseDays(args), parseTarget(args), fetchImpl),
      );
    case "health_auth_status":
      return getAuthStatus(env);
    case "health_me":
      return withAuthTracking(env, fetchImpl, () => getHealthMe(env, fetchImpl));
    case "health_relatives":
      return withAuthTracking(env, fetchImpl, () => getRelatives(env, fetchImpl));
    case "health_login_status":
      return getLoginStatus(env, fetchImpl);
    case "health_login_start":
      return startQrLogin(env, fetchImpl);
    case "health_login_poll":
      return pollQrLogin(env, fetchImpl);
    default:
      throw new Error(`未知工具：${name}`);
  }
}

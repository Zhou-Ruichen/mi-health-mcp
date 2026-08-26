import {
  getAuthStatus,
  getHealthSeries,
  getLatestHealth,
  markTokenExpired,
  pollQrLogin,
  startQrLogin,
} from "./xiaomi.js";

const emptySchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

const daysSchema = {
  type: "object",
  properties: {
    days: {
      type: "integer",
      minimum: 1,
      maximum: 30,
      default: 7,
      description: "查询天数，默认 7，最多 30。",
    },
  },
  additionalProperties: false,
};

export const TOOLS = [
  {
    name: "health_latest",
    description: "查询第一位亲友最新的睡眠、心率和步数快照；仅返回已有数据。",
    inputSchema: emptySchema,
  },
  {
    name: "health_sleep",
    description: "查询第一位亲友的每日睡眠序列。",
    inputSchema: daysSchema,
  },
  {
    name: "health_heart",
    description: "查询第一位亲友的每日心率序列。",
    inputSchema: daysSchema,
  },
  {
    name: "health_steps",
    description: "查询第一位亲友的每日步数序列。",
    inputSchema: daysSchema,
  },
  {
    name: "health_auth_status",
    description: "查看小米凭证是否存在、用户 ID、状态和最后更新时间；不会返回凭证本体。",
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

async function withAuthTracking(env, operation) {
  try {
    return await operation();
  } catch (error) {
    if (error?.authExpired) {
      await markTokenExpired(env, error.message);
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
      return withAuthTracking(env, () => getLatestHealth(env, fetchImpl));
    case "health_sleep":
      return withAuthTracking(env, () =>
        getHealthSeries(env, "sleep", parseDays(args), fetchImpl),
      );
    case "health_heart":
      return withAuthTracking(env, () =>
        getHealthSeries(env, "heart_rate", parseDays(args), fetchImpl),
      );
    case "health_steps":
      return withAuthTracking(env, () =>
        getHealthSeries(env, "steps", parseDays(args), fetchImpl),
      );
    case "health_auth_status":
      return getAuthStatus(env);
    case "health_login_start":
      return startQrLogin(env, fetchImpl);
    case "health_login_poll":
      return pollQrLogin(env, fetchImpl);
    default:
      throw new Error(`未知工具：${name}`);
  }
}

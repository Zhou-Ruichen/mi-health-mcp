import { analyzeHealthSeries } from "./analysis.js";
import {
  getAuthStatus,
  getHealthMe,
  getHealthSeries,
  getLoginStatus,
  getLatestHealth,
  getRelatives,
  getWorkouts,
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
      { type: "string", pattern: "^(?:0*[1-9][0-9]*)$" },
      { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    ],
    description: "target=relative 时必填，必须是正整数或正数字符串。先调用 health_relatives 获取。",
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
    {
      if: {
        anyOf: [
          { not: { required: ["target"] } },
          { properties: { target: { const: "self" } }, required: ["target"] },
        ],
      },
      then: { not: { required: ["relative_uid"] } },
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

const selfDaysSchema = {
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

const analysisSchema = {
  type: "object",
  properties: {
    ...targetProperties,
    days: {
      type: "integer",
      minimum: 8,
      maximum: 30,
      default: 30,
      description: "分析窗口天数，默认 30，范围 8 到 30。",
    },
    recent_days: {
      type: "integer",
      minimum: 3,
      maximum: 14,
      default: 7,
      description: "近期完整日窗口，默认 7；必须小于 days。",
    },
    timezone: {
      type: "string",
      minLength: 1,
      maxLength: 64,
      default: "UTC",
      description: "用于识别当日未结束记录的 IANA 时区，例如 Europe/Berlin；不重算接口返回的日期。",
    },
  },
  allOf: targetSchema.allOf,
  additionalProperties: false,
};

export const TOOLS = [
  {
    name: "health_latest",
    description: "查询本人或指定亲友最新的睡眠、心率和步数摘要。用户说“我、我的、本人”时 target=self；说“亲友、家人、指定用户”时 target=relative 并提供 relative_uid。",
    inputSchema: targetSchema,
  },
  {
    name: "health_analyze",
    description: "基于个人历史基线分析步数、距离、calories、睡眠和每日心率摘要。默认比较最近 7 个完整日与此前数据，先报告部分日、缺失、同步和采样质量；结果仅供非诊断性趋势参考。",
    inputSchema: analysisSchema,
  },
  {
    name: "health_sleep",
    description: "查询本人或指定亲友最近的每日睡眠摘要，每天最多一条。用户说“我、我的、本人”时 target=self；查询亲友时 target=relative 并提供 relative_uid。",
    inputSchema: daysSchema,
  },
  {
    name: "health_heart",
    description: "查询本人或指定亲友最近的每日心率统计，不返回全部采样点。用户说“我、我的、本人”时 target=self；查询亲友时 target=relative 并提供 relative_uid。",
    inputSchema: daysSchema,
  },
  {
    name: "health_steps",
    description: "查询本人或指定亲友最近的每日步数摘要，每天最多一条。用户说“我、我的、本人”时 target=self；查询亲友时 target=relative 并提供 relative_uid。",
    inputSchema: daysSchema,
  },
  {
    name: "health_workouts",
    description: "查询本人最近的运动 session 记录（单次运动摘要：类型、开始/结束时间、时长秒数、距离、calories、平均/最高心率，仅透传上游提供的字段）。仅支持本人，暂不支持亲友；不返回原始高频传感器数据。calories 为 Xiaomi 返回值，不解释为 active calories。",
    inputSchema: selfDaysSchema,
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
    description: "查看当前健康 API 会话状态。推荐配置 XIAOMI_USER_ID、XIAOMI_PASS_TOKEN 和浏览器 Cookie 中的 XIAOMI_DEVICE_ID；不会返回任何 token 或 cookie。",
    inputSchema: emptySchema,
  },
  {
    name: "health_login_refresh",
    description: "使用已配置的小米账号 Secret 重新换取 miothealth 会话。成功时更新 KV；失败时保留当前缓存会话；不会返回任何 token 或 cookie。",
    inputSchema: emptySchema,
  },
  {
    name: "health_login_start",
    description: "兼容用的小米账号扫码登录入口。二维码登录可能被 Xiaomi 拒绝并返回 70036，推荐改用 XIAOMI_USER_ID 和 XIAOMI_PASS_TOKEN。",
    inputSchema: emptySchema,
  },
  {
    name: "health_login_poll",
    description: "轮询兼容用的扫码登录结果。二维码登录可能收到 Xiaomi 70036；成功时才会缓存健康会话。",
    inputSchema: emptySchema,
  },
];

export class ToolPublicError extends Error {
  constructor(message) {
    super(message);
    this.name = "ToolPublicError";
  }
}

export class ToolValidationError extends ToolPublicError {
  constructor(message) {
    super(message);
    this.name = "ToolValidationError";
  }
}

const toolByName = new Map(TOOLS.map((tool) => [tool.name, tool]));

function assertToolValidation(condition, message) {
  if (!condition) throw new ToolValidationError(message);
}

function isPositiveRelativeUid(value) {
  return (
    (typeof value === "number" && Number.isSafeInteger(value) && value > 0) ||
    (typeof value === "string" && /^(?:0*[1-9][0-9]*)$/.test(value))
  );
}

function validateToolArguments(name, args) {
  const tool = toolByName.get(name);
  if (!tool) throw new ToolValidationError(`未知工具：${name}`);
  assertToolValidation(
    args && typeof args === "object" && !Array.isArray(args),
    "arguments 必须是 JSON 对象",
  );

  const allowed = new Set(Object.keys(tool.inputSchema.properties || {}));
  const unknown = Object.keys(args).filter((key) => !allowed.has(key));
  assertToolValidation(
    unknown.length === 0,
    `工具 ${name} 不支持参数：${unknown.join(", ")}`,
  );

  if (allowed.has("target")) {
    const target = args.target === undefined ? "self" : args.target;
    assertToolValidation(target === "self" || target === "relative", "target 必须是 self 或 relative");
    if (target === "self") {
      assertToolValidation(
        !Object.hasOwn(args, "relative_uid"),
        "target=self 时不允许提供 relative_uid",
      );
    } else {
      assertToolValidation(
        isPositiveRelativeUid(args.relative_uid),
        "target=relative 时必须提供正整数 relative_uid；请先调用 health_relatives",
      );
    }
  }

  if (name === "health_sleep" || name === "health_heart" || name === "health_steps" || name === "health_workouts") {
    parseDays(args);
  }
  if (name === "health_analyze") parseAnalysisArgs(args);
}

function parseDays(args) {
  if (args.days === undefined) return 7;
  if (!Number.isInteger(args.days) || args.days < 1 || args.days > 30) {
    throw new ToolValidationError("days 必须是 1 到 30 的整数");
  }
  return args.days;
}

function currentDateInTimezone(timezone, now = Date.now()) {
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    throw new ToolValidationError("timezone 必须是有效的 IANA 时区，例如 Europe/Berlin");
  }
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(now)).map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function parseAnalysisArgs(args) {
  const days = args.days === undefined ? 30 : args.days;
  const recentDays = args.recent_days === undefined ? 7 : args.recent_days;
  const timezone = args.timezone === undefined ? "UTC" : args.timezone;
  if (!Number.isInteger(days) || days < 8 || days > 30) {
    throw new ToolValidationError("days 必须是 8 到 30 的整数");
  }
  if (!Number.isInteger(recentDays) || recentDays < 3 || recentDays > 14) {
    throw new ToolValidationError("recent_days 必须是 3 到 14 的整数");
  }
  if (recentDays >= days) {
    throw new ToolValidationError("recent_days 必须小于 days");
  }
  if (typeof timezone !== "string" || timezone.length < 1 || timezone.length > 64) {
    throw new ToolValidationError("timezone 必须是 1 到 64 个字符的 IANA 时区");
  }
  currentDateInTimezone(timezone);
  return { days, recentDays, timezone };
}

function parseTarget(args) {
  const target = args.target === undefined ? "self" : args.target;
  if (target !== "self" && target !== "relative") {
    throw new ToolValidationError("target 必须是 self 或 relative");
  }
  if (target === "self") {
    if (Object.hasOwn(args, "relative_uid")) {
      throw new ToolValidationError("target=self 时不允许提供 relative_uid");
    }
    return { target };
  }
  const relativeUid = args.relative_uid;
  const validUid = isPositiveRelativeUid(relativeUid);
  if (!validUid) {
    throw new ToolValidationError("target=relative 时必须提供正整数 relative_uid；请先调用 health_relatives");
  }
  return { target, relative_uid: String(relativeUid) };
}

async function getHealthAnalysis(env, args, fetchImpl) {
  const target = parseTarget(args);
  const { days, recentDays, timezone } = parseAnalysisArgs(args);
  const now = Date.now();
  const [steps, sleep, heartRate] = await Promise.all([
    getHealthSeries(env, "steps", days, target, fetchImpl, now),
    getHealthSeries(env, "sleep", days, target, fetchImpl, now),
    getHealthSeries(env, "heart_rate", days, target, fetchImpl, now),
  ]);
  const currentDate = currentDateInTimezone(timezone, now);
  const analysis = analyzeHealthSeries(
    {
      steps: steps.data,
      sleep: sleep.data,
      heart_rate: heartRate.data,
    },
    {
      currentDate,
      days,
      recentDays,
      nowSeconds: Math.floor(now / 1000),
    },
  );
  const identity = target.target === "self"
    ? { target: "self", user_id: steps.user_id || null }
    : { target: "relative", relative_uid: steps.relative_uid };
  return {
    ...identity,
    period: {
      current_date: currentDate,
      days,
      recent_days: recentDays,
      timezone,
    },
    ...analysis,
    caveats: [
      "当前日步数、距离、calories 和每日心率仅作为部分日展示，不进入完整日基线。",
      "总睡眠时长有效但阶段字段全为 0 时，表示睡眠阶段明细不可用，不表示深睡或浅睡实际为零。",
      "结果基于个人历史摘要，仅供非诊断性趋势参考。",
    ],
  };
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
      throw new ToolPublicError(`小米凭证已过期，请重新扫码登录：${error.message}`);
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
  validateToolArguments(name, args);

  switch (name) {
    case "health_latest":
      return withAuthTracking(env, fetchImpl, () =>
        getLatestHealth(env, parseTarget(args), fetchImpl),
      );
    case "health_analyze":
      return withAuthTracking(env, fetchImpl, () =>
        getHealthAnalysis(env, args, fetchImpl),
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
    case "health_workouts":
      return withAuthTracking(env, fetchImpl, () =>
        getWorkouts(env, parseDays(args), fetchImpl),
      );
    case "health_auth_status":
      return getAuthStatus(env);
    case "health_me":
      return withAuthTracking(env, fetchImpl, () => getHealthMe(env, fetchImpl));
    case "health_relatives":
      return withAuthTracking(env, fetchImpl, () => getRelatives(env, fetchImpl));
    case "health_login_status":
      return getLoginStatus(env, fetchImpl);
    case "health_login_refresh": {
      const token = await exchangePassTokenSession(env, fetchImpl);
      return {
        logged_in: true,
        method: "pass_token",
        user_id: token.user_id,
        session_valid: true,
      };
    }
    case "health_login_start":
      return startQrLogin(env, fetchImpl);
    case "health_login_poll":
      return pollQrLogin(env, fetchImpl);
    default:
      throw new ToolValidationError(`未知工具：${name}`);
  }
}

# mi-health-mcp

## 项目简介

mi-health-mcp 把当前登录小米账号本人及已授权亲友的睡眠、心率和步数，通过 MCP 协议提供给 Hermes 等 MCP 客户端。服务运行在 Cloudflare Workers 上。本项目源自 [wusaki0723/mi-health-mcp](https://github.com/wusaki0723/mi-health-mcp)，保留 GPL-3.0 许可证，并参考 [Misty02600/mi-fitness-python](https://github.com/Misty02600/mi-fitness-python) 与 [shkyyy18/mi_fitness_data_bridge](https://github.com/shkyyy18/mi_fitness_data_bridge) 的接口实现。

## 部署

需要 Node.js 20 或更高版本，以及一个 Cloudflare 账号。

```bash
git clone https://github.com/<your-github-account>/mi-health-mcp.git
cd mi-health-mcp
npm install
npx wrangler login
npx wrangler kv namespace create MI_HEALTH_KV
```

将命令输出的 namespace ID 写入 `wrangler.toml` 的 `kv_namespaces[0].id`。KV namespace ID 是 Cloudflare 资源标识，不是访问凭据；公开仓库必须提交 `wrangler.toml`，以便 Workers Builds 识别 Worker 入口和 binding。Fork 后部署前必须替换为自己账号中的 namespace ID。

然后设置访问令牌并部署：

```bash
npx wrangler secret put AUTH_TOKEN
npx wrangler deploy
```

`AUTH_TOKEN` 的值请使用自己生成的长随机串，不要写进源码、`wrangler.toml` 或 Git。

### passToken 登录

推荐将 Xiaomi Account 浏览器 Cookie 中的 `userId`、`passToken` 和 `deviceId` 作为 Cloudflare Secret 设置。`deviceId` 通常以 `wb_` 开头。Worker 会用它们换取 `sid=miothealth` 的短期健康 API session；原始 `passToken` 不会写入 KV、日志或 MCP 返回。

```bash
npx wrangler secret put XIAOMI_USER_ID
npx wrangler secret put XIAOMI_PASS_TOKEN
npx wrangler secret put XIAOMI_DEVICE_ID
```

也可以在 Cloudflare Dashboard 的 Worker「Settings > Variables and Secrets」中新增同名的 Secret。`XIAOMI_USER_ID` 和 `XIAOMI_PASS_TOKEN` 必须同时设置；`XIAOMI_DEVICE_ID` 可选，设置时应使用取得该 `passToken` 时同一浏览器会话中的 `deviceId`。

passToken 登录已在真实账号上完成端到端验证（2026-09-02：passToken 换取 `miothealth` session、加密查询本人睡眠/心率/步数、KV session 缓存与复用）。session 过期后 Worker 会自动用 Secret 重新换取，无需人工干预；`health_login_status` 报「passToken 无效或已过期（Xiaomi Account code=70016）」时，表示该 passToken 对应的登录会话已被小米作废（例如修改密码、退出登录或账号安全策略），重新从有效登录会话复制 `userId`、`passToken` 和 `deviceId` 并更新 Secret 即可。

KV binding 名必须保持为 `MI_HEALTH_KV`。`AUTH_TOKEN`、`XIAOMI_USER_ID` 和 `XIAOMI_PASS_TOKEN` 必须使用 Cloudflare Secret，不要写入源码、配置文件或 Git。

## Hermes 配置

```yaml
mcp_servers:
  mi_health:
    url: "https://<worker-name>.<account-subdomain>.workers.dev/mcp"
    headers:
      Authorization: "Bearer ${MI_HEALTH_AUTH_TOKEN}"
```

将 URL 替换为你自己部署的 Worker 地址。`MI_HEALTH_AUTH_TOKEN` 的值必须与该 Worker 的 `AUTH_TOKEN` Secret 一致。示例不包含真实凭证。

### Hermes skill

仓库内的 [`skills/mi-health/SKILL.md`](skills/mi-health/SKILL.md)（当前 v1.5.2）负责把“我/本人”和“亲友”请求分流到正确工具，说明紧凑结果的字段含义，并在用户询问健康变化原因时，按同一时间窗口只读对照日志和日历。健康数据是定量测量，日志是实际发生记录，日历是计划记录；不会把日历计划直接当成已完成活动，也不会自动写入或修改日志、日历。仓库公开后，可从原始文件 URL 安装：

```bash
hermes skills install https://raw.githubusercontent.com/<your-github-account>/mi-health-mcp/main/skills/mi-health/SKILL.md
hermes skills list
```

skill 不会自动创建定时任务。需要将它连接到已有任务时，先检查任务及近期执行记录，再按任务 ID 添加：

```bash
hermes cron status
hermes cron list
hermes cron runs <job-id>
hermes cron edit <job-id> --add-skill mi-health
```

定时任务在独立会话中执行，prompt 需要明确查询目标、天数、时区、发送位置和失败时的处理方式。不要在 prompt 中放入任何凭证；定期任务应固定 provider 和 model，避免全局默认值变化后行为改变。

## 使用流程

1. 配置 `XIAOMI_USER_ID` 和 `XIAOMI_PASS_TOKEN` 后调用 `health_login_refresh`；`XIAOMI_DEVICE_ID` 为可选 Secret，用于在需要时指定取得该 `passToken` 的浏览器会话。Worker 会换取并缓存 `miothealth` session；失败时不会删除当前缓存会话。
2. 使用 `health_me` 确认当前账号；查询单项原始摘要时调用 `health_latest`、`health_sleep`、`health_heart`、`health_steps` 或 `health_workouts`，需要趋势分析时优先调用 `health_analyze` 并传入用户当前 IANA 时区。
3. 查询亲友时先调用 `health_relatives`，再传入 `target: "relative"` 和返回的 `relative_uid`。

对于“为什么负荷增加”等原因问题，先完成 `health_analyze`，再只读查询相同日期范围内的日志和日历（若可用）。日志用于核对实际发生的活动，日历用于识别计划安排；二者与健康数据不一致时应明确说明，不能静默合并。

`health_login_start` 和 `health_login_poll` 仅为兼容保留。该二维码流程在部分账号会被 Xiaomi 拒绝并返回 `70036`，小米运动健康 App 也可能提示二维码不受支持；本项目不把它描述为已验证可用的登录方式。

健康查询默认 `target: "self"`，使用本人数据接口，不发送 `relative_uid`；亲友查询必须提供有效的 `relative_uid`，不会自动选择亲友列表第一项。

### MCP tools

- `health_me`：返回当前登录状态和 `user_id`，不返回凭证。
- `health_login_status`：返回当前健康 API session 是否可用及登录方式，不返回凭证。
- `health_login_refresh`：使用小米账号 Secret 强制刷新 session，失败时保留现有缓存会话。
- `health_relatives`：列出可查询亲友的 `relative_uid` 和备注。
- `health_latest`：查询最新的睡眠、心率和步数摘要。
- `health_analyze`：默认查询 30 天，以最近 7 个完整日和此前记录建立个人基线；分析步数、距离、calories、睡眠和每日心率，分离未结束的当日活动，报告缺失日期、同步延迟、睡眠阶段完整性和心率采样质量，输出非诊断性的 robust statistics。
- `health_sleep`：查询最近 1 至 30 天的每日睡眠摘要，每天最多一条。
- `health_heart`：查询最近 1 至 30 天的每日心率统计，不返回全部采样点。
- `health_steps`：查询最近 1 至 30 天的每日步数摘要，每天最多一条。
- `health_workouts`：查询本人最近 1 至 30 天的运动 session 记录（单次运动摘要），仅透传上游提供的字段；暂不支持亲友。
- `health_workout_analyze`：默认 28 天、最近 7 天窗口，分析本人运动 session 的次数、活跃天数、总时长和运动类型，并与此前同宽日历窗口比较；输出非诊断性参考，不构成训练建议。

查询本人时省略 `target` 或显式传入 `{"target":"self"}`。查询亲友时必须传入：

```json
{
  "target": "relative",
  "relative_uid": "...",
  "days": 7
}
```

趋势分析示例：

```json
{
  "target": "self",
  "days": 30,
  "recent_days": 7,
  "timezone": "Europe/Berlin"
}
```

`health_analyze` 不重算健康 API 已返回的日期；`timezone` 只用于识别当前自然日，把当日步数、距离、calories 和每日心率标为 `partial` 并排除在完整日基线之外。睡眠按起床日期视为已完成记录。同一日期存在重复摘要时，分析器会先按有效测量、采样或睡眠阶段完整性、记录时间和稳定键确定性地选择一条。`recent_days` 表示最近的自然日窗口；缺失或因质量不足被排除的日期不会由更早记录补位。距离和 calories 与步数使用同一套个人基线方法（recent、baseline、comparison、mean、median、min、max、q1、q3、mad），对本人和亲友数据一致。结果先返回 `data_quality`：`missing_dates` 表示当天记录缺失，`missing_measurements` 表示记录存在但目标数值为空、非数值或负数（现覆盖 steps、sleep_duration、heart_rate、distance、calories）；两者均按未知处理而不是按 0 处理。结果还会报告最新数据同步延迟、睡眠阶段完整率和心率采样质量。低于完整日采样数中位数 50% 的日期列入 `low_sample_dates`，缺少有效采样数的日期列入 `unknown_sample_dates`；两者都不进入心率趋势。趋势比较使用未舍入的 median、MAD、IQR 和 robust z-score，输出时才舍入；样本不足时返回 `insufficient_data`，不会硬给趋势结论。所有比较均为个人历史摘要，不能用于疾病诊断或用药建议。

每条睡眠记录带有 `sleep_stage_status`：`available` 表示至少一个 deep/light/REM 阶段时长大于 0；`unavailable` 表示总睡眠时长有效但阶段字段全为 0 或缺失；`unknown` 表示没有有效的总睡眠时长，无法判断阶段明细是否可用。总睡眠时长有效但阶段字段全为 0 时，表示睡眠阶段明细不可用，不表示深睡或浅睡实际为零。MCP 不返回记录设备来源：2026 年 8 月对 25 条原始 sleep 记录（13 个 wake 日期，含手机与手环记录日）的核实显示，上游没有可用的 source/device_type 字段，阶段完整性和心率字段也不能识别设备。健康摘要默认不讨论来源；仅在用户询问来源，或用户已明确说明该 wake 日期未佩戴手环、由手机记录时，才把它作为用户提供的背景说明，不能表述为 MCP 检测结果。

### 运动 session 记录（health_workouts）

`health_workouts` 使用 `POST /app/v1/data/get_sport_records_by_time`（依据公开实现 shkyyy18/mi_fitness_data_bridge 与 binglua/mi-fitness-mcp-cn 确认的接口：同域名、同加密请求机制，响应为 `sport_records` 加 `has_more`/`next_key` 分页）。返回按时间排序的单次运动摘要：日期、时间戳、开始/结束时间、时长（`duration_seconds`，上游按秒处理）、`distance`、`calories`、平均/最高心率（来自上游 `avg_hrm`/`max_hrm`）和 `sport_type`（来自上游 `category`/`key`/`sport_type`）。上游缺失的字段直接省略，不填造数据；不返回原始高频传感器流；不把步数日汇总伪装成运动 session；`calories` 只是 Xiaomi 返回的 calories，不解释为 active calories、resting calories 或总能量消耗。`distance` 和 `calories` 按上游返回值透传，不做单位换算。亲友运动查询目前没有已验证的接口，暂不支持；该 endpoint 尚未在本项目的真实账号上验证过，字段含义以公开实现为依据。

### 运动 session 分析（health_workout_analyze）

`health_workout_analyze` 只做一次有界的运动记录查询，把 `days` 天窗口按自然日划分：最近的 `recent_days` 天是 recent 窗口，此前完整、互不重叠的同宽窗口是 baseline（默认 28/7 得到 3 个基线窗口）；完整窗口不足 2 个时比较返回 `insufficient_data`。运动 session 是完整事件，当前自然日的 session 也计入 recent 窗口。同一天多条 session 全部计数（`same_day_multiple_sessions` 提示），不自动合并；缺失或非法字段不计入总量也不转 0，字段覆盖数在 `data_quality` 中报告；`total_distance`/`total_calories` 在无有效值时为 null 而不是 0。`days_since_last_workout` 是距最新已同步 session 的自然日差，与 `sync.lag_hours` 分开报告：设备未同步时不会产生新记录，不能把“没有新记录”说成“没有运动”。比较只看本人历史窗口中位数（ratio 阈值 1.25/0.75），不使用通用运动阈值；不根据心率推断运动强度，不输出训练负荷、恢复评分或运动处方。

## 使用边界

仅供登录你自己的小米账号、查询你已获授权的亲友数据。请勿用于任何侵犯他人隐私或违反小米用户协议的用途。

本人数据使用 `POST /app/v1/data/get_fitness_data_by_time`。中国区查询窗口前后各扩展 18 小时，再按记录的 `zone_offset` 归入日期；缺少 `zone_offset` 时回退到 UTC+8。本人 steps 记录按接口的增量语义逐日汇总；本人 heart 采样点转换为每日统计；sleep 同日优先保留非小睡、持续时间更长、更新时间更新的记录。亲友数据使用 `/app/v1/relatives/*` 的 `daily_report`，同日记录不重复求和。

MCP 返回使用字段白名单，不返回 `AUTH_TOKEN`、`passToken`、`cUserId`、`serviceToken`、`ssecurity` 或 Cookie。请勿提交 `.dev.vars`、`.env`、`wrangler.toml` 或 `.wrangler/`。

## 致谢

- [wusaki0723/mi-health-mcp](https://github.com/wusaki0723/mi-health-mcp)：本项目的直接前身，初始代码由此导入并沿用 GPL-3.0。
- [Misty02600/mi-fitness-python](https://github.com/Misty02600/mi-fitness-python)：`serviceLogin` / `serviceLoginAuth2` / STS 登录链路与亲友接口字段语义的参照。
- [shkyyy18/mi_fitness_data_bridge](https://github.com/shkyyy18/mi_fitness_data_bridge)：确认了 passToken 登录的最小 Cookie 组合，以及 `serviceLogin` 返回的 `location` 必须原样请求（追加参数会使 `sts-hlth.io.mi.com` 拒绝下发 serviceToken）。

## 许可证

本项目采用 [GNU General Public License v3.0](LICENSE)（GPL-3.0），与上游 [Misty02600/mi-fitness-python](https://github.com/Misty02600/mi-fitness-python) 的许可证保持一致。

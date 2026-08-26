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

复制公开模板并将命令输出的 namespace ID 写入本地配置。`wrangler.toml` 已被 Git 忽略，不会提交个人 KV ID：

```bash
cp wrangler.example.toml wrangler.toml
```

然后设置访问令牌并部署：

```bash
npx wrangler secret put AUTH_TOKEN
npx wrangler deploy
```

`AUTH_TOKEN` 的值请使用自己生成的长随机串，不要写进源码、`wrangler.toml` 或 Git。

### passToken 登录

推荐将 Xiaomi Account 的 `userId` 和 `passToken` 作为 Cloudflare Secret 设置。Worker 会用它们换取 `sid=miothealth` 的短期健康 API session；原始 `passToken` 不会写入 KV、日志或 MCP 返回。

```bash
npx wrangler secret put XIAOMI_USER_ID
npx wrangler secret put XIAOMI_PASS_TOKEN
```

也可以在 Cloudflare Dashboard 的 Worker「Settings > Variables and Secrets」中新增同名的 Secret。两个 Secret 必须同时设置，不能写入 `wrangler.toml`。

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

仓库内的 [`skills/mi-health/SKILL.md`](skills/mi-health/SKILL.md) 负责把“我/本人”和“亲友”请求分流到正确工具，并说明紧凑结果的字段含义。仓库公开后，可从原始文件 URL 安装：

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

1. 配置 `XIAOMI_USER_ID` 和 `XIAOMI_PASS_TOKEN` 后调用 `health_login_status`，Worker 会换取或恢复 `miothealth` session。
2. 使用 `health_me` 确认当前账号，再调用 `health_latest`、`health_sleep`、`health_heart` 或 `health_steps` 查询本人数据。
3. 查询亲友时先调用 `health_relatives`，再传入 `target: "relative"` 和返回的 `relative_uid`。

`health_login_start` 和 `health_login_poll` 仅为兼容保留。该二维码流程在部分账号会被 Xiaomi 拒绝并返回 `70036`，小米运动健康 App 也可能提示二维码不受支持；本项目不把它描述为已验证可用的登录方式。

健康查询默认 `target: "self"`，使用本人数据接口，不发送 `relative_uid`；亲友查询必须提供有效的 `relative_uid`，不会自动选择亲友列表第一项。

### MCP tools

- `health_me`：返回当前登录状态和 `user_id`，不返回凭证。
- `health_login_status`：返回当前健康 API session 是否可用及登录方式，不返回凭证。
- `health_relatives`：列出可查询亲友的 `relative_uid` 和备注。
- `health_latest`：查询最新的睡眠、心率和步数摘要。
- `health_sleep`：查询最近 1 至 30 天的每日睡眠摘要，每天最多一条。
- `health_heart`：查询最近 1 至 30 天的每日心率统计，不返回全部采样点。
- `health_steps`：查询最近 1 至 30 天的每日步数摘要，每天最多一条。

查询本人时省略 `target` 或显式传入 `{"target":"self"}`。查询亲友时必须传入：

```json
{
  "target": "relative",
  "relative_uid": "...",
  "days": 7
}
```

## 使用边界

仅供登录你自己的小米账号、查询你已获授权的亲友数据。请勿用于任何侵犯他人隐私或违反小米用户协议的用途。

本人数据使用 `POST /app/v1/data/get_fitness_data_by_time`。中国区查询窗口前后各扩展 18 小时，再按记录的 `zone_offset` 归入日期；缺少 `zone_offset` 时回退到 UTC+8。本人 steps 记录按接口的增量语义逐日汇总；本人 heart 采样点转换为每日统计；sleep 同日优先保留非小睡、持续时间更长、更新时间更新的记录。亲友数据使用 `/app/v1/relatives/*` 的 `daily_report`，同日记录不重复求和。

MCP 返回使用字段白名单，不返回 `AUTH_TOKEN`、`passToken`、`cUserId`、`serviceToken`、`ssecurity` 或 Cookie。请勿提交 `.dev.vars`、`.env`、`wrangler.toml` 或 `.wrangler/`。

## 许可证

本项目采用 [GNU General Public License v3.0](LICENSE)（GPL-3.0），与上游 [Misty02600/mi-fitness-python](https://github.com/Misty02600/mi-fitness-python) 的许可证保持一致。

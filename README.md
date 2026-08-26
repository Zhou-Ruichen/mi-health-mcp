# mi-health-mcp

## 项目简介

mi-health-mcp 把当前登录小米账号本人及已授权亲友的睡眠、心率和步数，通过 MCP 协议暴露给 RikkaHub 等 LLM 客户端。服务运行在 Cloudflare Workers 上，无需自建服务器，可在 Cloudflare 免费额度内使用。本项目基于 [Misty02600/mi-fitness-python](https://github.com/Misty02600/mi-fitness-python) 的接口逆向成果改写为 Cloudflare Worker + MCP 服务，感谢上游。

## 一键部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/wusaki0723/mi-health-mcp)

部署流程要求绑定 Cloudflare KV。如果按钮流程提示创建或选择 KV namespace，请按引导完成，并确保绑定名为 `MI_HEALTH_KV`。

### 按钮不灵时的手动部署

需要 Node.js 20 或更高版本，以及一个 Cloudflare 账号。

```bash
git clone https://github.com/wusaki0723/mi-health-mcp.git
cd mi-health-mcp
npm install
npx wrangler login
npx wrangler kv namespace create MI_HEALTH_KV
```

将命令输出的 namespace ID 填入 `wrangler.toml`，替换 `your-kv-namespace-id`。然后设置访问令牌并部署：

```bash
npx wrangler secret put AUTH_TOKEN
npx wrangler deploy
```

`AUTH_TOKEN` 的值请使用自己生成的长随机串，不要写进源码、`wrangler.toml` 或 Git。

### passToken 登录

如果小米扫码登录不可用，可以将 Xiaomi Account 的 `userId` 和 `passToken` 作为 Cloudflare Secret 设置。Worker 会用它们换取 `sid=miothealth` 的短期健康 API session；原始 `passToken` 不会写入 KV 或通过 MCP 返回。

```bash
npx wrangler secret put XIAOMI_USER_ID
npx wrangler secret put XIAOMI_PASS_TOKEN
```

也可以在 Cloudflare Dashboard 的 Worker「Settings > Variables and Secrets」中新增同名的 Secret。两个 Secret 必须同时设置，不能写入 `wrangler.toml`。

## 部署后配置

1. 创建 KV namespace：

   ```bash
   npx wrangler kv namespace create MI_HEALTH_KV
   ```

2. 将命令输出的 namespace ID 填入 `wrangler.toml` 的 `[[kv_namespaces]]`，替换 `your-kv-namespace-id`，然后重新部署。通过一键部署时，也可以在按钮流程中按引导创建并绑定 KV。
3. 交互式设置 MCP 鉴权令牌。令牌请自行生成一个长随机串：

   ```bash
   npx wrangler secret put AUTH_TOKEN
   ```

4. 配置有变化时重新部署：

   ```bash
   npx wrangler deploy
   ```

KV binding 名必须保持为 `MI_HEALTH_KV`。

## 客户端配置

在 RikkaHub 中打开「设置 > MCP > 新建连接 > Streamable HTTP」，填写：

- URL：`https://<你的域名>/mcp`
- 自定义 Header：`Authorization: Bearer <你的 token>`

其中 `<你的 token>` 必须与部署时设置的 `AUTH_TOKEN` 完全一致。

## 使用流程

1. 客户端先调用 `health_login_start`，取得 `loginUrl`。
2. 使用任意二维码工具把 `loginUrl` 渲染成二维码。
3. 用小米运动健康 App 扫码并确认登录。
4. 客户端轮调 `health_login_poll`，直到返回 `success`。
5. 登录成功后，使用 `health_me` 确认当前账号，再使用 `health_latest`、`health_sleep`、`health_heart` 或 `health_steps` 查询本人数据。
6. 要查询亲友时，先调用 `health_relatives`，再传入 `target: "relative"` 和返回的 `relative_uid`。

如果配置了 `XIAOMI_USER_ID` 和 `XIAOMI_PASS_TOKEN`，可先调用 `health_login_status`。它会自动换取或恢复 `miothealth` session；session 过期后，健康查询也会自动换取一次并重试。二维码登录仍可作为未配置 Secret 时的 fallback。

Worker 不生成二维码图片。健康查询默认 `target: "self"`，使用扫码登录账号的本人数据接口；不会把登录账号当作亲友，也不会自动选择亲友列表的第一项。

### MCP tools

- `health_me`：返回当前登录状态和 `user_id`，不返回凭证。
- `health_login_status`：返回当前健康 API session 是否可用及登录方式，不返回凭证。
- `health_relatives`：列出可查询亲友的 `relative_uid` 和备注。
- `health_latest`：查询最新的睡眠、心率和步数。
- `health_sleep`、`health_heart`、`health_steps`：查询最近 1 至 30 天的对应记录。

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

## 许可证

本项目采用 [GNU General Public License v3.0](LICENSE)（GPL-3.0），与上游 [Misty02600/mi-fitness-python](https://github.com/Misty02600/mi-fitness-python) 的许可证保持一致。

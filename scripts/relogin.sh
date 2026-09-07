#!/usr/bin/env bash
# 小米账号 passToken 失效（70016）时的一键恢复脚本。
# 打开 headed 浏览器让用户扫码登录，读取该会话的 userId/passToken/deviceId，
# 批量更新 Cloudflare Secret 并验证 MCP 恢复。凭证全程不落终端输出。
#
# 依赖：agent-browser（npm i -g agent-browser）、wrangler（仓库内 npx）、python3。
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORKER_URL="${MI_HEALTH_WORKER_URL:-https://mi-health-mcp.zhourccc.workers.dev/mcp}"
AUTH_TOKEN="${MI_HEALTH_MCP_AUTH_TOKEN:-}"
if [ -z "$AUTH_TOKEN" ] && [ -f "$HOME/.hermes/.env" ]; then
  AUTH_TOKEN=$(grep "^MI_HEALTH_MCP_AUTH_TOKEN=" "$HOME/.hermes/.env" | cut -d= -f2- | tr -d '"' | tr -d "'")
fi
SESSION="mi-health-relogin-$(date +%s)"
SECRETS_FILE=$(mktemp /tmp/mi-secrets.XXXXXX.json)
trap 'agent-browser --session "$SESSION" close >/dev/null 2>&1 || true; rm -f "$SECRETS_FILE"' EXIT

command -v agent-browser >/dev/null 2>&1 || { echo "✗ 缺少 agent-browser：npm i -g agent-browser && agent-browser install"; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "✗ 缺少 python3"; exit 1; }

extract_cookie_names() {
  agent-browser --session "$SESSION" cookies --json 2>/dev/null | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    cookies = d['data']['cookies']
except Exception:
    sys.exit(0)
if isinstance(cookies, dict):
    cookies = cookies.get('cookies', [])
names = {c.get('name') for c in cookies if isinstance(c, dict)}
print(' '.join(sorted(names)))
"
}

echo "==> 打开小米账号登录窗口"
agent-browser --session "$SESSION" --headed open "https://account.xiaomi.com/" >/dev/null
sleep 2

# 密码页时切换到扫码页；已登录（账号页）则跳过
QR_REF=$(agent-browser --session "$SESSION" snapshot -i 2>/dev/null | grep "扫码登录" | grep -o 'e[0-9]\+' | head -1 || true)
if [ -n "$QR_REF" ]; then
  agent-browser --session "$SESSION" click "@${QR_REF}" >/dev/null 2>&1 || true
  echo "==> 已切换到扫码登录；请用手机 App 扫描窗口中的二维码"
else
  echo "==> 窗口已是登录态或扫码页"
fi

echo "==> 等待登录完成（最长 4 分钟）..."
LOGGED_IN=""
for _ in $(seq 1 48); do
  NAMES=$(extract_cookie_names)
  if echo "$NAMES" | grep -qw userId && echo "$NAMES" | grep -qw passToken; then
    LOGGED_IN=1
    break
  fi
  sleep 5
done
[ -n "$LOGGED_IN" ] || { echo "✗ 4 分钟内未完成登录；重新运行本脚本再试"; exit 1; }

agent-browser --session "$SESSION" cookies --json 2>/dev/null | python3 -c "
import json, sys
d = json.load(sys.stdin)
cookies = d['data']['cookies']
if isinstance(cookies, dict):
    cookies = cookies.get('cookies', [])
byname = {c['name']: c['value'] for c in cookies}
needed = ['userId', 'passToken', 'deviceId']
missing = [n for n in needed if not byname.get(n)]
assert not missing, f'缺少 cookie: {missing}'
secrets = {
    'XIAOMI_USER_ID': byname['userId'],
    'XIAOMI_PASS_TOKEN': byname['passToken'],
    'XIAOMI_DEVICE_ID': byname['deviceId'],
}
with open('$SECRETS_FILE', 'w') as f:
    json.dump(secrets, f)
print(f"==> 已提取凭证（userId 尾号 {byname['userId'][-4:]}，deviceId 前缀 {byname['deviceId'][:3]}）")
"

cd "$REPO_DIR"
npx wrangler secret bulk "$SECRETS_FILE" >/dev/null
echo "==> Cloudflare Secret 已更新，等待部署生效"
sleep 10

if [ -n "$AUTH_TOKEN" ]; then
  RESULT=$(curl -s -m 30 -X POST "$WORKER_URL" \
    -H "Authorization: Bearer $AUTH_TOKEN" -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"health_login_status","arguments":{}}}' \
    | python3 -c "import json,sys; print(json.load(sys.stdin)['result']['content'][0]['text'])")
  echo "==> health_login_status: $RESULT"
  echo "$RESULT" | grep -q '"logged_in":true' && echo "✓ 自动登录已恢复" || { echo "✗ 登录仍失败，检查上面的返回"; exit 1; }
else
  echo "==> 未找到 MI_HEALTH_MCP_AUTH_TOKEN，跳过线上验证；请手动调用 health_login_status 确认"
fi

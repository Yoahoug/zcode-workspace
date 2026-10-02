#!/usr/bin/env bash
# 青龙面板管理技能自检：只做只读检查，不打印任何凭据。
set -u
PANEL="${QL_PANEL_URL:-http://127.0.0.1:15700}"

echo "== 1) Node（需要 >= 22.12）"
node -v 2>/dev/null || echo "缺少 node"

echo "== 2) 远程 CLI"
if command -v ql >/dev/null 2>&1; then
  echo "ql → $(command -v ql)"
  case "$(head -c 200 "$(command -v ql)" 2>/dev/null)" in
    *qinglong-cli*|*ql.js*) echo "看起来是远程 npm CLI（可用 ql --help 复核）";;
    *) echo "注意：无法确认它是不是 @whyour/qinglong-cli，用 ql --help 复核";;
  esac
else
  echo "未安装：npm install -g @whyour/qinglong-cli"
fi

echo "== 3) 面板可达性（未认证应为 401）"
code=$(curl -sS -m 10 -o /dev/null -w '%{http_code}' "$PANEL/open/health" 2>/dev/null || echo "000")
echo "$PANEL/open/health → HTTP $code"
[ "$code" = "200" ] || [ "$code" = "401" ] || echo "面板不可达或响应异常，先查容器：docker ps | grep qinglong"

echo "== 4) 登录状态"
ql auth status --json 2>&1 | head -c 300; echo

echo "== 5) 路由数量（应为 143，可随版本变化）"
ql api routes --json 2>/dev/null | python3 -c "import sys,json;d=json.load(sys.stdin);r=d.get('data') or d;print('routes:',len(r))" 2>/dev/null || echo "无法读取路由表（可能未登录）"

echo "== 6) 本机容器"
docker ps --filter name='^qinglong$' --format '{{.Names}}  {{.Image}}  {{.Status}}  {{.Ports}}' 2>/dev/null || echo "无法访问 docker"

#!/bin/bash
# 启动开发环境（前端 + 后端）
# 用法：bash scripts/start-dev.sh
#
# 说明：WorkBuddy 宿主会注入 NODE_OPTIONS 指向旧版 shim 脚本路径，
# 该路径在新版本中已不存在，会导致 node 启动报 EPERM / ENOENT。
# 这里在启动前清空该变量，避免子进程继承。

set -e
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export NODE_OPTIONS=""

echo "项目根目录: $ROOT"

if [ ! -d "$ROOT/node_modules" ]; then
  echo "未安装依赖，正在安装..."
  npm install
fi

# 后端
(cd "$ROOT/server" && node src/index.js) &
SERVER_PID=$!

# 前端
(cd "$ROOT/client" && node ../node_modules/vite/bin/vite.js --host) &
CLIENT_PID=$!

echo ""
echo "服务已启动："
echo "  前端  http://localhost:5173/"
echo "  后端  http://localhost:4000/api/health"
echo ""
echo "按 Ctrl+C 停止服务（PID: $SERVER_PID / $CLIENT_PID）"

trap 'kill $SERVER_PID $CLIENT_PID 2>/dev/null' INT TERM
wait $SERVER_PID $CLIENT_PID

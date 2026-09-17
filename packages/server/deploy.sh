#!/usr/bin/env bash
#
# 裸机部署脚本：本地构建 server（esbuild 打成自包含 bundle），推送产物到服务器，
# 用 systemd 常驻。
#
# 依赖：本地需有 pnpm + node（构建用）；服务器只需 nvm 装好的 node>=20 + systemd，
# **无需 npm/pnpm**（bundle 已把全部依赖打进 dist，服务器零依赖安装）。
#
# 用法：
#   1. 填好下方「部署目标」里的变量（REMOTE 是 ssh config 里的 Host 别名）；
#   2. 确保 packages/server/.env.production 已就绪（会被推成服务器上的 .env）；
#   3. 运行：./deploy.sh
#
# 回滚（部署前已把服务器上的 dist 备份到 $DEPLOY_DIR/backups/）：
#   ssh $REMOTE "cd $DEPLOY_DIR \
#     && tar xzf backups/dist-<时间戳>.tar.gz \
#     && sudo systemctl restart $SERVICE_NAME"
# 控制台静态回滚（$CONSOLE_DIR/backups/）：
#   ssh $REMOTE "cd $CONSOLE_DIR && tar xzf backups/dist-<时间戳>.tar.gz"
set -euo pipefail

# ── 部署目标（部署前填写）──────────────────────────────────────────
REMOTE="crewai"                    # ssh config 里的 Host 别名（User/HostName/Port 在 ~/.ssh/config 配好）
DEPLOY_DIR="/usr/local/l2h/vscode-db-server"  # 服务器上的绝对部署目录
SERVICE_NAME="dbclient-server"     # systemd 服务名
HEALTH_URL="http://localhost:3000/health/ready"
LOG_FILE="${DEPLOY_DIR}/logs/server.log"
# ────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# 控制台静态目录：与 server 的 consoleDistDir() 默认（`<cwd>/../console-ui/dist`）一致。
CONSOLE_DIR="$(dirname "$DEPLOY_DIR")/console-ui"
CONSOLE_SRC="$REPO_ROOT/packages/console-ui"

echo "==> [1/6] 清理并构建 server -> packages/server/dist"
rm -rf "$SCRIPT_DIR/dist"
(cd "$REPO_ROOT" && pnpm --filter @db-client/server build)

echo "==> [2/6] 清理并构建 console-ui -> packages/console-ui/dist"
rm -rf "$CONSOLE_SRC/dist"
# 控制台基路径：迁到 devkit.l2hi.com/db（CONSOLE_BASE=/db/）；留空则根路径。
(cd "$REPO_ROOT" && CONSOLE_BASE="${CONSOLE_BASE:-}" pnpm --filter @db-client/console-ui build)

echo "==> [3/6] 推送 server 产物到 ${REMOTE}:${DEPLOY_DIR}"
ssh "$REMOTE" "mkdir -p '$DEPLOY_DIR/backups'"
# 备份当前版本（首次部署 dist 不存在，tar 失败时静默跳过）
ssh "$REMOTE" \
  "cd '$DEPLOY_DIR' && tar czf \"backups/dist-\$(date +%Y%m%d%H%M%S).tar.gz\" dist 2>/dev/null || true"

# 保证移除的路由和管理页面产物不会留在目标服务器。
# 先解到 staging，成功后再原子替换 dist；tar 流中断时旧 dist 仍在（不再先删导致 404）。
ssh "$REMOTE" "rm -rf '$DEPLOY_DIR/.dist.staging' && mkdir -p '$DEPLOY_DIR/.dist.staging'"
tar czf - -C "$SCRIPT_DIR" dist | ssh "$REMOTE" "tar xzf - -C '$DEPLOY_DIR/.dist.staging'"
ssh "$REMOTE" "cd '$DEPLOY_DIR' \
  && rm -rf dist.old public \
  && if [ -d dist ]; then mv dist dist.old; fi \
  && mv .dist.staging/dist dist \
  && rm -rf dist.old .dist.staging"

# 服务端 dotenv 只读工作目录下的 .env
scp "$SCRIPT_DIR/.env.production" "$REMOTE:$DEPLOY_DIR/.env"

echo "==> [4/6] 推送 console-ui 产物到 ${REMOTE}:${CONSOLE_DIR}/dist"
ssh "$REMOTE" "mkdir -p '$CONSOLE_DIR/backups'"
# 备份当前控制台静态（首次不存在时静默跳过）
ssh "$REMOTE" \
  "cd '$CONSOLE_DIR' && tar czf \"backups/dist-\$(date +%Y%m%d%H%M%S).tar.gz\" dist 2>/dev/null || true"
# 先解到 staging，成功后再原子替换 dist（tar 流中断不丢旧静态）。
ssh "$REMOTE" "rm -rf '$CONSOLE_DIR/.dist.staging' && mkdir -p '$CONSOLE_DIR/.dist.staging'"
tar czf - -C "$CONSOLE_SRC" dist | ssh "$REMOTE" "tar xzf - -C '$CONSOLE_DIR/.dist.staging'"
ssh "$REMOTE" "cd '$CONSOLE_DIR' \
  && rm -rf dist.old \
  && if [ -d dist ]; then mv dist dist.old; fi \
  && mv .dist.staging/dist dist \
  && rm -rf dist.old .dist.staging"

echo "==> [5/6] 写 systemd 服务"
# bundle 自包含全部依赖，服务器无需 npm install（不再推 package.json / 装 node_modules）。
# 只需定位 node 可执行文件用于 systemd ExecStart。
NODE_BIN="$(ssh "$REMOTE" '. "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 && command -v node')"
if [[ -z "$NODE_BIN" ]]; then
  echo "错误：服务器上找不到 node（需 node>=20）" >&2
  exit 1
fi

# 独立日志目录：systemd 把 stdout/stderr append 到该文件（journalctl 仍保留一份）。
ssh "$REMOTE" "sudo mkdir -p '$(dirname "$LOG_FILE")'"

ssh "$REMOTE" "sudo tee /etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=DB Client sync server
After=network.target

[Service]
Type=simple
WorkingDirectory=${DEPLOY_DIR}
ExecStart=${NODE_BIN} dist/index.cjs
Restart=on-failure
RestartSec=3
Environment=NODE_ENV=production
StandardOutput=append:${LOG_FILE}
StandardError=append:${LOG_FILE}

[Install]
WantedBy=multi-user.target
EOF

echo "==> [6/6] 重启服务并健康检查"
ssh "$REMOTE" \
  "sudo systemctl daemon-reload \
   && sudo systemctl enable --now '$SERVICE_NAME' \
   && sudo systemctl restart '$SERVICE_NAME'"
ssh "$REMOTE" "sleep 1; systemctl --no-pager --full status '$SERVICE_NAME' || true"
ssh "$REMOTE" "curl -sf '$HEALTH_URL' && echo '  <- /health OK'"
# 静态资源健康检查：控制台 shell 可访问（dist 缺失/损坏时 fail-visible）。
ssh "$REMOTE" "curl -sf 'http://localhost:3000/console/' >/dev/null && echo '  <- console static OK'"

echo "部署完成"

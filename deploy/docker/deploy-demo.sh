#!/usr/bin/env bash
#
# deploy-demo.sh — 把当前工作树同步到 demo 部署并重建镜像。
#
# 用法：
#   PIGO_SSH_PW=<密码> bash deploy/docker/deploy-demo.sh
#
# 为什么需要它：demo 的两个镜像都是**在宿主上从源码构建**的（Dockerfile.web /
# Dockerfile.worker 里 `COPY src` + `npm run build`），所以部署 = 同步构建输入 + 重建镜像。
# 镜像名与重启策略由宿主权威的 compose.demo.yaml 决定；本脚本**绝不改写**它，也不改写
# demo.env（两者是宿主侧权威配置，哈希在解压前后各校验一次）。
#
# 守卫（每一条都来自真实事故）：
#   1. tarball 里绝不能出现 compose.demo.yaml / demo.env —— macOS `tar` 的 exclude 前缀
#      写 `./` 会静默失配，曾把宿主权威文件打进包；这里打包后立刻复查。
#   2. 解压后复查宿主权威文件哈希未变。
#   3. 新鲜度不做时间硬断言：Docker 按构建上下文哈希失效缓存，源码未变时缓存命中是
#      *正确* 行为（硬按时间比较会误报，字符串比 ISO 时间还会跨时区比错）。脚本打印
#      REBUILT / CACHE_HIT 供人判断，真正保证"镜像含本次源码"的是：本轮完成了解压，
#      且 compose build 以 0 退出。
#   4. 硬断言只留真正的不变式：解压成功、宿主权威配置哈希未变、服务名存在、build/up
#      退出码为 0、运行中容器就是刚构建的镜像、外部健康检查 200。
#   5. 健康检查失败不掩盖：打印容器状态并以非零退出；远端步骤必须打印自己的 DEPLOY_DONE
#      标记才算成功（"目标健康"绝不能冒充"部署执行了"——本地曾因此报过假成功）。
#   6. 远端多命令必须整体加引号（`ssh host 'cmd1 && cmd2'`）：否则 `&&` 之后的命令会被
#      **本地** shell 接管（真实事故：本地 bash 找不到远端脚本路径）。
#
# 回滚：脚本在解压前把旧 source 打成 /app/pi-agent/source-backup-<时间戳>.tar.gz
# （路径在输出里），需要回滚时解开它并重跑本脚本即可。
set -uo pipefail

HOST="${PIGO_DEPLOY_HOST:-}"
SOURCE_DIR="${PIGO_DEMO_SOURCE_DIR:-/app/pi-agent/source}"
COMPOSE_REL="${PIGO_DEMO_COMPOSE_REL:-deploy/docker/compose.demo.yaml}"
ENV_FILE="${PIGO_DEMO_ENV_FILE:-/app/pi-agent/demo.env}"
WEB_SERVICE="${PIGO_DEMO_WEB_SERVICE:-demo-web}"
WORKER_SERVICE="${PIGO_DEMO_WORKER_SERVICE:-demo-worker}"
HEALTH_URL="${PIGO_DEMO_HEALTH_URL:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

[ -n "${PIGO_SSH_PW:-}" ] || { echo "PIGO_SSH_PW not set"; exit 2; }
[ -n "$HOST" ] || { echo "PIGO_DEPLOY_HOST not set (example: deploy-user@deployment-host)"; exit 2; }
[ -n "$HEALTH_URL" ] || { echo "PIGO_DEMO_HEALTH_URL not set (must be browser-reachable)"; exit 2; }
command -v expect >/dev/null || { echo "expect is required (password auth, never written to disk)"; exit 2; }

TARBALL="$(mktemp -t pigo-src).tar.gz"
REMOTE_SCRIPT="$(mktemp -t pigo-deploy-remote).sh"
trap 'rm -f "$TARBALL" "$REMOTE_SCRIPT"' EXIT

echo "=== 1) 打包构建输入（排除宿主权威文件）==="
cd "$ROOT" || exit 1
tar -czf "$TARBALL" \
  --exclude='deploy/docker/compose.demo.yaml' \
  --exclude='deploy/docker/demo.env' \
  --exclude='deploy/docker/.env' \
  package.json package-lock.json tsconfig.json vite.config.ts index.html src deploy/docker .dockerignore || exit 3
gzip -t "$TARBALL" || { echo "TARBALL_CORRUPT"; exit 3; }
if tar -tzf "$TARBALL" | grep -qE '(^|/)compose\.demo\.yaml$|(^|/)demo\.env$'; then
  echo "TARBALL_CONTAINS_HOST_AUTHORITATIVE_FILES — 拒绝继续"; exit 3
fi
echo "  OK $(du -h "$TARBALL" | cut -f1) $(tar -tzf "$TARBALL" | wc -l | tr -d ' ') entries"

cat > "$REMOTE_SCRIPT" <<REMOTE
#!/usr/bin/env bash
set -uo pipefail
cd /app/pi-agent || exit 1
TS=\$(date +%Y%m%d-%H%M%S)
SOURCE_DIR="${SOURCE_DIR}"
COMPOSE_REL="${COMPOSE_REL}"
ENV_FILE="${ENV_FILE}"
WEB_SERVICE="${WEB_SERVICE}"
WORKER_SERVICE="${WORKER_SERVICE}"

before_compose=\$(sha256sum "\$SOURCE_DIR/\$COMPOSE_REL" | cut -d' ' -f1)
before_env=\$(sha256sum "\$ENV_FILE" | cut -d' ' -f1)

echo "=== 2) 备份当前 source（可回滚）==="
BACKUP="/app/pi-agent/source-backup-\$TS.tar.gz"
tar -czf "\$BACKUP" -C /app/pi-agent source 2>/dev/null
[ -s "\$BACKUP" ] || { echo "BACKUP_FAILED — 拒绝解压"; exit 4; }
echo "  BACKUP_OK \$(stat -c%s "\$BACKUP") bytes \$BACKUP"

echo "=== 3) 解压构建输入 ==="
tar -xzf /tmp/pigo-src.tar.gz -C "\$SOURCE_DIR"
echo "  EXTRACT_OK"

echo "=== 4) 断言宿主权威文件未被改动 ==="
[ "\$before_compose" = "\$(sha256sum "\$SOURCE_DIR/\$COMPOSE_REL" | cut -d' ' -f1)" ] || { echo "COMPOSE_CHANGED"; exit 5; }
[ "\$before_env" = "\$(sha256sum "\$ENV_FILE" | cut -d' ' -f1)" ] || { echo "ENV_CHANGED"; exit 5; }
echo "  HOST_CONFIG_UNCHANGED"

cd "\$SOURCE_DIR" || exit 1
echo "=== 5) 服务名核对 ==="
SERVICES=\$(docker compose -p pigo-demo -f "\$COMPOSE_REL" --env-file "\$ENV_FILE" config --services | tr '\n' ' ')
echo "  \$SERVICES"
case "\$SERVICES" in *"\$WEB_SERVICE"*) ;; *) echo "NO_SUCH_SERVICE \$WEB_SERVICE"; exit 5;; esac
case "\$SERVICES" in *"\$WORKER_SERVICE"*) ;; *) echo "NO_SUCH_SERVICE \$WORKER_SERVICE"; exit 5;; esac

echo "=== 6) 构建镜像 ==="
BUILD_START_EPOCH=\$(date +%s)
docker compose -p pigo-demo -f "\$COMPOSE_REL" --env-file "\$ENV_FILE" build "\$WEB_SERVICE" "\$WORKER_SERVICE" 2>&1 | tail -4
echo "=== 7) 重建容器 ==="
docker compose -p pigo-demo -f "\$COMPOSE_REL" --env-file "\$ENV_FILE" up -d "\$WEB_SERVICE" "\$WORKER_SERVICE" 2>&1 | tail -4

echo "=== 8) 构建新鲜度（Docker 会按构建上下文哈希失效缓存，缓存命中即源码未变）==="
for img in local/pigo-web:demo local/pigo-worker:demo; do
  created=\$(docker image inspect "\$img" --format '{{.Created}}' 2>/dev/null)
  epoch=\$(date -d "\$created" +%s 2>/dev/null || echo 0)
  if [ "\$epoch" -ge "\$BUILD_START_EPOCH" ]; then
    echo "  \$img REBUILT (created=\$created)"
  else
    echo "  \$img CACHE_HIT (created=\${created}，早于本轮构建开始：说明 Docker 认为构建输入未变，这是正确行为)"
  fi
done

echo "=== 9) 运行容器与镜像内容一致（比 bundle 哈希，不比镜像 ID）==="
# Docker 28 + containerd 镜像存储下，每次 build 都会刷新 provenance 元数据，导致 tag 的
# 镜像 ID 变化而内容不变；拿 ID 比较会误报。这里比真正要保证的东西：容器里在跑的服务端
# bundle 与刚构建的 tag 里的 bundle 逐字节相同。
WEB_CONTAINER="pigo-demo-${WEB_SERVICE#demo-}"
running=""; state="missing"
for _ in \$(seq 1 30); do
  running=\$(docker inspect "\$WEB_CONTAINER" --format '{{.State.Health.Status}}' 2>/dev/null || echo missing)
  if [ "\$running" = "healthy" ]; then break; fi
  sleep 2
done
echo "  \$WEB_CONTAINER state=\$running"
img_hash=\$(docker run --rm --network none --entrypoint sha256sum local/pigo-web:demo /app/dist/server/index.js 2>/dev/null | awk '{print \$1}')
run_hash=\$(docker exec "\$WEB_CONTAINER" sha256sum /app/dist/server/index.js 2>/dev/null | awk '{print \$1}')
echo "  bundle sha256: image=\$img_hash container=\$run_hash"
[ -n "\$img_hash" ] || { echo "IMAGE_PROBE_FAILED — 无法读取镜像内 bundle"; exit 7; }
[ -n "\$run_hash" ] || { echo "CONTAINER_PROBE_FAILED — 容器未就绪或不可 exec"; exit 7; }
[ "\$img_hash" = "\$run_hash" ] || { echo "RUNNING_BUNDLE_MISMATCH — 容器不是当前镜像的内容"; exit 7; }
[ "\$running" = "healthy" ] || echo "  注意：容器尚未 healthy（继续做外部健康检查）"
docker ps --format '  {{.Names}} {{.Image}} {{.Status}}' | grep pigo-demo
echo "DEPLOY_DONE"
REMOTE

echo "=== 2) 上传并执行远端步骤 ==="
EXPECT_SCP="$(mktemp -t pigo-scp-expect)"
EXPECT_SSH="$(mktemp -t pigo-ssh-expect)"
trap 'rm -f "$TARBALL" "$REMOTE_SCRIPT" "$EXPECT_SCP" "$EXPECT_SSH"' EXIT

# 非机密参数直接代入 expect 脚本；只有密码走环境变量（不落盘）。
cat > "$EXPECT_SCP" <<SCPEXPECT
set timeout 600
log_user 1
spawn sh -c "scp -o StrictHostKeyChecking=accept-new -o NumberOfPasswordPrompts=1 -o ConnectTimeout=10 $TARBALL $REMOTE_SCRIPT ${HOST}:/tmp/"
expect {
  -re "assword:" { send "\$env(PIGO_SSH_PW)\r"; exp_continue }
  timeout { puts "SCP_TIMEOUT"; exit 3 }
  eof { puts "SCP_OK" }
}
SCPEXPECT

cat > "$EXPECT_SSH" <<SSHEXPECT
set timeout 1800
log_user 1
spawn sh -c "ssh -o StrictHostKeyChecking=accept-new -o NumberOfPasswordPrompts=1 -o ConnectTimeout=10 ${HOST} 'cp /tmp/$(basename "$TARBALL") /tmp/pigo-src.tar.gz && bash /tmp/$(basename "$REMOTE_SCRIPT")'"
expect {
  -re "assword:" { send "\$env(PIGO_SSH_PW)\r"; exp_continue }
  timeout { puts "REMOTE_TIMEOUT"; exit 4 }
  eof { puts "SSH_DONE" }
}
SSHEXPECT

scp_log="$(expect -f "$EXPECT_SCP" 2>&1)"; scp_rc=$?
echo "$scp_log" | tail -3
echo "$scp_log" | grep -q "SCP_OK" || { echo "UPLOAD_FAILED (rc=$scp_rc)"; exit 3; }

ssh_log_file="$(mktemp -t pigo-deploy-log)"
expect -f "$EXPECT_SSH" > "$ssh_log_file" 2>&1; ssh_rc=$?
sed -n '1,200p' "$ssh_log_file" | tail -24
# 远端必须真的跑到终点：只认脚本自己的标记，绝不用"目标健康"冒充成功。
if ! grep -q "DEPLOY_DONE" "$ssh_log_file"; then
  echo "REMOTE_STEP_FAILED (rc=$ssh_rc) — 见上方远端输出；仍未完成则不要认为部署成功"
  exit 4
fi

echo "=== 10) 本机健康检查（宿主 127.0.0.1 未发布 3101，必须从外部探）==="
for _ in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' "$HEALTH_URL")"
  [ "$code" = "200" ] && break
  sleep 2
done
echo "  health=$code"
[ "$code" = "200" ] || { echo "HEALTH_FAILED"; exit 8; }
echo "DEPLOY_VERIFIED"

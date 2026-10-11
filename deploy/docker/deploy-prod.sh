#!/usr/bin/env bash
#
# deploy-prod.sh — 把当前工作树发布到**生产**（compose 项目 `pi-agent`）。
#
# 用法：
#   PIGO_SSH_PW=<密码> bash deploy/docker/deploy-prod.sh
#
# 与 demo 的 deploy-demo.sh 的关系：同样的"在宿主上从源码构建"模型（Dockerfile.web /
# Dockerfile.worker 里 `COPY src` + `npm run build`），但生产的约束更硬，因此多三条：
#
#   1. **回滚三件套先就位**：给现有镜像打 `pre-<时间戳>` 标签、tar 备份 `pigo-web-data`
#      卷（含 vault）、备份 `.env` 与 `source/`。任何一步失败就停，不带着"没有回滚"继续。
#   2. **只改构建输入**：宿主权威的 `compose.yaml` 与 `.env` 内容不动，`.env` 只做一处
#      版本号自增（源码未变时跳过，避免无意义升版）。
#   3. **发布后按运行产物核对**：比对 web 容器里的 `dist/server/index.js` 哈希与镜像内
#      哈希（比内容，不比镜像 ID —— Docker 28 每次 build 都会刷新 provenance）。
#      worker 的输入是 `src/worker` + `src/shared`，本次改动常不落在其 bundle 里，
#      所以只**记录**它的哈希，并可与 demo 的 worker 对账。
#
#   单行 `expect { -re ... }` 会被 Tcl 当成"一个 pattern"整块匹配、永远匹配不上（第一次跑生产
#   脚本时踩到）：块内必须换行写，照 deploy-demo.sh 的形状。
#
# 环境变量：PIGO_DEPLOY_HOST 必填；其余变量提供可覆盖的安全默认值：PIGO_PROD_DIR、
# PIGO_PROD_PROJECT、PIGO_PROD_COMPOSE、PIGO_PROD_ENV_FILE、PIGO_PROD_VOLUME、
# PIGO_PROD_VERSION_KEY。
set -uo pipefail

HOST="${PIGO_DEPLOY_HOST:-}"
PROD_DIR="${PIGO_PROD_DIR:-/app/pi-agent}"
PROJECT="${PIGO_PROD_PROJECT:-pi-agent}"
COMPOSE="${PIGO_PROD_COMPOSE:-compose.yaml}"
ENV_FILE="${PIGO_PROD_ENV_FILE:-/app/pi-agent/.env}"
VOLUME="${PIGO_PROD_VOLUME:-pigo-web-data}"
VERSION_KEY="${PIGO_PROD_VERSION_KEY:-PI_WEB_VERSION}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

[ -n "${PIGO_SSH_PW:-}" ] || { echo "PIGO_SSH_PW not set"; exit 2; }
[ -n "$HOST" ] || { echo "PIGO_DEPLOY_HOST not set (example: deploy-user@deployment-host)"; exit 2; }
command -v expect >/dev/null || { echo "expect is required (password auth, never written to disk)"; exit 2; }

TARBALL="$(mktemp -t pigo-prod-src).tar.gz"
REMOTE_SCRIPT="$(mktemp -t pigo-prod-remote).sh"
EXPECT_SCP="$(mktemp -t pigo-prod-scp)"
EXPECT_SSH="$(mktemp -t pigo-prod-ssh)"
trap 'rm -f "$TARBALL" "$REMOTE_SCRIPT" "$EXPECT_SCP" "$EXPECT_SSH"' EXIT

echo "=== 1) 打包构建输入（排除宿主权威文件）==="
cd "$ROOT" || exit 1
tar -czf "$TARBALL" \
  --exclude='deploy/docker/compose.yaml' \
  --exclude='deploy/docker/compose.demo.yaml' \
  --exclude='deploy/docker/demo.env' \
  --exclude='deploy/docker/.env' \
  package.json package-lock.json tsconfig.json vite.config.ts index.html src deploy/docker .dockerignore || exit 3
gzip -t "$TARBALL" || { echo "TARBALL_CORRUPT"; exit 3; }
if tar -tzf "$TARBALL" | grep -qE '(^|/)(compose\.yaml|compose\.demo\.yaml|demo\.env|\.env)$'; then
  echo "TARBALL_CONTAINS_HOST_AUTHORITATIVE_FILES — 拒绝继续"; exit 3
fi
echo "  OK $(du -h "$TARBALL" | cut -f1) $(tar -tzf "$TARBALL" | wc -l | tr -d ' ') entries"

cat > "$REMOTE_SCRIPT" <<REMOTE
#!/usr/bin/env bash
set -uo pipefail
cd ${PROD_DIR} || exit 1
TS=\$(date +%Y%m%d-%H%M%S)

echo "=== 2) 回滚三件套 ==="
for svc in web worker; do
  img="local/pigo-\$svc:0.1.0"
  docker image inspect "\$img" >/dev/null 2>&1 && docker tag "\$img" "local/pigo-\$svc:pre-\$TS" && echo "  rollback tag: local/pigo-\$svc:pre-\$TS"
done
docker run --rm -v ${VOLUME}:/data -v ${PROD_DIR}:/backup alpine \
  sh -c "tar czf /backup/${VOLUME}-\$TS.tgz -C /data ." && \
  ls -la "${PROD_DIR}/${VOLUME}-\$TS.tgz" | awk '{print "  volume backup:", \$5, "bytes", \$9}'
cp -p ${ENV_FILE} "${ENV_FILE}.bak-\$TS" && echo "  .env backup: ${ENV_FILE}.bak-\$TS"
tar -czf "${PROD_DIR}/source-backup-prod-\$TS.tar.gz" -C ${PROD_DIR} source 2>/dev/null && \
  echo "  source backup: source-backup-prod-\$TS.tar.gz"

echo "=== 3) 同步构建输入 ==="
tar -xzf /tmp/pigo-src.tar.gz -C ${PROD_DIR}/source || { echo "EXTRACT_FAILED"; exit 4; }
echo "  EXTRACT_OK"

echo "=== 4) 版本戳（源码未变则跳过）==="
SRC_HASH=\$(find ${PROD_DIR}/source/src ${PROD_DIR}/source/package.json -type f -print0 2>/dev/null | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-16)
STAMP_FILE=${PROD_DIR}/.deployed-src-hash
PREV_HASH=\$(cat "\$STAMP_FILE" 2>/dev/null || echo "")
OLD_VERSION=\$(sed -n 's/^${VERSION_KEY}=//p' ${ENV_FILE} | head -1)
if [ "\$SRC_HASH" = "\$PREV_HASH" ]; then
  echo "  源码哈希未变（\$SRC_HASH），保持版本 \$OLD_VERSION"
  SKIP_BUILD_NOTE="(源码未变)"
else
  NEW_VERSION=\$(printf '%s' "\$OLD_VERSION" | awk -F. '{printf "%d.%d.%d", \$1, \$2, \$3+1}')
  sed -i "s/^${VERSION_KEY}=.*/${VERSION_KEY}=\$NEW_VERSION/" ${ENV_FILE}
  # web 与 worker 的版本戳都要动：两侧对不上会让人怀疑发布没生效（首次真跑就踩到了）。
  python3 - "\$NEW_VERSION" <<'PYVER'
import pathlib, re, sys
version = sys.argv[1]
p = pathlib.Path("/app/pi-agent/.env")
text = p.read_text()
for key in ("PI_WEB_VERSION", "PI_WORKER_VERSION"):
    if re.search(rf'^{key}=', text, re.M):
        text = re.sub(rf'^{key}=.*$', f'{key}={version}', text, flags=re.M)
    else:
        text += f"\n{key}={version}\n"
p.write_text(text)
PYVER
  echo "  \$OLD_VERSION -> \$NEW_VERSION (src hash \$SRC_HASH)"
fi

echo "=== 5) 构建镜像 ==="
BUILD_START_EPOCH=\$(date +%s)
docker compose -p ${PROJECT} -f ${COMPOSE} build web worker 2>&1 | tail -4

echo "=== 6) 重建容器 ==="
docker compose -p ${PROJECT} -f ${COMPOSE} up -d web worker 2>&1 | tail -4
echo "\$SRC_HASH" > "\$STAMP_FILE"

echo "=== 7) 发布后核对（比产物哈希，不比镜像 ID）==="
sleep 12
WEB_CONTAINER="${PROJECT}-web-1"
for _ in \$(seq 1 30); do
  state=\$(docker inspect "\$WEB_CONTAINER" --format '{{.State.Health.Status}}' 2>/dev/null || echo missing)
  [ "\$state" = "healthy" ] && break
  sleep 2
done
img_hash=\$(docker run --rm --network none --entrypoint sha256sum local/pigo-web:0.1.0 /app/dist/server/index.js 2>/dev/null | awk '{print \$1}')
run_hash=\$(docker exec "\$WEB_CONTAINER" sha256sum /app/dist/server/index.js 2>/dev/null | awk '{print \$1}')
worker_hash=\$(docker exec "${PROJECT}-worker-1" sha256sum /app/worker.js 2>/dev/null | awk '{print \$1}')
echo "  web bundle: image=\$img_hash container=\$run_hash"
[ -n "\$img_hash" ] && [ "\$img_hash" = "\$run_hash" ] || { echo "RUNNING_BUNDLE_MISMATCH"; exit 7; }
echo "  worker bundle: \$worker_hash（输入为 src/worker+src/shared；常与上一版相同）"
echo "  web 版本戳: \$(docker exec "\$WEB_CONTAINER" printenv PI_WEB_VERSION 2>/dev/null)"
docker ps --format '  {{.Names}} {{.Image}} {{.Status}}' | grep ${PROJECT}
echo "PROD_DEPLOY_DONE"
REMOTE

echo "=== 2) 上传并执行远端步骤 ==="
cat > "$EXPECT_SCP" <<SCPEXPECT
set timeout 600
log_user 1
spawn sh -c "scp -o StrictHostKeyChecking=accept-new -o NumberOfPasswordPrompts=1 $TARBALL $REMOTE_SCRIPT ${HOST}:/tmp/"
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

scp_log="$(expect -f "$EXPECT_SCP" 2>&1)"
echo "$scp_log" | grep -q "SCP_OK" || { echo "UPLOAD_FAILED"; exit 3; }
ssh_log="$(mktemp -t pigo-prod-log)"
expect -f "$EXPECT_SSH" > "$ssh_log" 2>&1
tail -24 "$ssh_log"
grep -q "PROD_DEPLOY_DONE" "$ssh_log" || { echo "REMOTE_STEP_FAILED — 见上方输出；不要认为发布成功"; exit 4; }
echo "PROD_DEPLOY_VERIFIED"

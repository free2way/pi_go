# 演示 / 验收环境（compose.demo.yaml）

本页描述如何把 PI GO 的演示 / 验收环境作为**可复现的仓库产物**拉起，而不是在
宿主机上手工 `docker run`。手工容器（`pigo-web-e2e`、`pigo-smoke-web`、
`pigo-worker-fake`）已出现版本号与挂载漂移，改用
[`deploy/docker/compose.demo.yaml`](../deploy/docker/compose.demo.yaml)。

## 它是什么

- 一个独立的 Compose 项目 `pigo-demo`，包含 `demo-web` + `demo-worker`
  （外层还有一次性的 `demo-preflight` 凭据守卫）。
- 数据库**硬编码**为隔离库 `pigo_demo`，与生产库 `pigo` 完全分离。
- 端口 `192.168.2.235:3101 -> 3100`（与旧的手工容器一致）和仅回环的
  `127.0.0.1:3102 -> 3100`（供 `seed`/`doctor` 与 Playwright 使用）。
- `NODE_ENV=development` + `PI_AUTH_MODE=development`，因此可以使用
  `x-pigo-dev-email` 开发身份（生产环境该组合会被拒绝启动）。
- 沙箱 `PI_SANDBOX_MODE=auto`，默认 fail-closed。

## 它不是什么

- **不是生产环境**，也不应承载真实数据。它没有 Cloudflare Access 鉴权，WebUI
  直接暴露在 3101。
- **共用宿主机的 PostgreSQL 容器**（生产 compose 项目 `pi-agent` 的
  `postgres-1`，网络 `pi-agent-network`）。演示栈不创建自己的 postgres，只连
  接其中的 `pigo_demo` 库。
- **共用宿主机的 Docker socket**（`/var/run/docker.sock` + `group_add` 中的
  gid）。worker 会像生产一样创建沙箱容器，这是有意为之，也意味着该 socket 的
  权限与生产一致。
- **共用一份凭据文件**（宿主机 `PIGO_DEMO_DATA_DIR/credentials.v1.json`）。
  仓库里不存放任何真实凭据；文件必须已经存在，否则整个栈 fail-closed。
- **不删除卷**。`down` 只停止容器，不会 `--volumes`。

## 安全不变量：只能指向 `pigo_demo`

`compose.demo.yaml` 把 `PI_DATABASE_URL` 写死为 `…@postgres:5432/pigo_demo`；
`scripts/demo-env.sh up` 还会先用 `docker compose config` 解析出**所有**
`*DATABASE_URL*` 的最终值，先打印（密码打码）再校验，**只要有一个不以
`/pigo_demo` 结尾就拒绝启动**。因此：

- 不能通过环境变量把演示栈指向生产库；
- 尾随空格、`…/pigo_demo/`、`…/pigo_demo_extra`、带 query string 的 URL 一律
  拒绝（fail-closed）；
- 该不变量的纯逻辑与拒绝路径由 `npm run test:scripts`
  （[`scripts/demo-env.test.mjs`](../scripts/demo-env.test.mjs)）锁定。

## 使用

```bash
# 1) 准备配置（不提交）
cp deploy/docker/demo.env.example deploy/docker/demo.env
chmod 600 deploy/docker/demo.env        # 填入 PIGO_POSTGRES_PASSWORD / PI_VAULT_SECRET / PI_INTERNAL_TOKEN

# 2) 准备凭据文件（已存在，不要提交）
mkdir -p /app/pi-agent/demo-data
docker compose -f /app/pi-agent/compose.yaml cp web:/app/data/credentials.v1.json /app/pi-agent/demo-data/
chown -R 1000:1000 /app/pi-agent/demo-data

# 3) 拉起 / 检查 / 播种 / 停止
scripts/demo-env.sh up          # 校验 env + DB 不变量，构建并启动，等待健康检查
scripts/demo-env.sh doctor      # PASS/FAIL + 可执行提示：DB 名、凭据、docker socket、token、版本
scripts/demo-env.sh seed        # 幂等创建/刷新演示项目、冲刺与故事
scripts/demo-env.sh status      # 只读：容器、解析出的 DB、健康
scripts/demo-env.sh down        # 停止，不删除卷
```

Playwright 指向演示环境：

```bash
PI_E2E_BASE_URL=http://127.0.0.1:3102 npm run e2e:browser
```

## `doctor` 的检查项

| 检查 | 含义 | 失败提示方向 |
| --- | --- | --- |
| `env-file` / `env-required` / `env-placeholders` | 配置文件存在且已填写 | 复制 `demo.env.example` 并替换 `replace-with-…` |
| `credential-file` | 挂载的凭据文件存在、可读且为 v2 格式 | 放置 `credentials.v1.json`（0600、uid 1000） |
| `compose-config` | `docker compose config` 可解析（所有 `${VAR:?}` 都已提供） | 补齐 demo.env |
| `database-name` | 每个解析出的 `*DATABASE_URL*` 都是 `/pigo_demo` | 修正 compose/env |
| `compose-structure` | vault 非 `/tmp`、回调指向 `demo-web`、socket/gid、端口绑定 | 修 `compose.demo.yaml` |
| `internal-token-parity` | web 与 worker 的 `PI_INTERNAL_TOKEN` 一致（只打印长度 + hash） | 让两者使用同一变量 |
| `version-parity` / `live-version` | `PI_WEB_VERSION == PI_WORKER_VERSION == PIGO_DEMO_VERSION` 且与 `/api/health`、`/health` 一致 | 修改版本后重建镜像 |
| `docker-socket` | worker 容器内 socket 可 stat 且 gid 在进程组内 | 设置 `PIGO_DEMO_DOCKER_GID` |
| `sandbox-fail-closed` | 报告是否启用了降级执行 | 默认保持关闭 |

`doctor` 不打印任何密钥值。

## `seed` 的幂等性

`seed` 通过 `GET` 现有数据后按**稳定键**匹配再写入：

- 项目：按 `key = DEMO` 匹配，命中则 `PATCH`，否则 `POST`；
- 冲刺：按项目内 `name = 演示冲刺` 匹配；
- 故事：按项目内 `title` 匹配（`scripts/demo-env-lib.mjs` 的 `DEMO_STORIES`）。

因此重复执行只会原地刷新，不会产生重复记录，且会打印项目 / 冲刺 / 故事的真实
id 与 `status`。种子数据全部通过现有敏捷 API（`/api/agile/projects`、
`/api/sprints`、`/api/stories`）创建，没有引入新的数据模型。

## 已知限制

- 演示栈运行**真实** worker（真实模型调用）。确定性的
  [`deploy/docker/fake-pi/pi`](../deploy/docker/fake-pi/pi) 运行时尚未接入本
  compose 文件——`pigo-worker-fake` 的替代仍是后续工作。
- `PIGO_DEMO_DOCKER_GID` 需要按宿主机 `stat -c %g /var/run/docker.sock` 校准。
- `PI_DATABASE_URL` 必须是 PostgreSQL 密码不含 URL 特殊字符的形态（与生产
  compose 相同的约束）。

# 192.168.2.235 Pi Docker 部署记录

部署日期：2026-10-03（Asia/Shanghai）

## 部署结果

| 项目 | 值 |
| --- | --- |
| 主机 | `192.168.2.235` |
| 部署目录 | `/app/pi-agent` |
| Compose 项目 | `pi-agent` |
| 容器 | `pi-agent-runtime-1`、`pi-agent-web-1`，真实执行启用后另有 `pi-agent-worker-1` |
| 镜像 | `local/pi-coding-agent:1.0.0`、`local/pigo-web:0.1.0`、`local/pigo-worker:0.1.0` |
| Pi | `1.0.0` |
| Node.js | `22.23.3` |
| 运行用户 | `node`，UID/GID `1000:1000` |
| 独立网络 | `pi-agent-network` |
| 配置卷 | `pi-agent-config`、`pigo-web-data` |
| 工作目录 | `/app/pi-agent/workspace` -> `/workspace` |
| 宿主端口 | WebUI 仅绑定 `127.0.0.1:3100`；Pi runtime 无宿主端口 |
| 公网地址 | `https://pigo.ai2note.com`（Cloudflare Tunnel） |
| Runtime 资源限制 | 2 CPU、4 GiB 内存、512 PID |
| WebUI 资源限制 | 0.5 CPU、512 MiB 内存、128 PID |

容器启用了 `no-new-privileges`、移除全部额外 Linux capabilities，并使用独立网络和配置卷。部署后已验证部署前存在的其他容器全部仍处于运行状态。

## 模型与连通性验证

密钥仅保存在服务器 `/app/pi-agent/.env`，文件权限为 `0600`；源码、镜像和浏览器端均不包含密钥。

| 角色 | Provider | 模型 | 验证结果 |
| --- | --- | --- | --- |
| 开发 Agent | `deepseek` | `deepseek-flash` | 模型清单 HTTP 200；最小生成 HTTP 200 |
| 审核 Agent | `openai-proxy` | `gpt-5.6-sol` | 模型清单可见；最小生成 HTTP 200，返回 `OK` |

审核端点为 OpenAI 兼容接口 `https://pr.ai2note.com/v1`，模型配置位于 Pi 配置卷内的 `/home/node/.pi/agent/models.json`，其中只引用 `$OPENAI_API_KEY`，不保存明文密钥。

## WebUI 与 Cloudflare

- WebUI 健康检查：`http://127.0.0.1:3100/api/health`
- Cloudflare Tunnel：`ai2note-home-192-168-2-235`
- 公网路由：`pigo.ai2note.com` -> `http://localhost:3100`
- Cloudflare 自动创建 CNAME 到 Tunnel
- 已通过 Cloudflare 两个边缘地址验证 HTTPS：HTTP 200，TLS 校验通过
- WebUI 已包含真实 Agent 编排器；启用前必须先完成 Cloudflare Access 登录保护

## 项目与代码保存目录

```text
/app/pi-agent/workspace/
  projects/<项目名>/       # 用户放入或 clone 的源 Git 仓库
  runs/<run-id>/           # 每个真实任务的隔离 Git worktree 和代码结果
```

源仓库必须是干净的 Git 工作区。真实任务不会自动提交、推送或合并；审核通过的代码保留在对应 `runs/<run-id>`，由人工确认后处理。

服务器侧验证：

```bash
cd /app/pi-agent
docker compose ps
curl http://127.0.0.1:3100/api/health
docker compose exec runtime pi --list-models deepseek
docker compose exec runtime pi --list-models openai-proxy
```

## 日常运维

```bash
cd /app/pi-agent

# 状态和健康检查
docker compose --env-file .env ps
docker compose --env-file .env exec -T runtime pi --version
curl http://127.0.0.1:3100/api/health

# 进入 Pi
docker compose --env-file .env exec runtime pi

# 查看日志
docker compose --env-file .env logs --tail=200 runtime web

# 只重启 Pi 或 WebUI
docker compose --env-file .env restart runtime
docker compose --env-file .env restart web

# 停止 Pi；不会删除配置卷
docker compose --env-file .env down
```

不要使用 `docker compose down --volumes`，除非明确要删除 Pi 的登录信息和配置。不要执行宿主机级别的 `docker system prune`，以免影响同机其他应用。

## v0.3.0 升级记录

升级日期：2026-10-03（Asia/Shanghai）

| 项 | 值 |
| --- | --- |
| 新镜像 | `local/pigo-web:0.1.0`（v0.3.0，健康检查返回 `{"version":"0.3.0"}`）、`local/pigo-worker:0.1.0` |
| 回滚标签 | `local/pigo-web:prev` / `local/pigo-worker:prev`（v0.2.0 时代）；`local/pigo-worker:prev2`（本次升级前版本） |
| 备份 | `/app/pi-agent/backups/20261003-052048/`（`pigo-web-data` 卷 tar、`.env`、compose 文件） |
| 源码留档 | `/app/pi-agent/source.prev-20261003`、`/app/pi-agent/source.prev2-20261003` |
| 无变更 | runtime 容器、其他 10 个既有容器全程未重建、未受影响 |

### 本次变更（代码）

- **回调体积**：Worker→Web 内网回调路由 bodyLimit 由 64KiB 提升到 4MiB；Worker 侧增加 3MiB 兜底截断（先截 diff、再截检查输出），大改动任务不再被 413 误判失败。
- **写队列恢复**：`RunStore` 与 `CredentialVault` 的持久化队列在单次写失败后自动复位，不再永久静默失败（含回归测试）。
- **工具活动**：按 Pi JSON 协议读取 `tool_execution_start.toolName`，活动流展示真实工具名（原先只显示 "tool"）。
- **usage 统计**：按 `message_update.usage` / `message_end.message.usage` 采集输入/输出/cache token 与 cost；真实运行不再显示全 0。
- **审核降级**：解析失败自动重试一次；**提供方错误（429 等）与协议错误分开上报**；仍失败转 `needs_human`，不再整单 failed。
- **安全**：internal 回调 patch 使用 zod 白名单（拒绝未知字段）；Worker 使用常量时间 token 比较；`NODE_ENV=production` 时禁止 development 认证模式启动。

### 首次完整真实 E2E（2026-10-03 晚，run_8242185824054336）

- 任务：`pi_go` 仓库 README/docs 文档任务，第二条检查故意首轮失败以验证修复回路。
- 通过项：planner 单任务规划 ✅；第 1 轮检查失败 → 第 2 轮修复后检查全部通过 ✅；工具名展示 ✅；usage 采集（input 44,649 / output 15,974 / cacheRead 733,952）✅；错误降级路径 ✅。
- 阻断项：审核阶段被上游代理限流（`pr.ai2note.com` → sub2api 返回 429：`no available OpenAI accounts supporting model: gpt-5.6-sol (pool=1, filtered: model_rate_limited=1)`）。属于代理账号额度问题，待账号恢复或补充后重跑即可完成全闭环。
- 复核命令：`docker logs --tail 200 sub2api | grep -i rate` 可确认限流状态。

## v0.4.0～v0.12.2 升级记录（2026-10-03/04，Asia/Shanghai）

升级日期：2026-10-03 至 2026-10-04。生产容器始终为 `pi-agent-web-1` / `pi-agent-worker-1`（compose 项目 `pi-agent`），runtime 与 postgres 未重建。

| 版本 | 主题 | 关键内容 |
| --- | --- | --- |
| v0.4.0～v0.7.0 | 工作区、真实运行、回调 | 工作区注册/校验/克隆、真实运行前置校验（脏工作区拒绝）、回调体积上限与截断、内网常量时间 token 比较 |
| v0.8.0 | 人工介入（RUN-006） | `needs_human` 任务的人工指令入口：`POST /api/runs/:id/resume`、`POST /api/runs/:id/retry-review` |
| v0.9.0 | 并行 Sub Agent 修复 | 子 Agent 分支前缀冲突（`pigo/<runId>/sub-*` 与运行分支互斥提交）导致的 7ms 立即失败 |
| v0.10.0 | 模型与凭据（MODEL） | 按 provider 的 v2 加密凭据（v1 角色键一次性迁移，AAD `pigo:v2:<userId>:provider:<provider>`，掩码 `••••••last4`）、`GET /api/models` 目录与可用性、开发/审核分角色选模、入队前预检（422 `MODEL_NOT_FOUND`/`MODEL_NOT_ALLOWED`/`MODEL_UNAVAILABLE`）、provider 错误分类与建议、UI「模型与凭据」页 |
| v0.11.x | 可靠性存储层（REL-001～004） | Run/Event/Agent/Check/Finding/Artifact/Checkpoint/Job 全部落 PostgreSQL（`runs.json` 一次性导入，原文件保留）；事件 seq 单调 + SSE 分页补拉/断点续传；内部更新投递幂等键；Worker 重启按检查点恢复（不重复已完成模型调用、不产生冲突 verdict）；任务队列持久化 + 心跳 + 超时重领 |
| v0.12.x | 可靠性运维层（REL-005～007、010） | provider 429/5xx 有界指数退避（默认 3 次，2s×2 → 上限 30s）并留痕 `provider.retry`；健康详情 `/api/health/detail` 与告警（结构化日志 + 可选 `PI_ALERT_WEBHOOK`）；磁盘水位守卫（低水位告警、critical 时 507 `DISK_FULL` 停止接收新任务）；存储故障统一 503 `STORAGE_UNAVAILABLE` 且不伪装完成（该保证的边界与校正见下方“已知限制”及审核报告 §5 / AUD-06）；每日备份与每周恢复校验脚本 |

> **校正（对照审核报告 §5 / AUD-08）：**上表 v0.10.x 所述“入队前预检”只校验 Key 是否已配置及目录/白名单可见性，不等于 Key、model 与账号权限的运行时可用性预检；“Key 已配置”不能作为预检通过的证据。该能力由本批次 AUD-08/09 修复补齐（模型严格白名单 + 运行时可选性预检 `verifiedAt`/`verifiedModels`、执行可用性与默认 provider 解耦），见文末《2026-10-04 审计修复批次部署记录》。

### 回滚标签（镜像）

`local/pigo-web:0.1.0` / `local/pigo-worker:0.1.0` 每次升级前打标签，当前可用回滚点：web `prev11`～`prev14`、worker `prev7`～`prev10`（`prev14`/`prev10` 为 v0.12.1 之前的构建）。源码留档：`/app/pi-agent/source.prev12-*` ～ `source.prev15-*`。

### 运维端点

- `GET /api/health`：存活探针；数据库不可用时 503 `DATABASE_UNAVAILABLE`（限时 2.5s 探测，不会挂起）。
- `GET /api/health/detail`：数据库、队列（待领取/因 Worker 中断重领）、Worker（含工作区磁盘水位）与当前告警；支持内网 token 或登录用户访问。

### 备份与恢复（REL-007 / AT-REL-009）

- 脚本：`deploy/docker/backup.sh`（数据库 `pg_dump -Fc`、凭据密文、compose/.env、脱敏环境变量、manifest：表行数 + run 文档 digest + 密文 sha256）、`deploy/docker/restore-verify.sh`（还原到 `pigo_restore_verify` 临时库并逐项比对，比对后自动删除临时库，生产库不受影响）。
- 已安装 crontab（用户 `free2way`）：每日 03:30 备份（保留 14 天）、每周日 04:30 恢复校验；日志 `backups/backup.log`、`backups/restore-verify.log`。移除方式：`crontab -e` 删除这两行。
- 2026-10-04 手动验证结果：`runs=3 events=536 agents=3 checks=5 findings=18 artifacts=3`，run 文档 digest 与备份 manifest 完全一致，凭据密文 sha256 一致 → `RESTORE VERIFIED OK`。**校正（对照审核报告 §5 / AUD-14）：**该演练基于 v0.12.x 镜像，“备份成功”不能证明脱敏输出不含密码，也不能替代当前版本的恢复演练；本批次已实现备份净化核验（见文末《2026-10-04 审计修复批次部署记录》），但当前版本（v0.20.1）的恢复演练未重做，列为未验证。

### 数据迁移说明

首次启动 v0.11.x 时把 `PI_DATA_FILE`（`/app/data/runs.json`）中的历史运行导入 PostgreSQL：`importedRuns=3 importedEvents=536 skippedRuns=0`；无 `ownerId` 的两条历史运行按唯一用户的 `legacy_owner_id` 归属。原 `runs.json` 不再作为目标存储，但文件保留以便回滚。

### 已知限制

- Web 进程内存中只保留运行摘要缓存，事件一律走数据库；多实例部署需要额外的缓存失效机制（当前为单实例）。
- 存储完全不可用期间，Worker 无法写入终态：任务保持在已领取状态并重试，恢复后由重领继续。**校正（对照审核报告 §5 / AUD-06）：**原先“绝不会出现‘未完成却显示完成’”的绝对表述与“缓存先更新”的路径存在反例，已撤回；准确表述为终态以数据库持久化记录为准，内存/缓存状态不构成“完成”依据。
- 恢复依赖既有 worktree；若 worktree 已被清理，任务会明确转人工而不是重复执行。

### 可靠性验收证据（192.168.2.235 上的隔离 e2e，v0.11.1～v0.12.1 镜像 + 假 Pi 运行时）

- AT-REL-001：Run 执行中重启 Web → 运行继续，事件 seq 连续（1..27），页面恢复后读到最新状态。
- AT-REL-002/003（E2E-06）：检查阶段重启 Worker → `run.recovered`/`checkpoint.development_restored` 事件；开发模型调用次数不变（每个文件 1 行）、每轮审核调用恰好 1 次、checkpoint `planning/dev:1/checks:1/review:1/dev:2/checks:2/review:2` 全部 completed、任务队列 attempts=2 终态 done。
- AT-REL-004：同一 `deliveryId` 重复投递内部更新 → 事件仅新增 1 条，seq 不重复累计。
- AT-REL-006：Provider 持续 429 → 2 次退避重试（间隔约 0.5s 起）后转 `needs_human`，附分类与建议，无无限循环。
- AT-REL-007：存储中断（暂停数据库）→ 运行不进入 completed，落 `run.storage_error` 并转 `needs_human`，恢复后可从人工入口重试。
- AT-REL-008：客户端落后 → 分页补拉（1,2,3 / 4,5,6），带 `Last-Event-ID` 重连从下一条继续（seq 28）。
- AT-REL-009：见上文备份/恢复验证。
- AT-REL-010：磁盘 critical（阈值 `PI_MIN_FREE_DISK_MB`）→ 新建任务返回 507 `DISK_FULL`，`/api/health/detail` 暴露 critical 水位与告警。

## v0.13.0～v0.13.2 升级记录：安全组（SEC）

升级日期：2026-10-04（Asia/Shanghai）。生产容器 `pi-agent-web-1` / `pi-agent-worker-1` 已重建，runtime / postgres 未重建。回滚标签：web `prev16`/`prev17`、worker `prev12`/`prev13`；源码留档 `source.prev16-*` ～ `source.prev18-*`。

### 本次变更（代码与部署）

- **SEC-004（真实运行高优发现修复）**：Worker 不再挂载交互式 Pi 配置卷 `pi-agent-config`（其中含 auth、会话转录与缓存）。改为：
  - `/app/pi-agent/pi-models.json` 只读挂载到 `/home/node/.pi/agent/models.json`（由 `deploy/docker/export-models.sh` 生成，剥离任何字面量凭据，仅保留 `$ENV` 引用）；
  - 容器内命名卷 `pigo-worker-state` 承载 Worker 自己的 Pi 状态与会话，与其他进程隔离；
  - Worker 镜像预建 `/home/node/.pi/agent`（`node` 属主），确保非 root 用户可写凭据存储（首次上线曾因该目录 root 属主导致真实运行报 `Credential store read failed`，已修复并回归）。
- **SEC-003/010**：子进程环境改为白名单式清洗（`src/worker/pi-env.ts`）——Agent 进程只拿到当前角色的 provider Key；检查命令拿不到任何 provider Key、内部回调 token、数据库口令。生产验证：检查命令输出 `guard:CLEAN_TOKEN,CLEAN_OPENAI,CLEAN_DEEPSEEK`。
- **SEC-008**：写接口按用户限流（凭据写入 10/分、建单 20/分、取消与人工操作 30/分），超限 429 + `RATE_LIMITED`，其他用户不受影响。
- **SEC-002/005/007/009/011/014**：沿用并复核既有措施（AES-256-GCM+AAD、日志/事件脱敏、非 root + cap_drop ALL + no-new-privileges + 只读根 + 资源上限、realpath/允许根校验、`--no-extensions --no-skills`）。

### 验收证据（隔离 e2e，v0.13.1/v0.13.2 + 假运行时）

| 用例 | 结果 |
| --- | --- |
| AT-SEC-001 | 源码、前端 bundle、数据库事件/运行文档、Web/Worker 日志、凭据文件均无密钥样式明文（命中数 0） |
| AT-SEC-002/003 | 凭据密文随机 IV、16 字节认证 tag、AAD 绑定 user/provider；篡改密文或跨用户复制均解密失败（单元测试） |
| AT-SEC-004 | 跨 Origin 写请求 403；受信任 Origin 201 |
| AT-SEC-005 | 凭据写入第 9 次起 429（窗口内 8 次成功 + 此前 2 次调用），建单第 21 次 429；另一用户仍可建单（201） |
| AT-SEC-006 | `../../etc`、`/etc/passwd`、嵌套 `fixture-rel/../../etc` 全部 `WORKSPACE_INVALID` |
| AT-SEC-008 | planner/developer 仅见 `DEEPSEEK_API_KEY`，reviewer 仅见 `OPENAI_API_KEY`；内部 token 对 Agent 不可见 |
| AT-SEC-009/014 | reviewer `--tools read,grep,find,ls`（只读）；所有角色均 `--no-extensions --no-skills --no-prompt-templates` |
| AT-SEC-011 | `docker inspect`：user=node、cap_drop=[ALL]、no-new-privileges、web/worker read_only、pids/mem/cpu 上限、非特权 |
| AT-SEC-012 | 缺 token / 错误值 / 错误长度 → 401；常量时间比较；正确 token 200 |
| AT-SEC-013 | 8MB 请求体、20 万字符任务、5MB 内部 patch 全部 413，服务保持健康 |

> **校正（对照审核报告 §5 / GAP-02）：**“全部插件禁用”（`--no-extensions --no-skills`）只说明未启用任何插件，不能覆盖“批准插件可启用、版本固定与篡改检测”。本批次已实现插件白名单（默认全禁，见文末批次记录），但插件版本固定与篡改检测仍未实现，列为遗留。

### 每任务容器沙箱（v0.14.0～v0.14.5，按业主决策采用）

- **实现**：Worker 通过挂载的 Docker Socket（`group_add` 加入宿主 docker 组，非 root）为**每次 Agent 调用**与**每条检查命令**单独创建容器（`local/pigo-sandbox:0.1.0`，与运行时同镜像）。容器规格（`src/worker/sandbox.ts`）：
  - 只挂载：本次运行的 worktree、该仓库的 `.git` 元数据（worktree 提交需要）、只读的 `pi-models.json`、本次运行的 Pi 状态目录（`<worktree>.state`）；
  - 其余项目工作区、交互式配置卷、数据库口令、内部回调 token 全部不可见；
  - `--user node`、`--cap-drop ALL`、`no-new-privileges`、只读根文件系统、`/tmp` 与 `~/.cache` tmpfs、pids/mem/cpu 上限；
  - 检查命令 `network=none`（无出网），Agent 调用使用 `pi-agent-network`（仅 provider 出网）；
  - 容器结束即删除，状态目录随运行清理；启动前预建 `<state>/agent`（node 属主）以保证 Pi 可写会话/凭据存储。
- **验证（生产 v0.14.5，真实模型调用）**：运行 `run_ade63448ea2047ff` 全流程完成（规划 → 开发 → 检查 → 审核通过，成本 $0.0028）；检查命令在沙箱内的输出为
  `workdir=/workspace/runs/<owner>/<run>`、`SOURCE_BLOCKED`（无法读取源仓库文件）、`HOME_WRITABLE`、`NETWORK_BLOCKED`。
- **验证（隔离 e2e v0.14.4）**：原子角色凭据可见性（planner/developer 仅 `DEEPSEEK_API_KEY`，reviewer 仅 `OPENAI_API_KEY`）、reviewer `--tools read,grep,find,ls`、无遗留沙箱容器、diff 不含沙箱状态目录。

### 残余风险（已记录）

- Agent 调用容器仍需出网（调用 provider），未做目的地 allowlist；如需严格限制，需在宿主侧加 egress 代理或防火墙策略。
- Worker 持有 Docker Socket 即具备创建容器的能力：请勿在同机运行不可信工作负载；共享主机场景建议改用 socket proxy。
- 检查命令在沙箱内无网络，若某项目检查确实需要联网（如 `npm install`），需临时调整 `PI_SANDBOX_MODE=process` 或改用离线缓存方案。

## v0.15.x 升级记录：成本与性能组（COST / AT-PERF）

升级日期：2026-10-04（Asia/Shanghai）。生产 `pi-agent-web-1` / `pi-agent-worker-1` 已重建（v0.15.2，沙箱模式 container）。回滚标签：web `prev19`、worker `prev15`；源码留档 `source.prev28-*`。

### 本次变更（代码）

- **COST-001**：按角色（planner / developer / sub-agent / integrator / reviewer）记录 input/output/cache token 与费用，写入运行文档 `usageRoles`/`modelCalls` 并投影到 PostgreSQL 表 `run_usage_role`（迁移 4）。
- **COST-002/003（AT-PERF-008）**：Run 级硬预算 `PI_RUN_MAX_TOKENS` / `PI_RUN_MAX_COST_USD` / `PI_RUN_MAX_MODEL_CALLS` / `PI_RUN_MAX_DURATION_SECONDS`；每次模型调用前判定、调用后累计，任一维度达 80% 记 `run.budget_warning` 一次，达 100% 抛预算异常：不再发起新调用，运行转 `needs_human` 并记 `run.budget_exhausted`。生产默认全部为 0（不限制），按需开启。
- **COST-004（AT-PERF-007）**：返修复用 Developer 会话（`--session-id <run>-developer`），只注入新增 finding / 检查失败输出与必要上下文，不再新建 repair 会话。
- **COST-006**：Planner 默认低推理（`PI_PLANNER_THINKING=low`，可覆盖）。
- **AT-PERF-005**：任务取消时同步终止沙箱容器（实测取消耗时 29～43 ms，无遗留容器）。
- **AT-PERF-006**：Worker 容量不足时任务保持持久排队（REL 队列），不丢任务。

### 验收证据（隔离 e2e v0.15.2 + 假运行时；生产 v0.15.2 冒烟）

| 用例 | 结果 |
| --- | --- |
| COST-001 | 2 轮运行 `usageRoles = planner:1 / developer:2 / reviewer:2`；`run_usage_role` 行同步；生产冒烟 planner $0.0015、developer $0.0021、reviewer $0.0000（代理未回传费用） |
| COST-003 / AT-PERF-008 | 预算 $0.0031：首次调用后 80% 预警；第三次调用前停止（reviewer 调用数 0），状态 `needs_human`，事件 `run.budget_exhausted`。**校正：**这是正常路径预算通过，不能覆盖并行预留、恢复累积及 retry-review（AUD-10）；本批次 AUD-10 修复补齐了预算并行预留与时限，恢复累积 / retry-review 的独立证据未单列 → 未验证。 |
| COST-004 / AT-PERF-007 | 返修调用的 `--session-id` 与首轮 Developer 相同（`<run>-developer`），role 计为 developer。**校正：**该证据仅证明 argv 相同，不能证明被删除的 session 仍可复用（AUD-07）；本批次修复清单含 AUD-07，但未单列“被删除 session 可复用”的直接证据 → 会话延续性未验证。 |
| COST-006 | 探针显示 planner `--thinking low`，developer/reviewer `high` |
| AT-PERF-001 | 10 并发 × 6 轮读取 workspaces/runs/models：p50 14 ms、p95 96 ms、错误率 0（阈值 p95 < 500 ms） |
| AT-PERF-002 | 连续写入 100 事件：seq 连续、写入到可读 p95 105 ms（阈值 2 s）。**校正：**这是“写入到 API 可读”延迟，不等于页面可见时延；页面可见延迟未测量 → 未验证。 |
| AT-PERF-003 | 首屏业务数据（workspaces+runs+models）26 ms（阈值 3 s，局域网）。**校正：**这是 API 三接口响应时间，不能替代页面可见延迟与浏览器首次业务数据渲染；浏览器 e2e 已进仓库并本地实跑（5 通过 2 条件跳过），但页面可见延迟未单独量化 → 页面侧未验证。 |
| AT-PERF-004 | 沙箱容器规格：内存 2 GiB、CPU 1.5 核、pids 256（单元测试断言，`src/worker/sandbox.test.ts`）。**校正：**仅证明单容器资源规格配置正确，不能覆盖三个真实 Agent 并行时的总资源占用与健康检查 → 未验证。 |
| AT-PERF-005 | 取消 43 ms 内结束，无遗留沙箱容器 |
| AT-PERF-009 | 运行文档与 `run_usage_role` 记录 provider 回传的精确 usage；费用字段为 provider 回传值（代理不提供时记为 0） |

### 生产冒烟

`run_6de6ba9522844a84`：真实模型全流程完成（规划 → 开发 → 检查 → 审核通过），checkpoints 齐全、任务队列 done、成本 $0.0036，`run_usage_role` 3 行。

## 2026-10-04 审计修复批次部署记录（v0.16.0 → v0.20.1）

部署日期：2026-10-04（Asia/Shanghai）。主机 `192.168.2.235`，compose 项目 `pi-agent`。本批次针对审核报告（`docs/06-code-review-acceptance-report.md`）的 AUD / GAP 项收敛修复并部署，同时校正 `docs/03` 中与 §5 相关的旧表述（见各小节“校正”批注）。

### 部署序列

v0.15.2 → v0.16.x（隔离 e2e 验证）→ 生产 v0.18.0 → v0.19.0 → v0.19.1 → v0.19.2 → v0.20.0 → v0.20.1（当前）。

每次部署前均执行 DB dump、vault 与 compose 备份，存放于 `backups/<ts>/`，并保留 `source.prev*` 时间戳目录。

### 回滚点

- 镜像回滚标签：web `prev22`…`prev26`、worker `prev18`…`prev22`。
- 更早的 `prev15`/`prev16`、`prev19`/`prev20` 标签仍在，可回滚至 v0.15.2。

### 本批次修复项

| 编号 | 内容 |
| --- | --- |
| AUD-01/02/03/05/06/07/10/11/14/15 | 状态机守卫、事件序列号自愈、工作区归属 409、队列不误恢复、预算并行预留与时限、备份净化核验 |
| AUD-08/09 | 模型严格白名单 + 运行时可选性预检（`verifiedAt`/`verifiedModels`）、执行可用性与默认 provider 解耦 |
| AUD-16 | 全量 diff 制品 + 下载端点；worker 取消静默截尾，上限 3.4M/3.5M，超限显式标注 |
| AUD-17 | SSE 先订阅后回放、`Last-Event-ID`、有界背压、客户端 seq 合并与上限 |
| GAP-02 | 插件白名单，默认全禁 |
| GAP-03 | 独立只读审查快照 + tree hash 零容忍升级 + fail-closed + 快照销毁 |
| GAP-04 | approve/reject/清理/制品 API、预算与按 Agent 用量、check exitCode |
| GAP-05 | 每工作区执行锁 + 失败子代理输出保留 |
| GAP-08 | ESLint + 提交进仓库的 Playwright 浏览器 e2e 套件 |

### 多进程一致性修复（生产冒烟发现）

- Run 读取按需水合：跨实例 / 滚动部署不再 404。
- 变更类路由始终水合：修复“缓存过期导致取消误判 409”。
- `Run missing` 改为 defer，保留队列、不判死。

### 生产冒烟证据

- 真实链路单 `run_782bbaa1`：规划 → 2 子代理 → 合并 → 检查通过 → 审核退回 6 项 → 第 2 轮；因冒烟时限 900s + 审核超时止于 `needs_human`（非缺陷）。
- 冒烟期间发现并当日修复“大 diff → 内部更新 400 storage_error”（schema 200k → 3.5M，v0.19.1）。
- 收敛型冒烟单 `run_bd99b670` 终态 **completed**（diff 为空、检查通过、GAP-03 快照审查通过）。
- 重启时日志 `[jobs] reclaimed 1 unfinished job(s)`，验证恢复路径。

### 凭据切换

- AUD-08 上线后，旧凭据初始未验证会拦截真实任务；生产以运维断言方式为既有凭据写入 `verifiedAt`（vault 元数据），并以启动校验通道兜底。
- `PI_MODEL_PROBE_MODE=off` 为无 `/models` 端点 provider 的显式选项。

### 质量基线（当日）

- `npm run typecheck` 干净。
- 单元测试 179 项 / 30 文件全绿。
- `npm run lint` 0 error。
- 浏览器 e2e 本地实跑：5 通过、2 条件跳过。
- 隔离 e2e（235 上 `pigo-web-e2e:3101` + `pigo-worker-fake`，库 `pigo_test`）：通过核心回归与功能项。

### 遗留（未完成）

- worker 侧 worktree 清理未接入清理 API。
- 插件版本固定 / 篡改检测未实现。
- 按 Agent“会话”为派生展示，非可持久会话。
- SSE 溢出仅自动重连，无显式提示。
- `docs/03` §5 校正即本段（对既有证据的重新验证与降级说明）。

### 运维提醒

- `free2way@192.168.2.235` 的 SSH 密码与旧代理 API Key 建议轮换；本轮全程仅交互输入或经环境变量使用，未落盘。

# 发布门禁与可靠性演练工具（C 组）

本文描述本批次新增的发布门禁、密钥扫描、真实 provider 演练、演练归档与回滚 runbook 脚本。
所有脚本**默认安全**：不触库、不触网、不执行变更，除非通过环境变量或 `--apply/--yes` 显式开启；
缺少前置条件时立即失败并打印清晰原因，绝不静默通过。

- 新增脚本位于 `scripts/`，npm 命令已写入 `package.json`。
- 全部为纯 Node ESM（`scripts/*.mjs`）或 POSIX/Bash shell，无新增运行时依赖。
- 脚本自身只从**环境变量**读取凭据，从不读取凭据文件。

## 0. 前置条件

| 依赖 | 版本/说明 |
| --- | --- |
| Node.js | `>= 22.19.0`（见 `package.json` engines） |
| npm | 随 Node 提供 |
| git | `scan:secrets` 通过 `git ls-files` 枚举受版本控制的文件 |
| bash / coreutils | shell 脚本、`sha256sum`、`find`、`curl`（回滚健康检查） |
| docker + docker compose | 仅 `drill-archive.sh` / `rollback-drill.sh` 实际执行时需要 |

本地（未连库、未连网）可运行：`npm run gate:release -- --dry-run`、`npm run test:scripts`、
`npm run scan:secrets`、以及各 `--dry-run`。

## 1. 发布门禁 `npm run gate:release`

按**固定顺序**执行下列步骤，最后打印 PASS/FAIL/SKIP 汇总表，任一 FAIL 以非零码退出：

| # | 步骤 | 命令 |
| --- | --- | --- |
| 1 | 类型检查 | `npm run typecheck` |
| 2 | 单元测试 | `npm test`（vitest，`src/**`，v0.22.1 记录基线 463 tests / 64 files） |
| 3 | Lint | `npm run lint`（0 errors） |
| 4 | 构建 | `npm run build`（输出 `dist/`，供第 7 步加载） |
| 5 | Compose 结构校验 | `npm run validate:compose` |
| 6 | 密钥扫描 | `npm run scan:secrets` |
| 7 | 真库并发校验 | `npm run test:pg:concurrency`，**仅当**设置 `PI_DATABASE_URL` 或 `DATABASE_URL` |

第 7 步未设置连接串时输出一行 `SKIP` 并给出原因（绝不静默通过）：

```
pg-concurrency  SKIP  PI_DATABASE_URL / DATABASE_URL not set — no database is touched; export one to include this check
```

需要真实数据库证据时：

```bash
PI_DATABASE_URL='postgresql://user:pass@host:5432/pigo' npm run gate:release
```

### 命令

```bash
npm run gate:release              # 运行全部步骤
npm run gate:release -- --dry-run # 只打印计划，不执行任何命令
npm run gate:release -- --help
```

### 退出码与实现

- 退出码：无 FAIL 时为 `0`；存在 FAIL 时为 `1`。SKIP 不视为失败，但总在表中打印原因。
- 聚合/退出码/表格渲染逻辑抽取在 `scripts/release-gate-lib.mjs`（纯函数，含 `planGateSteps` /
  `summarizeResults` / `renderGateTable` / `executeGate`），由 `scripts/release-gate-lib.test.mjs`
  通过 **`node --test`** 覆盖：

  ```bash
  npm run test:scripts
  ```

  说明：`vitest.config.ts` 的 include 仅为 `src/**/*.test.{ts,tsx}`，且本批次不得改动 `src/**`，
  因此门禁辅助逻辑的测试使用 Node 内置测试运行器，而未加入 vitest 收集范围（`npm test` 基线不变）。

## 2. 密钥扫描 `npm run scan:secrets`

扫描**受版本控制的文件**（`git ls-files`），命中高信号模式时以非零码退出，并只打印
`文件:行号 [模式] 前 6 字符…`（匹配内容被脱敏，不打印完整密钥）。

检测模式：

| 模式 | 说明 |
| --- | --- |
| `private-key` | `-----BEGIN … PRIVATE KEY-----` PEM 私钥头 |
| `openai-key` | `sk-` 前缀、长度 ≥ 20 的密钥 |
| `aws-access-key` | `AKIA…` / `ASIA…` + 16 位大写字母数字 |
| `github-token` | `ghp_…`、`github_pat_…` |
| `jwt` | `eyJ….….…` 形态的 JWT |
| `bearer-literal` | `Bearer <≥20 字符>` 字面量 |
| `pg-uri` | 带密码的 `postgres://user:password@host` 连接串 |

仅在**明显为假**时才忽略：含 `DUMMY_`/`dummy`、`example.com`、`placeholder`、`redacted`、
`change-me`、`${…}` 插值，或口令为 `pass`/`password`/`secret`/`change-me` 等占位符、
主机为 `localhost`/`postgres`/`db`/`*.local` 等本地服务名。扫描器自身
（`scripts/secret-scan.sh`）被排除，避免匹配自身的模式文本。

```bash
npm run scan:secrets
npm run scan:secrets -- --help
```

退出码：`0` 干净 · `1` 发现问题 · `2` 缺少前置（不在 git 工作树内）。误报处理：为具体行补充
明确的假标记（如 `DUMMY_`、`example.com`），不要关闭模式。

## 3. 真实 provider 演练 `npm run drill:providers`

通过部署的 HTTP API 发起真实 run，用于采集"真实 provider 闭环"与"真实中型并行 Sub Agent"
的验收证据。凭据**仅从环境读取**。

### 必需环境变量

| 变量 | 说明 |
| --- | --- |
| `PI_DRILL_BASE_URL` | 部署地址，如 `http://127.0.0.1:3100` |
| `PI_DRILL_DEV_EMAIL` | development 认证部署的用户邮箱（`x-pigo-dev-email`） |
| `PI_DRILL_CF_ACCESS_CLIENT_ID` + `PI_DRILL_CF_ACCESS_CLIENT_SECRET` | Cloudflare Access 服务令牌（生产部署二选一） |

`PI_DRILL_INTERNAL_TOKEN` 可选，作为 `Bearer` 用于 `/api/internal/*`；它**只能**认证内部路由，
不能创建用户 run。因此只设置内部 token 时，创建 run 会得到 401，脚本会明确提示改用 dev 邮箱或
CF 服务令牌。

### 可选环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PI_DRILL_WORKSPACE` | 首个干净且 active 的工作区 | 目标工作区 id |
| `PI_DRILL_TASK` | 内置小型任务文本 | 普通模式任务 |
| `PI_DRILL_CHECKS` | `node --version` | 逗号分隔的检查命令（真实 run 至少一条） |
| `PI_DRILL_RUNS` | `3` | 普通模式 run 数 |
| `PI_DRILL_TIMEOUT_MS` | `1800000`（30 分钟） | 单 run 轮询到终态的有界超时 |
| `PI_DRILL_POLL_MS` | `5000` | 轮询间隔 |
| `PI_DRILL_REQUEST_TIMEOUT_MS` | `20000` | 单次 HTTP 超时 |
| `PI_DRILL_DEVELOPER_MODEL` / `PI_DRILL_REVIEWER_MODEL` | 服务端默认 | `provider:model` |
| `PI_DRILL_ACCEPTANCE` | 无 | 捕获到 run 的验收标准 |

### 命令

```bash
# 普通模式：3 次真实 run
PI_DRILL_BASE_URL=... PI_DRILL_DEV_EMAIL=... npm run drill:providers

# 并行 fixture：1 次 run，断言 ≥2 个 subagent.started 且至少跨 1 个 wave
PI_DRILL_BASE_URL=... PI_DRILL_DEV_EMAIL=... npm run drill:providers -- --parallel-fixture

# 参数与输出
npm run drill:providers -- --runs 5 --out backups/drills/mine
npm run drill:providers -- --dry-run   # 校验环境并打印计划，不发任何请求
npm run drill:providers -- --help
```

- `--parallel-fixture` 提交**一个**任务文本明确要求"medium 规模、≥3 个互不重叠文件的 sub-agent"
  的 run，随后读取事件流，按 `subagents.wave_started` 边界归属 `subagent.started`，报告
  `started=N waves=M wavesWithStarts=K`，以 `started >= 2 且 waves >= 1` 判定 PASS/FAIL。
- 普通模式逐次串行创建（避免触发每用户限流），每个 run 轮询到终态。
- 每个 run 打印：state、rounds、checks 通过/总数、modelCalls、findings 已解决/总数、diff 制品是否存在。
- `--out <dir>` 写入 `provider-drill-<timestamp>.json`，供归档脚本收集。
- 缺少必需 env 时打印 usage 并以 `2` 退出；无 `--dry-run` 时才发起网络请求。

退出码：`completed`/`needs_human` 视为可接受的终态；任一 run `failed`/`cancelled`/超时，或
fixture 未观测到并行拆分，则以 `1` 退出。超时的 run 默认会被取消（`--no-cancel` 可关闭）。

## 4. 演练归档与回滚 runbook

### 4.1 归档 `npm run drill:archive`

在目标主机上执行既有 `deploy/docker/backup.sh` + `deploy/docker/restore-verify.sh`，并把该次演练的
输出与 manifest 哈希归档到 `backups/drills/<timestamp>/`。

```bash
# 默认 dry-run：只打印将在主机上执行的完整脚本，不执行任何备份/还原/ssh
npm run drill:archive -- --target free2way@192.168.2.235 --drill-dir backups/drills/mine

# 执行（非交互 shell 必须同时给 --apply --yes；交互 shell 会二次确认）
npm run drill:archive -- --apply --yes --target free2way@192.168.2.235
```

- 目标目录：`<project-dir>/backups/drills/<UTC 时间戳>/`
  - `backup.log`、`restore-verify.log`、`manifest.sha256`（备份 manifest 的 sha256）、`archive-summary.txt`
  - `drills/`：若给了 `--drill-dir`，把本地 provider 演练输出复制（本地 `cp -R`／远端 `scp -r`）进来
- 安全默认：不加 `--apply` 绝不执行；`--apply` 在非交互 shell 下缺少 `--yes` 时以 `2` 拒绝。
- 可选：`--target`（或 `PI_DRILL_HOST`）、`--project-dir`（或 `PI_PIGO_DIR`）。

### 4.2 回滚 `npm run drill:rollback`

打印/执行"回滚到上一版本"的步骤：用上一版本的镜像重新打 tag → 只重建 `web` 与 `worker` → 健康检查。

```bash
# 默认 dry-run：打印全部步骤（retag → compose up -d web worker → 健康检查）
npm run drill:rollback -- --web local/pigo-web:prev1 --worker local/pigo-worker:prev1

# 执行：必须同时给 --apply 与 --yes
npm run drill:rollback -- --web local/pigo-web:prev1 --worker local/pigo-worker:prev1 --apply --yes
```

- 硬性安全：`--apply` 与 `--yes` **必须同时提供**才会执行；只给 `--apply` 会被拒绝（退出 `2`），
  只给 `--yes`（不带 `--apply`）仍是 dry-run。
- 镜像引用做白名单校验，避免命令注入；默认覆盖 compose 中的 `local/pigo-web:0.1.0` 与
  `local/pigo-worker:0.1.0`，可用 `--web-target` / `--worker-target` 覆盖。
- 其他参数：`--compose-file`、`--health-url`（或 `PI_HEALTH_URL`）、`--target`、`--project-dir`。

## 5. 月度演练编排

部署主机（`192.168.2.235`，用户 `free2way`）**已有**每日备份与每周恢复校验的 crontab，见
`docs/03-deployment-record-192.168.2.235.md` 第 148 行：

- 每日 `03:30`：`backup.sh`，保留 14 天，日志 `backups/backup.log`
- 每周日 `04:30`：`restore-verify.sh`，日志 `backups/restore-verify.log`
- 移除方式：`crontab -e` 删除对应两行

**不要重复添加**上述两条。月度演练在此之上新增一条：把备份/恢复证据归档，并跑一次真实 provider 演练。

建议（每月 1 日 `05:30`，日志写入 `backups/drills/drill.log`）：

```cron
# 月度可靠性演练（新增，勿与既有每日备份/每周恢复校验重复）
30 5 1 * * cd /app/pi-agent && PI_DRILL_BASE_URL=http://127.0.0.1:3100 PI_DRILL_DEV_EMAIL=ops@example.com PI_INTERNAL_TOKEN_FROM_ENV_FILE bash -lc 'npm run drill:providers -- --parallel-fixture --out backups/drills/latest && npm run drill:archive -- --apply --yes --drill-dir backups/drills/latest' >> /app/pi-agent/backups/drills/drill.log 2>&1
```

注意事项：

- crontab 环境不落盘明文凭据；把 `PI_DRILL_BASE_URL`/`PI_DRILL_DEV_EMAIL`（或 CF 服务令牌）通过
  受保护的环境文件 / systemd credential 注入，不要写进仓库或明文 crontab。
- `--parallel-fixture` 会真实消耗 provider 额度与运行时长；按 `PI_DRILL_TIMEOUT_MS` 设定上界。
- 演练产物归档在 `backups/drills/<timestamp>/`，manifest 哈希随备份一起保留，作为 RPO/RTO 与
  "真实并行 Sub Agent" 的签字证据来源。

## 7. 严格验收门禁 `npm run gate:acceptance`

`gate:release` 面向日常开发，允许 SKIP、允许 lint warning；**验收**要求证据完整，因此新增
`gate:acceptance`（`scripts/acceptance-gate.mjs`），与 `gate:release` **共用**同一套步骤排序、
聚合与表格渲染（`scripts/release-gate-lib.mjs`），仅收紧判定：

| 维度 | `gate:release`（开发） | `gate:acceptance`（验收） |
| --- | --- | --- |
| 缺失前置条件 | 记为 `SKIP` 并打印原因 | **FAIL**，打印缺失的前置条件 |
| Lint warning | 只要求退出码 0（允许 warning） | 解析 `✖ N problems (0 errors, M warnings)`，要求 **M = 0** |
| 真库并发校验 | 未设置 `PI_DATABASE_URL`/`DATABASE_URL` 则 SKIP | 未设置即 **FAIL**（必须实跑） |
| Playwright 浏览器套件 | 不纳入 | 设置 `PI_E2E_BASE_URL` 时执行；未设置即 **FAIL** |

固定步骤与 `gate:release` 一致：`typecheck` → `test` → `lint` → `build` → `validate:compose`
→ `scan:secrets`，随后是**必需**的 `pg-concurrency` 与 `e2e-browser`。

```bash
# 完整验收（需要真库与可达的部署地址）
PI_DATABASE_URL='postgresql://user:pass@host:5432/pigo' \
PI_E2E_BASE_URL='http://127.0.0.1:3100' \
npm run gate:acceptance

# 只打印计划（会标出哪些前置条件缺失将导致 FAIL）
npm run gate:acceptance -- --dry-run
npm run gate:acceptance -- --help
```

- 退出码：仅当所有步骤 PASS 时为 `0`；任一 FAIL（含"应跑未跑"）为 `1`。
- 注意：Playwright 套件在生产专有场景（`E2E-01..08`）缺少 `PI_E2E_LIVE=1` 时为 `fixme`，
  这是用例级设计而非门禁失败；门禁要求的是"套件实际执行且进程退出 0"。
- 本地无真库 / 无部署地址时，`gate:acceptance` **如期失败**——这是预期行为，不要用它替代
  `gate:release` 做本地开发自检。

## 8. 标准 Compose 配置覆盖 `npm run test:config`

v0.22 复核发现标准 Compose 未转发新增的 `PI_*` 设置，功能"存在于代码却无法在标准部署中开启"。
现由 `scripts/compose-config-coverage.mjs` 守护：

- 断言一组关键变量分别到达**读取它们的服务**（`src/server/**` → `web`，`src/worker/**` → `worker`），
  覆盖模型目录/探测、合并请求与合并后部署钩子、版本/回滚标签/`PI_DEPLOY_LOG`、运行预算、
  限流、告警、插件白名单/固定校验、磁盘水位、provider 重试、planner 思考级别、沙箱/Docker 参数；
- 断言部署日志目录以只读方式挂载进 web（`…:/app/pi-agent/backups:ro`）；
- 纯文本解析（不依赖 Docker daemon），缺失时逐条打印 `service: missing environment variable NAME`
  并以非零码退出。

该检查同时作为 `npm run validate:compose` 的一部分执行，因此 `gate:release` / `gate:acceptance`
都会带上它，回归时无法静默通过。变量清单维护在 `scripts/compose-config-coverage.mjs` 的
`CRITICAL_ENV`；新增关键变量时同步 `.env.example`。

```bash
npm run test:config
npm run test:config -- --json   # 机器可读结果
```


## 6. 安全默认值速查

| 脚本 | 默认行为 | 执行开关 | 凭据来源 |
| --- | --- | --- | --- |
| `release-gate.mjs` | 运行本地只读检查；真库检查自动 SKIP | 设置 `PI_DATABASE_URL` 纳入真库检查 | 环境变量 |
| `acceptance-gate.mjs` | 与 `gate:release` 同序；缺前置条件 / 有 warning / 未跑真库或 e2e 一律 FAIL | 必须设置 `PI_DATABASE_URL` 与 `PI_E2E_BASE_URL` | 环境变量 |
| `compose-config-coverage.mjs` | 只读解析 compose；缺失关键变量时打印 diff 并退出 1 | — | 无 |
| `secret-scan.sh` | 只读扫描，输出脱敏 | — | 无 |
| `provider-drill.mjs` | 缺少 env 即打印 usage 退出；`--dry-run` 不发请求 | 提供必需 env | 仅环境变量 |
| `drill-archive.sh` | dry-run，打印将执行的脚本 | `--apply`（非交互还需 `--yes`） | 主机既有部署环境 |
| `rollback-drill.sh` | dry-run，打印回滚步骤 | `--apply` **且** `--yes` | 无 |

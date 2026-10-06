# PiGO 浏览器 E2E（Playwright）

面向**已在运行**的 PiGO 部署的浏览器验收套件；套件自身从不启动服务。入口是
`playwright.config.ts`，共享夹具在 [`fixtures.ts`](./fixtures.ts)。

```sh
PI_E2E_BASE_URL=http://127.0.0.1:3100 \
PI_E2E_DEV_EMAIL=developer@localhost \
npx playwright test tests/e2e/acceptance.spec.ts --project=chromium --reporter=list
```

未安装浏览器或服务不可达时，套件**自动跳过**并在报告里写明原因（`e2eGuard`）。
这不算通过：`npm run gate:acceptance`（`scripts/e2e-suite-result.mjs`）在 0 个场景执行、
或 `docs/05` §13 的必需场景（E2E-01a/01b、E2E-02..08）被跳过/`fixme` 时报 FAIL，并逐条点名。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `PI_E2E_BASE_URL` | 目标服务地址（默认 `http://127.0.0.1:3100`）。 |
| `PI_E2E_DEV_EMAIL` | dev 身份，作为 `x-pigo-dev-email` 头（默认 `developer@localhost`）。 |
| `PI_E2E_WORKSPACE_PATH` | 可选：受控的相对路径；设置后启用工作区注册正向断言。 |
| `PI_E2E_LIVE` | `1` 时解锁生产验收场景（E2E-01..08），否则它们保持 `fixme`。 |
| `PI_E2E_WORKSPACE_ID` | 可选：E2E-02/05/07 指定工作区；否则取第一个 active 且未 dirty 的工作区。 |
| `PI_E2E_PREFLIGHT_PROVIDER` / `PI_E2E_PREFLIGHT_MODEL` / `PI_E2E_PREFLIGHT_CODE` | E2E-05 的「凭据有效但无权使用」审核模型契约。 |
| `PI_E2E_BUDGET_TOKENS` / `PI_E2E_BUDGET_COST` / `PI_E2E_BUDGET_TIMEOUT_MS` | E2E-07 的预算停止契约。 |
| `PI_E2E_REPAIR_TIMEOUT_MS` | E2E-02：等待第二轮通过检查并进入审核的时长（默认 `300000`）。 |

## 验收场景覆盖（`docs/05` §13）

| 场景 | 覆盖方式 | 前置条件 / 门控 |
| --- | --- | --- |
| E2E-01a 单 Agent 完整闭环（本地演示） | 真实执行 | `demoMode=true`（演示 runner）。 |
| E2E-01b 单 Agent 完整闭环（真实） | `fixme` + 未实现占位 | `PI_E2E_LIVE=1`；OTP 会话、Provider A/B 凭据、`fixture-small-auth` 工作区。 |
| **E2E-02 检查失败自动返修** | **真实执行（env 驱动）** | `realRunsAvailable=true` + active 且未 dirty 的工作区 + `/api/models` 中存在 developer/reviewer 可选模型。运行构造一个「首轮必然失败、续跑必然通过」的检查（标记文件写在工作树 Git 目录，见 `acceptance.spec.ts` 头注释），断言：首轮 `check.failed` → `checks.returned`（未进入审核）→ 第 2 轮 `round.started` 且 Developer 会话 `resumed` → 第 2 轮全量重跑检查 `check.passed` → 才 `review.started`。第二轮到达审核后即取消该 Run（不校验审核结论）。 |
| E2E-03 审核退回自动返修 | 真实执行 | `demoMode=true`（演示 runner 复现 review→repair→approve）。 |
| E2E-04 并行 Sub Agent | `fixme` + 未实现占位 | `PI_E2E_LIVE=1`；`fixture-parallel-app` + 真实 Worker/凭据。 |
| **E2E-05 Provider 故障不浪费开发成本** | **真实执行（env 驱动）** | `PI_E2E_PREFLIGHT_PROVIDER`/`_MODEL`（可选 `_CODE`）+ `realRunsAvailable=true` + 工作区。 |
| E2E-06 Worker 崩溃恢复 | `fixme` + 未实现占位 | `PI_E2E_LIVE=1`；可强杀重启的 Worker + 真实 PostgreSQL。 |
| **E2E-07 预算停止** | **真实执行（env 驱动）** | `PI_E2E_BUDGET_TOKENS`/`_COST`（至少其一，可选 `_TIMEOUT_MS`）+ `realRunsAvailable=true` + 工作区。 |
| E2E-08 恶意仓库隔离 | `fixme` + 未实现占位 | `PI_E2E_LIVE=1`；恶意夹具 + 隔离 Worker。 |

其它 spec：`auth.spec.ts`、`workspaces.spec.ts`、`runs.spec.ts`、`errors.spec.ts`、
`reconnect.spec.ts`、`i18n.spec.ts`、`mobile.spec.ts`（`@mobile`，用 `--project=mobile` 运行）。

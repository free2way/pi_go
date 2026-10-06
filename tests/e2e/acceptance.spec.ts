import type { APIRequestContext, Page } from "@playwright/test";
import { E2E_LIVE_ACCEPTANCE, configStatus, expect, openRunByTitle, stopRun, test } from "./fixtures";

/**
 * Acceptance-scenario coverage map for docs/05-acceptance-test-specification.md §13
 * (E2E-01 .. E2E-08).
 *
 * Each scenario has one `test.describe`. Where the current dev-auth / local
 * harness can safely drive the flow (demo runner, seeded run), the test is
 * implemented and runs. Where the scenario needs production-only preconditions
 * (Cloudflare OTP, the fixture repositories, a crashed/restarted Worker) the test
 * is marked `fixme` by default with the reason recorded, and only enabled in a
 * live acceptance environment via `PI_E2E_LIVE=1`.
 *
 * E2E-05 (provider preflight) and E2E-07 (budget stop) are *real* tests: they no
 * longer use `fixme`. Each one is driven entirely by environment variables and
 * either runs its assertions or skips with a precise, actionable reason. That
 * means the acceptance gate still FAILs while such a scenario is skipped — the
 * gate's `PI_E2E_ALLOW_REQUIRED_SKIPS=1` + `..._REASON` override (or a fully
 * configured environment) is the honest way to handle that, never a silent pass.
 *
 * ---------------------------------------------------------------------------
 * E2E-05 — Provider 故障不浪费开发成本: environment contract
 * ---------------------------------------------------------------------------
 *   PI_E2E_PREFLIGHT_PROVIDER  (required) provider of a reviewer model whose
 *                              credential is valid but which the provider is
 *                              not entitled to serve (e.g. an unverified model
 *                              on a live-verified provider).
 *   PI_E2E_PREFLIGHT_MODEL     (required) that model name.
 *   PI_E2E_PREFLIGHT_CODE      (optional) expected preflight code; one of
 *                              MODEL_NOT_ALLOWED / MODEL_NOT_AVAILABLE /
 *                              MODEL_UNAVAILABLE / MODEL_NOT_FOUND. When unset
 *                              any of those codes is accepted.
 *   PI_E2E_WORKSPACE_ID        (optional) workspace to target; otherwise the
 *                              first active, non-dirty registered workspace.
 *   The developer-role selection is NOT taken from the deployment default: the
 *   test pins it explicitly from `/api/models` (the first entry the preflight
 *   would accept for `developer`), so the rejection is unambiguously the
 *   reviewer pair. It skips with a precise reason only when the catalogue has no
 *   usable developer model at all.
 *   Also requires the deployment to report `realRunsAvailable: true`
 *   (`PI_REAL_RUNS_ENABLED=true` + `PI_INTERNAL_TOKEN` + ≥1 configured provider
 *   credential) and an active, non-dirty workspace.
 *
 * Example live configuration (the demo stack, docs/25-demo-environment.md, has
 * no credentials or workspaces, so this scenario skips there):
 *   - an explicit allowlist (`PI_MODEL_CATALOG_JSON`) whose entry does not carry
 *     the `reviewer` role  →  MODEL_NOT_ALLOWED, or
 *   - a provider whose live verification returned a `verifiedModels` list that
 *     does not contain the model  →  MODEL_NOT_AVAILABLE (model_unverified).
 *
 * ---------------------------------------------------------------------------
 * E2E-07 — 预算停止: environment contract
 * ---------------------------------------------------------------------------
 *   PI_E2E_BUDGET_TOKENS       (one of the two required) expected value of the
 *                              deployment's `PI_RUN_MAX_TOKENS`, i.e. the
 *                              `run.budget.maxTokens` frozen at creation.
 *   PI_E2E_BUDGET_COST         (one of the two required) expected value of the
 *                              deployment's `PI_RUN_MAX_COST_USD`.
 *   PI_E2E_BUDGET_TIMEOUT_MS   (optional) how long to wait for the run to park,
 *                              default 480000 (8 min).
 *   PI_E2E_WORKSPACE_ID        (optional) as above.
 *   Also requires `realRunsAvailable: true` and a workspace.
 *
 * Example live configuration: `PI_RUN_MAX_TOKENS=20000` on both the web and the
 * worker process, plus `PI_E2E_BUDGET_TOKENS=20000` here (or
 * `PI_RUN_MAX_COST_USD=0.003` + `PI_E2E_BUDGET_COST=0.003`) so the spec can
 * prove the budget frozen on the run matches what the worker enforces.
 */

const DEMO_TASK = "验收场景端到端验证：覆盖 docs/05 §13 中本地开发环境可安全驱动的路径。";

const LIVE_REASON_PREFIX = "生产验收场景需要真实环境，设置 PI_E2E_LIVE=1 后在验收环境启用。";

function requireLiveAcceptance(reason: string): void {
  // Annotate first so the precondition list is visible even in `fixme` reports.
  test.info().annotations.push({ type: "preconditions", description: reason });
  test.fixme(!E2E_LIVE_ACCEPTANCE, `${LIVE_REASON_PREFIX} 前置条件：${reason}`);
}

/** Marker used by not-yet-implemented live scenarios so enabling LIVE cannot pass falsely. */
function notImplementedYet(scenario: string, steps: string): void {
  test.skip(true, `${scenario} 尚未实现：${steps}`);
}

async function createDemoRun(request: APIRequestContext, title: string) {
  const response = await request.post("/api/runs", {
    data: { title, task: DEMO_TASK, repository: "demo/auth-service", mode: "demo" },
  });
  expect(response.ok()).toBeTruthy();
  return response;
}

async function expectCompleted(page: Page, timeout = 60_000): Promise<void> {
  await expect(page.locator(".status-pill.status-completed")).toBeVisible({ timeout });
}

// ---------------------------------------------------------------------------
// Shared helpers for the env-driven real-run acceptance scenarios (E2E-05/07).
// ---------------------------------------------------------------------------

/** Minimal shapes of the existing API responses (no new product fields). */
type AcceptanceRun = {
  id: string;
  title: string;
  state: string;
  summary?: string;
  diff?: string;
  modelCalls?: number;
  budget?: { maxTokens: number; maxCostUsd: number; maxModelCalls: number; maxDurationSeconds: number };
};
type AcceptanceEvent = { seq: number; type: string; message: string; at: string };
type AcceptanceArtifact = { artifactId: string; kind: string; bytes: number };

/** Run states in which the worker may still start a new model call. */
const ACTIVE_RUN_STATES = ["queued", "preparing", "developing", "checking", "reviewing"];

/** Trims and treats an empty value as unset, so `VAR=` cannot look configured. */
function envValue(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  return raw ? raw : undefined;
}

/** Task text for the runs these scenarios create; clearly named, minimal scope. */
const ACCEPTANCE_TASK = "验收场景端到端验证：由 tests/e2e/acceptance.spec.ts 的 E2E-05/E2E-07 驱动（docs/05 §13）。";

/**
 * Workspace targeted by the env-driven scenarios: an explicit
 * `PI_E2E_WORKSPACE_ID`, else the first active, non-dirty registered workspace.
 * A dirty workspace is skipped because the run preflight rejects it (409
 * WORKSPACE_DIRTY) before it ever reaches the model/budget logic under test.
 */
async function resolveAcceptanceWorkspace(request: APIRequestContext): Promise<string | undefined> {
  const explicit = envValue("PI_E2E_WORKSPACE_ID");
  if (explicit) return explicit;
  const response = await request.get("/api/workspaces");
  if (!response.ok()) return undefined;
  const body = (await response.json()) as {
    workspaces?: Array<{ id: string; status: string; git?: { dirty?: boolean } }>;
  };
  return (body.workspaces ?? []).find((workspace) => workspace.status === "active" && !workspace.git?.dirty)?.id;
}

/**
 * Developer-role model this scenario pins explicitly, so E2E-05 does not depend
 * on the deployment's `PI_MODEL_DEFAULT_DEVELOPER` (or its built-in default).
 * Taken from the same `/api/models` projection the create-run dialog uses, and
 * only from an entry `POST /api/runs` would accept for `developer` (the additive
 * `selectableRoles` verdict, else `roles` + `available`), so the pinned role
 * cannot itself trip the preflight. Returns undefined only when the catalogue
 * has no usable developer model at all — a deployment precondition the test
 * reports (and skips) instead of guessing a pair.
 */
async function resolveDeveloperSelection(
  request: APIRequestContext,
): Promise<{ provider: string; model: string } | undefined> {
  const response = await request.get("/api/models");
  if (!response.ok()) return undefined;
  const body = (await response.json()) as {
    models?: Array<{
      provider: string;
      model: string;
      roles?: string[];
      available?: boolean;
      selectableRoles?: string[];
    }>;
  };
  const entry = (body.models ?? []).find((item) =>
    Array.isArray(item.selectableRoles)
      ? item.selectableRoles.includes("developer")
      : Boolean(item.roles?.includes("developer")) && item.available === true,
  );
  return entry ? { provider: entry.provider, model: entry.model } : undefined;
}

async function listRuns(request: APIRequestContext): Promise<AcceptanceRun[]> {
  const response = await request.get("/api/runs");
  expect(response.ok(), `GET /api/runs failed with HTTP ${response.status()}`).toBeTruthy();
  return (await response.json()) as AcceptanceRun[];
}

async function getRun(request: APIRequestContext, runId: string): Promise<AcceptanceRun> {
  const response = await request.get(`/api/runs/${runId}`);
  expect(response.ok(), `GET /api/runs/${runId} failed with HTTP ${response.status()}`).toBeTruthy();
  return (await response.json()) as AcceptanceRun;
}

async function getRunEvents(request: APIRequestContext, runId: string): Promise<AcceptanceEvent[]> {
  const response = await request.get(`/api/runs/${runId}/events`);
  expect(response.ok(), `GET /api/runs/${runId}/events failed with HTTP ${response.status()}`).toBeTruthy();
  return (await response.json()) as AcceptanceEvent[];
}

/** Best-effort cleanup: cancel only a run that is still in flight. */
async function cancelIfActive(request: APIRequestContext, runId: string): Promise<void> {
  try {
    const run = await getRun(request, runId);
    if (ACTIVE_RUN_STATES.includes(run.state)) await stopRun(request, runId);
  } catch {
    // The server is gone or the run already reached a terminal state.
  }
}

// ---------------------------------------------------------------------------
// E2E-01 — 单 Agent 完整闭环 (docs/05 §13, "E2E-01：单 Agent 完整闭环")
// ---------------------------------------------------------------------------
test.describe("E2E-01 单 Agent 完整闭环", () => {
  test("E2E-01a 本地演示闭环：单个 Developer、检查与复审通过、Diff/用量/日志可见", async ({ page, request }) => {
    const config = await configStatus(request);
    test.skip(!config.demoMode, "Demo mode is disabled (PI_DEMO_MODE=false); the demo runner is the only local harness.");

    const title = `E2E-01 演示闭环 ${Date.now()}`;
    await page.goto("/");
    await page.getByRole("button", { name: /新建任务/ }).click();
    await expect(page.getByRole("heading", { name: "创建开发任务" })).toBeVisible();
    await page.getByLabel("任务名称").fill(title);
    await page.getByRole("button", { name: "运行演示" }).click();
    await expect(page.locator(".run-heading h1")).toHaveText(title, { timeout: 20_000 });
    await expect(page.locator(".demo-chip")).toContainText("演示数据");

    // Steps 6-8 (develop → checks → review): the demo runner walks the full
    // state machine and its timeline carries the check/review milestones.
    await expectCompleted(page);
    const messages = await page.locator(".timeline-item .timeline-content strong").allInnerTexts();
    expect(messages.join("\n")).toContain("3 项确定性检查全部通过");
    expect(messages.join("\n")).toContain("复审通过，等待人工合并");

    // "只有一个 Developer": exactly one developer node in the topology, and no
    // parallel sub-agent plan was created for this single-agent fixture.
    await expect(page.locator(".flow-card.flow-developer")).toHaveCount(1);
    await expect(page.locator(".flow-card.flow-developer .flow-title")).toHaveText("DeepSeek 开发");
    await page.getByRole("button", { name: /^Agents/ }).click();
    await expect(page.getByText("主 Agent 尚未生成任务计划")).toBeVisible();

    // Checks all pass.
    await page.getByRole("button", { name: "检查", exact: true }).click();
    await expect(page.locator(".check-row")).toHaveCount(3);
    await expect(page.locator(".check-icon.check-passed")).toHaveCount(3);

    // Review approved: the single high finding ends resolved.
    await page.getByRole("button", { name: /^审核/ }).click();
    await expect(page.locator(".finding")).toHaveCount(1);
    await expect(page.locator(".finding em")).toContainText("已解决");

    // Diff + downloadable artifact.
    await page.getByRole("button", { name: "Diff", exact: true }).click();
    await expect(page.locator(".diff-view")).toContainText("diff --git");
    await expect(page.getByRole("link", { name: /下载完整 Diff/ })).toBeVisible();

    // Usage / budget panel.
    await expect(page.locator(".metrics-grid")).toContainText("Tokens");
    await expect(page.locator(".metrics-grid")).toContainText("估算成本");
    await page.getByRole("button", { name: "预算与用量" }).click();
    await expect(page.locator(".budget-row")).toHaveCount(4);

    // Terminal state does not auto push/merge (docs/05 E2E-01 pass criteria).
    await expect(page.getByRole("button", { name: /推送|合并/ })).toHaveCount(0);
    await expect(page.locator(".status-pill.status-completed")).toContainText("已通过");
  });

  test("E2E-01b 真实闭环：OTP 登录 + Provider A 开发 + Provider B 审核 + fixture-small-auth + 人工 Approve（fixme：需生产验收环境）", async ({ request }) => {
    requireLiveAcceptance(
      "Cloudflare OTP 会话、已配置的 Provider A/B 凭据、已注册的 fixture-small-auth 工作区（真实 runs 启用）。",
    );
    const config = await configStatus(request);
    test.skip(!config.realRunsAvailable, "PI_REAL_RUNS_ENABLED=false 或凭据未配置。");
    notImplementedYet(
      "E2E-01b",
      "步骤：1 OTP 登录 2 选择工作区 3 选择两个不同模型 4 提交修复任务+3 条验收条件 5 Planner=small 6 Developer 改码 7 检查通过 8 Reviewer approved 9 人工 Approve；断言唯一 Developer、模型与选择一致、状态顺序、无自动 push/merge、usage/日志/Diff/制品完整。",
    );
  });
});

// ---------------------------------------------------------------------------
// E2E-02 — 检查失败自动返修
// ---------------------------------------------------------------------------
test.describe("E2E-02 检查失败自动返修", () => {
  test("E2E-02 第一轮检查失败 → Reviewer 不启动 → 复用会话修复 → 第二轮全量检查通过（fixme：需生产验收环境）", async ({ request }) => {
    requireLiveAcceptance(
      "可控失败检查的 fixture 仓库（第一版实现必然使一条检查失败）+ 真实 Pi Worker 与两张真实 Provider 凭据。",
    );
    const config = await configStatus(request);
    test.skip(!config.realRunsAvailable, "PI_REAL_RUNS_ENABLED=false 或凭据未配置。");
    notImplementedYet(
      "E2E-02",
      "断言：失败检查后未出现 review.started；第二轮 round=2 且 Developer 复用会话；第二轮重新执行所有必需检查；检查通过后才进入审核。",
    );
  });
});

// ---------------------------------------------------------------------------
// E2E-03 — 审核退回自动返修
// ---------------------------------------------------------------------------
test.describe("E2E-03 审核退回自动返修", () => {
  test("E2E-03 第一轮 high finding → 返修 → finding resolved、第二轮通过后 approved", async ({ page, request }) => {
    const config = await configStatus(request);
    test.skip(!config.demoMode, "Demo mode is disabled; the demo runner reproduces the review→repair→approve cycle.");

    const title = `E2E-03 审核返修 ${Date.now()}`;
    await createDemoRun(request, title);
    await page.goto("/");
    await openRunByTitle(page, title);
    await expectCompleted(page);

    // First round produced exactly one structured high finding with file/line/
    // evidence/requiredChange (docs/05 E2E-03 pass criteria).
    await page.getByRole("button", { name: /^审核/ }).click();
    const finding = page.locator(".finding").first();
    await expect(finding).toBeVisible();
    await expect(finding).toHaveClass(/finding-high/);
    await expect(finding.locator("code")).toContainText("src/auth/session.ts:46");
    await expect(finding.locator("p")).toContainText("refresh promise 被缓存");
    await expect(finding.locator(".required-change")).toContainText("使用 finally 清理 refreshLocks");
    // After the repair round the original finding is marked resolved.
    await expect(finding.locator("em")).toContainText("已解决");

    // The reviewing→developing back-edge is visible in the activity timeline.
    await page.getByRole("button", { name: "活动", exact: true }).click();
    await expect(page.locator(".timeline-item.source-reviewer", { hasText: "审核发现 1 个高优先级问题，已退回 DeepSeek" })).toBeVisible();
    await expect(page.locator(".timeline-item", { hasText: "开始第二轮修复" })).toBeVisible();
    await expect(page.locator(".timeline-item.source-reviewer", { hasText: "review.changes_requested" })).toBeVisible();

    // Second review round is reached and approved.
    await expect(page.locator(".run-round strong")).toContainText("2");
    await expect(page.locator(".status-pill.status-completed")).toContainText("已通过");
  });
});

// ---------------------------------------------------------------------------
// E2E-04 — 并行 Sub Agent
// ---------------------------------------------------------------------------
test.describe("E2E-04 并行 Sub Agent", () => {
  test("E2E-04 fixture-parallel-app：同 wave 并行任务、独立 worktree、无冲突合并、Integrator 全局检查（fixme：需生产验收环境）", async ({ request }) => {
    requireLiveAcceptance(
      "fixture-parallel-app 工作区 + 真实 Pi Worker（允许多进程并行）+ 真实 Provider 凭据。",
    );
    const config = await configStatus(request);
    test.skip(!config.realRunsAvailable, "PI_REAL_RUNS_ENABLED=false 或凭据未配置。");
    notImplementedYet(
      "E2E-04",
      "断言：Plan 至少两个同 wave 任务；两个 Pi Session 并行且 worktree 不同；改动范围可解释；合并无冲突；Integrator 全局检查；独立 Reviewer 批准；Agents 面板显示并行证据。",
    );
  });
});

// ---------------------------------------------------------------------------
// E2E-05 — Provider 故障不浪费开发成本
//
// Real, env-driven test (docs/05 §13): a reviewer model whose provider
// credential is valid but which the provider is not entitled to serve must be
// rejected by the run preflight BEFORE the run is enqueued. Observable outcome:
// HTTP 422 with the specific preflight code/role, no run record at all (so no
// Developer/Planner call could have started and no default Reviewer was silently
// substituted), and the console never offers that model as a usable reviewer
// choice. See the file header for the PI_E2E_PREFLIGHT_* contract.
// ---------------------------------------------------------------------------
test.describe("E2E-05 Provider 故障不浪费开发成本", () => {
  test("E2E-05 凭据有效但无权使用的审核模型：Preflight 在入队前拦截、不启动 Developer、不静默回退（需 PI_E2E_PREFLIGHT_* 环境）", async ({ page, request }) => {
    const provider = envValue("PI_E2E_PREFLIGHT_PROVIDER");
    const model = envValue("PI_E2E_PREFLIGHT_MODEL");
    const expectedCode = envValue("PI_E2E_PREFLIGHT_CODE");
    const preconditions =
      "需要一个「凭据有效但无权用于审核角色」的 reviewer 模型：设置 PI_E2E_PREFLIGHT_PROVIDER 与 PI_E2E_PREFLIGHT_MODEL（可选 PI_E2E_PREFLIGHT_CODE=MODEL_NOT_ALLOWED|MODEL_NOT_AVAILABLE|MODEL_UNAVAILABLE|MODEL_NOT_FOUND）；部署需 realRunsAvailable=true（PI_REAL_RUNS_ENABLED=true + PI_INTERNAL_TOKEN + 已配置的 provider 凭据）以及一个 active 且未 dirty 的工作区（或设置 PI_E2E_WORKSPACE_ID）。";
    test.info().annotations.push({ type: "preconditions", description: preconditions });
    test.skip(!provider || !model, `E2E-05 未配置：${preconditions}`);
    if (expectedCode) {
      expect(
        ["MODEL_NOT_ALLOWED", "MODEL_NOT_AVAILABLE", "MODEL_UNAVAILABLE", "MODEL_NOT_FOUND"],
        `PI_E2E_PREFLIGHT_CODE=${expectedCode} 不是可识别的预检错误码`,
      ).toContain(expectedCode);
    }

    const config = await configStatus(request);
    test.skip(
      !config.realRunsAvailable,
      "E2E-05 需要真实运行环境：/api/config/status 报告 realRunsAvailable=false（需 PI_REAL_RUNS_ENABLED=true、PI_INTERNAL_TOKEN 以及至少一个已配置的 provider 凭据）。",
    );

    const workspaceId = await resolveAcceptanceWorkspace(request);
    test.skip(
      !workspaceId,
      "E2E-05 需要工作区：没有 active 且未 dirty 的已注册工作区（或设置 PI_E2E_WORKSPACE_ID 指定）。",
    );

    const title = `E2E-05 预检拦截 ${Date.now()}`;
    const before = await listRuns(request);

    // Self-contained scenario: pin BOTH roles explicitly instead of letting the
    // deployment default the developer. Only the reviewer selection is the
    // deliberately unusable one, so a rejection must be attributed to reviewer
    // (never to an unrelated default). The developer pair is resolved from the
    // live catalogue as a pair the preflight accepts, so the developer role
    // passes and the reviewer role is what fails.
    const developerModel = await resolveDeveloperSelection(request);
    test.skip(
      !developerModel,
      "E2E-05 需要一个可用于开发角色且可用的模型（/api/models 的 selectableRoles 含 developer）：没有它就无法把开发角色显式钉住，也无法把拒绝精确归因到 reviewer。",
    );
    const response = await request.post("/api/runs", {
      data: {
        title,
        task: ACCEPTANCE_TASK,
        mode: "real",
        workspaceId,
        checks: ["true"],
        developerModel,
        reviewerModel: { provider, model },
      },
    });
    const rawBody = await response.text();
    expect(response.status(), `Preflight 应在入队前以 422 拒绝，实际 HTTP ${response.status()}：${rawBody}`).toBe(422);
    const body = JSON.parse(rawBody) as { error?: string; code?: string; role?: string; runId?: string };

    // (a) the failure is specific and attributed to the reviewer role.
    expect(body.role, `预检拒绝必须归因到 reviewer 角色：${rawBody}`).toBe("reviewer");
    expect(
      ["MODEL_NOT_ALLOWED", "MODEL_NOT_AVAILABLE", "MODEL_UNAVAILABLE", "MODEL_NOT_FOUND"],
      `预检错误码不在预期集合内：${rawBody}`,
    ).toContain(body.code);
    if (expectedCode) expect(body.code).toBe(expectedCode);
    expect(body.error?.trim(), "预检必须返回可操作的具体错误文案").toBeTruthy();

    // (b) nothing was enqueued: a 422 carries no runId and the run list is
    // unchanged, so no Developer/Planner call started and no fallback model was
    // recorded (there is no run document to have substituted one).
    expect(body.runId, `预检失败不得创建 Run：${rawBody}`).toBeUndefined();
    const after = await listRuns(request);
    expect(after.filter((run) => run.title === title), "预检失败不得留下任何 Run").toHaveLength(0);
    expect(new Set(after.map((run) => run.id)), "预检失败不得改变 Run 列表").toEqual(new Set(before.map((run) => run.id)));

    // (c) the console tells the operator the model is unusable instead of
    // silently accepting it: the create-run dialog must not offer the rejected
    // (provider, model) pair as an *enabled* reviewer option. The exact pair is
    // matched, so a same-named model from another provider cannot mask it:
    // the pair is absent when the allow-list does not cover it (MODEL_NOT_FOUND /
    // MODEL_NOT_ALLOWED) and present-but-disabled with a reason when the provider
    // cannot serve it (MODEL_UNAVAILABLE / MODEL_NOT_AVAILABLE). That is the
    // page-level "re-select the model / fix the credentials" guidance, driven by
    // the same catalog + availability the preflight used.
    //
    // The select must EXIST: an earlier version wrapped the check in
    // `count() > 0`, so a dialog that never rendered the 审核模型 dropdown passed
    // vacuously. A missing dropdown is a UI regression, not evidence that the
    // rejected pair is unavailable — assert presence first, then the pair.
    await page.goto("/");
    await page.getByRole("button", { name: /新建任务/ }).click();
    await page.getByRole("button", { name: "真实开发" }).click();
    const reviewerSelect = page.getByLabel("审核模型");
    await expect(reviewerSelect, "真实开发模式的创建任务对话框必须渲染「审核模型」下拉").toBeVisible();
    // Option values are the exact `provider/model` ids; matching on the value
    // keeps this pair-precise (a same-named model from another provider, or a
    // longer model name sharing a prefix, cannot mask the rejected pair).
    const enabledOptions = await reviewerSelect
      .locator("option:not([disabled])")
      .evaluateAll((options) =>
        options.map((option) => ({ value: (option as HTMLOptionElement).value, text: option.textContent ?? "" })),
      );
    const pair = `${provider}/${model}`;
    expect(
      enabledOptions.filter((option) => option.value === pair).map((option) => option.text),
      `审核模型下拉不得把 ${pair} 作为可用选项（可用项：${enabledOptions.map((option) => option.value).join(", ") || "无"}）`,
    ).toEqual([]);
    await expect(page.locator(".run-item-main", { hasText: title }), "被拒绝的任务不得出现在任务列表中").toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// E2E-06 — Worker 崩溃恢复
// ---------------------------------------------------------------------------
test.describe("E2E-06 Worker 崩溃恢复", () => {
  test("E2E-06 开发完成写入 checkpoint 后强杀 Worker：Run 不卡死、调用不重复、seq 连续、按阶段续跑（fixme：需生产验收环境）", async ({ request }) => {
    requireLiveAcceptance(
      "真实 runs + 可强制重启的 Pi Worker 与真实 PostgreSQL（浏览器侧只能观察结果）。",
    );
    const config = await configStatus(request);
    test.skip(!config.realRunsAvailable, "PI_REAL_RUNS_ENABLED=false 或凭据未配置。");
    notImplementedYet(
      "E2E-06",
      "断言：Run 最终完成或明确转人工；Developer 已完成调用不重复；事件 seq 连续；从正确阶段继续。",
    );
  });
});

// ---------------------------------------------------------------------------
// E2E-07 — 预算停止
//
// Real, env-driven test (docs/05 §13): with a deliberately small run budget the
// worker must warn at ~80%, stop starting new model calls at 100%, park the run
// in `needs_human` with a `run.budget_exhausted` event, and retain its work
// products. The spec never invents a budget field: it reads the `run.budget`
// the API already freezes at creation and compares it with PI_E2E_BUDGET_*.
// ---------------------------------------------------------------------------
test.describe("E2E-07 预算停止", () => {
  test("E2E-07 预算仅够 Planning：80% 预警、达上限停止调用、进入 needs_human、制品保留（需 PI_E2E_BUDGET_* 环境）", async ({ page, request }) => {
    const tokensRaw = envValue("PI_E2E_BUDGET_TOKENS");
    const costRaw = envValue("PI_E2E_BUDGET_COST");
    const tokens = tokensRaw === undefined ? undefined : Number(tokensRaw);
    const cost = costRaw === undefined ? undefined : Number(costRaw);
    // Validate the contract before deciding to skip, so a typo fails loudly
    // instead of silently turning into "not configured".
    if (tokensRaw !== undefined) expect(Number.isFinite(tokens) && (tokens as number) > 0, `PI_E2E_BUDGET_TOKENS=${tokensRaw} 必须是 >0 的数字`).toBe(true);
    if (costRaw !== undefined) expect(Number.isFinite(cost) && (cost as number) > 0, `PI_E2E_BUDGET_COST=${costRaw} 必须是 >0 的数字`).toBe(true);

    const configuredWait = Number(envValue("PI_E2E_BUDGET_TIMEOUT_MS") ?? 480_000);
    const waitMs = Number.isFinite(configuredWait) && configuredWait > 0 ? configuredWait : 480_000;
    const preconditions =
      `需要一个「预算只够 Planning、不足以进入第二轮」的真实运行部署：设置 PI_RUN_MAX_TOKENS / PI_RUN_MAX_COST_USD（0=不限），并把同样的期望值通过 PI_E2E_BUDGET_TOKENS / PI_E2E_BUDGET_COST（至少一个）告诉本用例以便核对 run.budget；可选 PI_E2E_BUDGET_TIMEOUT_MS（默认 480000）控制等待时长。另需 realRunsAvailable=true 与一个 active 且未 dirty 的工作区（或 PI_E2E_WORKSPACE_ID）。当前 PI_E2E_BUDGET_TOKENS=${tokensRaw ?? "(未设置)"}、PI_E2E_BUDGET_COST=${costRaw ?? "(未设置)"}。`;
    test.info().annotations.push({ type: "preconditions", description: preconditions });
    test.skip(!tokensRaw && !costRaw, `E2E-07 未配置：${preconditions}`);

    const config = await configStatus(request);
    test.skip(
      !config.realRunsAvailable,
      "E2E-07 需要真实运行环境：/api/config/status 报告 realRunsAvailable=false（需 PI_REAL_RUNS_ENABLED=true、PI_INTERNAL_TOKEN 以及至少一个已配置的 provider 凭据）。",
    );

    const workspaceId = await resolveAcceptanceWorkspace(request);
    test.skip(
      !workspaceId,
      "E2E-07 需要工作区：没有 active 且未 dirty 的已注册工作区（或设置 PI_E2E_WORKSPACE_ID 指定）。",
    );

    // A budget-limited real run can take minutes (planning must finish before the
    // cap is crossed); keep the test window aligned with the poll window.
    test.setTimeout(waitMs + 120_000);

    const title = `E2E-07 预算停止 ${Date.now()}`;
    const created = await request.post("/api/runs", {
      data: { title, task: ACCEPTANCE_TASK, mode: "real", workspaceId, checks: ["true"] },
    });
    expect(created.status(), `POST /api/runs 失败（${created.status()}）：${await created.text()}`).toBe(201);
    const runId = ((await created.json()) as AcceptanceRun).id;

    try {
      // (a) the frozen hard budget is the marker tying this deployment to the
      // PI_E2E_BUDGET_* expectations. A mismatch is an env-contract error and is
      // reported with the exact server variable to fix.
      const initial = await getRun(request, runId);
      expect(initial.budget, "Run 必须在创建时冻结 run.budget（GAP-01/COST-002）").toBeTruthy();
      if (tokens !== undefined) {
        expect(
          initial.budget?.maxTokens,
          `run.budget.maxTokens=${initial.budget?.maxTokens} 与 PI_E2E_BUDGET_TOKENS=${tokens} 不一致：部署端的 PI_RUN_MAX_TOKENS 必须等于 ${tokens}`,
        ).toBe(tokens);
      }
      if (cost !== undefined) {
        expect(
          initial.budget?.maxCostUsd,
          `run.budget.maxCostUsd=${initial.budget?.maxCostUsd} 与 PI_E2E_BUDGET_COST=${cost} 不一致：部署端的 PI_RUN_MAX_COST_USD 必须等于 ${cost}`,
        ).toBe(cost);
      }

      // (b) the run leaves the active states on its own (budget stop, not a
      // manual cancel) and parks for a human.
      let current = initial;
      await expect
        .poll(
          async () => {
            current = await getRun(request, runId);
            return !ACTIVE_RUN_STATES.includes(current.state);
          },
          {
            message: `Run ${runId} 未在 ${waitMs}ms 内离开运行态——预算可能没有生效，或部署的 PI_RUN_MAX_* 不够紧`,
            timeout: waitMs,
            intervals: [2_000, 5_000],
          },
        )
        .toBe(true);
      expect(current.state, `预算耗尽应进入 needs_human（实际 ${current.state}）：${current.summary ?? ""}`).toBe("needs_human");

      // (c) the ~80% warning and the 100% stop are recorded on the run's event
      // stream (run.budget_warning / run.budget_exhausted).
      let events: AcceptanceEvent[] = [];
      await expect
        .poll(
          async () => {
            events = await getRunEvents(request, runId);
            return events.some((event) => event.type === "run.budget_exhausted");
          },
          { message: `Run ${runId} 缺少 run.budget_exhausted 事件（100% 停止新调用）`, timeout: 60_000, intervals: [1_000, 3_000] },
        )
        .toBe(true);

      const warning = events.find((event) => event.type === "run.budget_warning");
      expect(warning, "达到预算 80% 必须记录 run.budget_warning").toBeTruthy();
      expect(warning!.message, "80% 预警文案必须标明 80%").toContain("80%");

      const exhaustedIndex = events.findIndex((event) => event.type === "run.budget_exhausted");
      const exhausted = events[exhaustedIndex];
      expect(exhausted.message).toContain("运行预算已用尽");
      expect(
        exhausted.message,
        `run.budget_exhausted 必须指出耗尽的维度：${exhausted.message}`,
      ).toMatch(/token 预算已用尽|费用预算已用尽|模型调用次数预算已用尽|运行时长预算已用尽/);

      // (d) no model call or stage may start after the cap was reached.
      current = await getRun(request, runId);
      const startedAfterStop = events
        .slice(exhaustedIndex + 1)
        .filter((event) => /^(plan|developer|review|checks)\./.test(event.type));
      expect(
        startedAfterStop.map((event) => `${event.type}: ${event.message}`),
        "预算耗尽后不得再出现新的模型调用/阶段事件",
      ).toEqual([]);
      expect(current.modelCalls ?? 0, "预算停止前应至少发生过一次模型调用尝试").toBeGreaterThan(0);

      // (e) work products are retained, not rolled back. This must be
      // non-vacuous: "the endpoint returned an array" is true for an empty
      // array, so it proves no retention at all. Instead:
      //  - when the run produced a diff, the `diff` artifact must be present
      //    with non-zero bytes and the download must be byte-for-byte identical
      //    to run.diff (a truncating/evicting regression fails here);
      //  - when the run legitimately stopped during Planning with no diff, the
      //    run document itself is the retained work product: it must still be
      //    retrievable with its identity and the budget frozen at creation, so a
      //    rollback/delete regression cannot pass as "there was nothing to show".
      const artifactResponse = await request.get(`/api/runs/${runId}/artifacts`);
      expect(artifactResponse.ok(), `GET /api/runs/${runId}/artifacts failed with HTTP ${artifactResponse.status()}`).toBeTruthy();
      const artifacts = ((await artifactResponse.json()) as { artifacts: AcceptanceArtifact[] }).artifacts;
      expect(Array.isArray(artifacts), "制品列表必须仍是数组（未被删除）").toBe(true);
      if (current.diff) {
        const diffArtifact = artifacts.find((artifact) => artifact.artifactId === "diff");
        expect(diffArtifact, `Run 有 diff 却未保留 diff 制品（现有制品：${artifacts.map((a) => a.artifactId).join(", ") || "无"}）`).toBeTruthy();
        expect(
          diffArtifact!.bytes,
          `保留的 diff 制品字节数必须非零，实际 ${diffArtifact!.bytes}（制品元数据被截断/清空即视为未保留）`,
        ).toBeGreaterThan(0);
        const download = await request.get(`/api/runs/${runId}/artifacts/diff/download`);
        expect(download.ok(), "保留的 diff 制品必须可下载").toBeTruthy();
        const downloaded = await download.text();
        expect(downloaded.length, "保留的 diff 制品下载内容不得为空").toBeGreaterThan(0);
        expect(downloaded, "保留的 diff 制品必须与 run.diff 字节一致").toBe(current.diff);
      } else {
        // Stopped during Planning (no diff to retain): prove the run document
        // survived with its frozen reproducible inputs intact.
        const retained = await getRun(request, runId);
        expect(retained.id, "Run 文档必须仍然保留").toBe(runId);
        expect(retained.state, "Run 文档必须仍然保留在停止态（needs_human）").toBe("needs_human");
        expect(retained.budget, "Run 文档冻结的 run.budget 必须仍然保留").toEqual(initial.budget);
        expect(retained.modelCalls ?? 0, "Run 文档保留的模型调用计数必须仍然保留").toBeGreaterThan(0);
      }

      // (f) the UI surfaces the same stop: needs_human status pill, the frozen
      // hard limit in the budget panel, and both milestones in the timeline.
      await page.goto("/");
      await openRunByTitle(page, title);
      const statusPill = page.locator(".status-pill.status-needs_human");
      await expect(statusPill).toBeVisible({ timeout: 20_000 });
      await expect(statusPill).toContainText("需要人工处理");

      await page.getByRole("button", { name: "预算与用量" }).click();
      if (tokens !== undefined) {
        const tokensRow = page.locator(".budget-row", { hasText: "Tokens" });
        await expect(tokensRow).toBeVisible();
        await expect(tokensRow.locator("em"), "预算面板必须显示 token 硬上限而不是「未设置上限」").not.toContainText("未设置上限");
      }

      await page.getByRole("button", { name: "活动", exact: true }).click();
      await expect(page.locator(".timeline-item", { hasText: "预算已使用 80%" })).toBeVisible();
      await expect(page.locator(".timeline-item", { hasText: "运行预算已用尽" })).toBeVisible();
    } finally {
      await cancelIfActive(request, runId);
    }
  });
});

// ---------------------------------------------------------------------------
// E2E-08 — 恶意仓库隔离
// ---------------------------------------------------------------------------
test.describe("E2E-08 恶意仓库隔离", () => {
  test("E2E-08 恶意夹具（路径 symlink、未批准 extension、提示注入）：不越权、不执行、Reviewer 不改代码、可审计（fixme：需生产验收环境）", async ({ request }) => {
    requireLiveAcceptance(
      "恶意仓库夹具 + 真实 Pi Worker（隔离进程/容器）+ 真实 Provider 凭据。",
    );
    const config = await configStatus(request);
    test.skip(!config.realRunsAvailable, "PI_REAL_RUNS_ENABLED=false 或凭据未配置。");
    notImplementedYet(
      "E2E-08",
      "断言：不能读取其他工作区或凭据；未批准 extension 不执行；Reviewer 不修改 Developer 成果；安全事件可审计；宿主其他容器/目录不受影响。注：本仓库 v0.20.2 审核报告 NEW-01/02 表明该场景当前会失败，属整改跟踪项。",
    );
  });
});

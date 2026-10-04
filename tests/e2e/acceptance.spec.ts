import type { APIRequestContext, Page } from "@playwright/test";
import { E2E_LIVE_ACCEPTANCE, configStatus, expect, openRunByTitle, test } from "./fixtures";

/**
 * Acceptance-scenario coverage map for docs/05-acceptance-test-specification.md §13
 * (E2E-01 .. E2E-08).
 *
 * Each scenario has one `test.describe`. Where the current dev-auth / local
 * harness can safely drive the flow (demo runner, seeded run), the test is
 * implemented and runs. Where the scenario needs production-only preconditions
 * (Cloudflare OTP, real provider credentials, the fixture repositories, a real
 * Pi Worker, budget env config, a crashed/restarted Worker) the test is marked
 * `fixme` by default with the reason recorded, and only enabled in a live
 * acceptance environment via `PI_E2E_LIVE=1`.
 *
 * Nothing is silently skipped: every marker carries a reason string and every
 * remaining scenario keeps an implementation checklist.
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
// ---------------------------------------------------------------------------
test.describe("E2E-05 Provider 故障不浪费开发成本", () => {
  test("E2E-05 凭据有效但无权使用的审核模型：Preflight 在入队前拦截、不启动 Developer、不静默回退（fixme：需生产验收环境）", async ({ request }) => {
    requireLiveAcceptance(
      "真实 runs 环境 + 一个凭据有效但无权使用的 reviewer 模型（或可注入的 403 组合）。",
    );
    const config = await configStatus(request);
    test.skip(!config.realRunsAvailable, "PI_REAL_RUNS_ENABLED=false 或凭据未配置。");
    notImplementedYet(
      "E2E-05",
      "断言：创建请求被 Preflight 以 422 拒绝且未产生 run；页面提示重新选择模型或更新凭据；未出现 Developer 调用；未静默切换到默认 Reviewer。",
    );
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
// ---------------------------------------------------------------------------
test.describe("E2E-07 预算停止", () => {
  test("E2E-07 预算仅够 Planning：80% 预警、达上限停止调用、进入 needs_human、制品保留（fixme：需生产验收环境）", async ({ request }) => {
    requireLiveAcceptance(
      "可配置 PI_RUN_BUDGET_* 的验收部署 + 真实 Provider 凭据（预算不足需真实调用计费）。",
    );
    const config = await configStatus(request);
    test.skip(!config.realRunsAvailable, "PI_REAL_RUNS_ENABLED=false 或凭据未配置。");
    notImplementedYet(
      "E2E-07",
      "断言：预算面板显示 80% 预警；达到上限后不再新增模型调用；Run 进入 needs_human；现有代码与制品保留。",
    );
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

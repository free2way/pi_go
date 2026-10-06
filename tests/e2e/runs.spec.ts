import type { APIRequestContext } from "@playwright/test";
import { expect, openRunByTitle, test } from "./fixtures";

type ConfigStatus = { demoMode: boolean; realRunsAvailable: boolean };
type WorkspaceList = { workspaces: Array<{ status: string }> };

async function configStatus(request: APIRequestContext): Promise<ConfigStatus> {
  const response = await request.get("/api/config/status");
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as ConfigStatus;
}

/**
 * Core run flows against the running server:
 * - creating a demo run from the dialog (including the mode picker),
 * - developer/reviewer model selection in real mode (skipped unless the
 *   deployment enables real runs and has an active workspace),
 * - the run detail page: budget/usage metrics, activity timeline, checks and
 *   diff panels, and SSE reconnect/replay.
 */
test.describe("run creation and run detail", () => {
  test("creates a demo run from the dialog and shows the detail dashboard", async ({ page, request }) => {
    const config = await configStatus(request);
    test.skip(!config.demoMode, "Demo mode is disabled (PI_DEMO_MODE=false); this flow needs the demo runner.");

    const title = `E2E 演示任务 ${Date.now()}`;
    await page.goto("/");
    await page.getByRole("button", { name: /新建任务/ }).click();
    await expect(page.getByRole("heading", { name: "创建开发任务" })).toBeVisible();

    await page.getByLabel("任务名称").fill(title);
    await page.getByRole("button", { name: "运行演示" }).click();

    // Landed on the run detail page for the new run.
    await expect(page.locator(".run-heading h1")).toHaveText(title);

    // Budget/usage metrics panel (state, duration, tokens, estimated cost).
    const metrics = page.locator(".metrics-grid");
    await expect(metrics).toContainText("Tokens");
    await expect(metrics).toContainText("估算成本");
    await expect(metrics).toContainText("状态");

    // The controlled React Flow nodes must stay initialized after SSE replaces
    // the run/event snapshots. A regression here leaves a dotted blank canvas.
    const topology = page.locator("#workflow-topology");
    await expect(topology.locator(".react-flow__node")).toHaveCount(6);
    await expect(topology.locator(".react-flow__node").first()).toBeVisible();
    await expect.poll(() => topology.locator(".react-flow__edge").count()).toBeGreaterThanOrEqual(5);

    // Activity timeline fills in from the demo event stream.
    await expect(page.locator(".timeline-item").first()).toBeVisible({ timeout: 20_000 });

    // Checks panel lists the deterministic checks.
    await page.getByRole("button", { name: "检查", exact: true }).click();
    await expect(page.locator(".check-row").first()).toBeVisible();

    // Diff panel eventually shows the demo patch (populated by the runner).
    await page.getByRole("button", { name: "Diff", exact: true }).click();
    await expect(page.locator(".diff-view")).toBeVisible({ timeout: 20_000 });

    // Cleanup: stop the demo run so it cannot keep mutating the run ordering.
    const stop = page.getByRole("button", { name: "停止" });
    if (await stop.isVisible().catch(() => false)) await stop.click();
  });

  test("offers developer/reviewer model selection when real runs are available", async ({ page, request }) => {
    const config = await configStatus(request);
    test.skip(!config.realRunsAvailable, "Real runs are unavailable (needs PI_REAL_RUNS_ENABLED=true and configured credentials).");

    const list = (await (await request.get("/api/workspaces")).json()) as WorkspaceList;
    const active = (list.workspaces ?? []).filter((workspace) => workspace.status === "active");
    test.skip(active.length === 0, "No active registered workspace; register one first (see tests/e2e/README.md).");

    await page.goto("/");
    await page.getByRole("button", { name: /新建任务/ }).click();
    await page.getByRole("button", { name: "真实开发" }).click();

    const developerModel = page.getByLabel("开发模型");
    const reviewerModel = page.getByLabel("审核模型");
    await expect(developerModel).toBeVisible();
    await expect(reviewerModel).toBeVisible();
    await expect(developerModel.locator("option")).not.toHaveCount(0);
    await expect(reviewerModel.locator("option")).not.toHaveCount(0);
  });

  test("run detail survives an SSE reconnect and replays events", async ({ page, request }) => {
    const config = await configStatus(request);
    test.skip(!config.demoMode, "Demo mode is disabled; this flow uses the deterministic demo runner.");

    const title = `E2E SSE ${Date.now()}`;
    const created = await request.post("/api/runs", {
      data: { title, task: "验证事件流在断线重连后继续推送并可回放。", repository: "demo/auth-service", mode: "demo" },
    });
    expect(created.ok()).toBeTruthy();

    // Abort the first EventSource connection so the browser must reconnect.
    let aborted = 0;
    await page.route(/\/api\/runs\/[^/]+\/stream/, async (route) => {
      if (aborted === 0) {
        aborted += 1;
        await route.abort();
        return;
      }
      await route.continue();
    });

    await page.goto("/");
    const runItem = page.locator(".run-item-main", { hasText: title });
    await expect(runItem).toBeVisible({ timeout: 20_000 });
    await runItem.click();
    await expect(page.locator(".run-heading h1")).toHaveText(title);

    // Events are replayed on the re-established stream (initial REST fetch may
    // already have delivered some, so this tolerates either path).
    await expect(page.locator(".timeline-item").first()).toBeVisible({ timeout: 20_000 });
    expect(aborted).toBeGreaterThan(0);

    // Once connected, the live stream keeps appending new events.
    const seen = await page.locator(".timeline-item").count();
    await expect(page.locator(".timeline-item")).not.toHaveCount(seen, { timeout: 20_000 });

    // A full reload re-runs the replay path and still shows the run + events.
    // The app has no URL routing for run ids and re-selects the newest run on
    // load (fixtures.ts `openRunByTitle`); when the first test's demo run is
    // still ticking, that newest run is NOT the run under test, so re-select it
    // explicitly instead of assuming it lands as `runs[0]` after the reload.
    await page.reload();
    await openRunByTitle(page, title);
    await expect(page.locator(".timeline-item").first()).toBeVisible({ timeout: 20_000 });
  });
});

import type { APIRequestContext } from "@playwright/test";
import { configStatus, expect, openRunByTitle, stopRun, test, timelineMessages, trackPageErrors } from "./fixtures";

/**
 * Refresh / reconnect coverage (v0.20.2 review §4: refresh + offline flows were
 * unverified, and AUD-17 asked for a real browser reconnect/offline run).
 *
 * The app has no URL routing for run ids, so "reload the run detail page" is
 * performed as: reload → re-select the run from the sidebar, which re-runs the
 * REST snapshot + SSE replay path (Last-Event-ID resume is server-driven).
 */

const DEMO_TASK = "重连与刷新端到端验证：确认事件流回放不会产生重复可见行。";

async function createDemoRun(request: APIRequestContext, title: string): Promise<string> {
  const response = await request.post("/api/runs", {
    data: { title, task: DEMO_TASK, repository: "demo/auth-service", mode: "demo" },
  });
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as { id: string }).id;
}

test.describe("refresh and reconnect", () => {
  test("reload re-hydrates the run and replays events without duplicated rows", async ({ page, request }) => {
    const config = await configStatus(request);
    test.skip(!config.demoMode, "Demo mode is disabled (PI_DEMO_MODE=false); this flow uses the deterministic demo runner.");

    const title = `E2E 刷新 ${Date.now()}`;
    const runId = await createDemoRun(request, title);
    try {
      const pageErrors = trackPageErrors(page);
      await page.goto("/");
      await openRunByTitle(page, title);
      await expect(page.locator(".timeline-item").first()).toBeVisible({ timeout: 20_000 });

      const before = await timelineMessages(page);
      expect(before.length).toBeGreaterThan(0);
      expect(new Set(before).size, `duplicate timeline rows before reload: ${before.join(" | ")}`).toBe(before.length);

      await page.reload();
      await openRunByTitle(page, title);
      await expect(page.locator(".timeline-item").first()).toBeVisible({ timeout: 20_000 });
      // Let the REST snapshot and the SSE replay merge settle.
      await page.waitForTimeout(1_000);

      const after = await timelineMessages(page);
      expect(new Set(after).size, `duplicate timeline rows after reload: ${after.join(" | ")}`).toBe(after.length);
      expect(after.length).toBeGreaterThanOrEqual(before.length);
      expect(pageErrors, `uncaught page errors during reload: ${pageErrors.join(" | ")}`).toEqual([]);
    } finally {
      await stopRun(request, runId);
    }
  });

  test("offline degrades gracefully and the stream resumes once back online", async ({ page, request, context }) => {
    const config = await configStatus(request);
    test.skip(!config.demoMode, "Demo mode is disabled; this flow uses the deterministic demo runner.");

    const title = `E2E 离线 ${Date.now()}`;
    const runId = await createDemoRun(request, title);
    try {
      const pageErrors = trackPageErrors(page);
      await page.goto("/");
      await openRunByTitle(page, title);
      await expect(page.locator(".timeline-item").first()).toBeVisible({ timeout: 20_000 });

      const onlineCount = await page.locator(".timeline-item").count();

      await context.setOffline(true);
      // While offline the console keeps the last known run and stays interactive
      // (no blank page, no crash) even though the EventSource cannot reconnect.
      await expect(page.locator(".run-heading h1")).toHaveText(title);
      await page.waitForTimeout(2_000);
      await expect(page.locator(".run-heading h1")).toHaveText(title);
      await expect(page.locator(".timeline-item").first()).toBeVisible();

      await context.setOffline(false);
      // The EventSource auto-reconnects and resumes from its Last-Event-ID
      // watermark, so new demo events keep appending without a manual reload.
      await expect
        .poll(() => page.locator(".timeline-item").count(), { timeout: 30_000, message: "expected the SSE stream to resume after coming back online" })
        .toBeGreaterThan(onlineCount);
      expect(pageErrors, `uncaught page errors during offline/reconnect: ${pageErrors.join(" | ")}`).toEqual([]);
    } finally {
      await context.setOffline(false);
      await stopRun(request, runId);
    }
  });
});

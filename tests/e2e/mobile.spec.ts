import { configStatus, expect, openRunByTitle, stopRun, test } from "./fixtures";

/**
 * Mobile viewport coverage (v0.20.2 review §4: mobile was not exercised).
 *
 * Every test title carries the `@mobile` tag; playwright.config.ts runs these
 * only under the `mobile` project (iPhone 13, 390x844, isMobile) via `grep`,
 * and excludes them from the desktop `chromium` project via `grepInvert`.
 */

const DEMO_TASK = "移动端端到端验证：确认核心只读流程可用且无横向溢出。";

/** Asserts the document does not scroll horizontally (1px tolerance). */
async function expectNoHorizontalOverflow(page: import("@playwright/test").Page, label: string): Promise<void> {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(
    metrics.scrollWidth,
    `${label} overflows horizontally: scrollWidth=${metrics.scrollWidth} > innerWidth=${metrics.innerWidth}`,
  ).toBeLessThanOrEqual(metrics.innerWidth + 1);
}

/**
 * Opens the off-canvas sidebar on mobile. Navigating between top-level pages
 * keeps the sidebar open (only selecting a run closes it), so close it first
 * when it is already open or it would intercept the hamburger click.
 */
async function openSidebar(page: import("@playwright/test").Page): Promise<void> {
  const sidebar = page.locator(".sidebar");
  if (await sidebar.evaluate((element) => element.classList.contains("sidebar-open"))) {
    await page.locator(".sidebar-top .mobile-only").click();
    await expect(sidebar).not.toHaveClass(/sidebar-open/);
  }
  await page.locator(".topbar .mobile-only").click();
  await expect(sidebar).toHaveClass(/sidebar-open/);
}

test.describe("@mobile mobile console", () => {
  test("@mobile shell and navigation render on a mobile viewport", async ({ page }) => {
    await page.goto("/");

    // The hamburger is the mobile entry point; the sidebar starts off-canvas.
    await openSidebar(page);

    await expect(page.getByRole("button", { name: "工作区" })).toBeVisible();
    await expect(page.getByRole("button", { name: "模型与凭据" })).toBeVisible();
    await expect(page.getByRole("button", { name: /新建任务/ })).toBeVisible();
    await expect(page.locator(".brand")).toContainText("PiGO");
  });

  test("@mobile run list opens a run detail and stays within the viewport", async ({ page, request }) => {
    const config = await configStatus(request);
    test.skip(!config.demoMode, "Demo mode is disabled (PI_DEMO_MODE=false); this flow needs a run.");

    const title = `E2E 移动端 ${Date.now()}`;
    const created = await request.post("/api/runs", {
      data: { title, task: DEMO_TASK, repository: "demo/auth-service", mode: "demo" },
    });
    expect(created.ok()).toBeTruthy();
    const runId = ((await created.json()) as { id: string }).id;

    try {
      await page.goto("/");
      await openSidebar(page);
      await openRunByTitle(page, title);

      await expect(page.locator(".metrics-grid")).toBeVisible();
      await expect(page.locator(".timeline-item").first()).toBeVisible({ timeout: 20_000 });

      // Tab switching works with the icon-only mobile tab bar.
      await page.getByRole("button", { name: "检查", exact: true }).click();
      await expect(page.locator(".check-row").first()).toBeVisible();

      await expectNoHorizontalOverflow(page, "run detail");
    } finally {
      await stopRun(request, runId);
    }
  });

  test("@mobile read-only pages do not overflow horizontally", async ({ page }) => {
    await page.goto("/");
    await expectNoHorizontalOverflow(page, "welcome");

    await openSidebar(page);
    await page.getByRole("button", { name: "工作区" }).click();
    await expect(page.getByRole("heading", { name: "工作区" })).toBeVisible();
    await expectNoHorizontalOverflow(page, "workspaces");

    await openSidebar(page);
    await page.getByRole("button", { name: "模型与凭据" }).click();
    await expect(page.getByRole("heading", { name: "模型与凭据" })).toBeVisible();
    await expectNoHorizontalOverflow(page, "models");
  });
});

import { existsSync } from "node:fs";
import { chromium, test as base, expect, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Shared test entry point for the browser suite.
 *
 * `e2eGuard` is an automatic fixture: before any test body runs it checks that
 * (1) a Playwright browser is installed and (2) the target server answers
 * `/api/health`. When either check fails the test is skipped with a clear
 * message instead of failing — this keeps the suite usable on machines and CI
 * images that have no browsers or no running deployment.
 */
export const E2E_BASE_URL = process.env.PI_E2E_BASE_URL ?? "http://127.0.0.1:3100";
export const E2E_DEV_EMAIL = (process.env.PI_E2E_DEV_EMAIL ?? "developer@localhost").toLowerCase();
export const E2E_WORKSPACE_PATH = process.env.PI_E2E_WORKSPACE_PATH;

/**
 * Opt-in switch for the production-only acceptance scenarios (E2E-01..08 in
 * docs/05-acceptance-test-specification.md §13). Those need Cloudflare OTP,
 * real provider credentials and real fixtures, so they stay `fixme` unless an
 * operator explicitly declares a live acceptance environment.
 */
export const E2E_LIVE_ACCEPTANCE = process.env.PI_E2E_LIVE === "1";

export type ConfigStatus = { demoMode: boolean; realRunsAvailable: boolean };

/** Reads `/api/config/status`; asserts the probe itself succeeded. */
export async function configStatus(request: APIRequestContext): Promise<ConfigStatus> {
  const response = await request.get("/api/config/status");
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as ConfigStatus;
}

/**
 * Collects `pageerror` exceptions for the lifetime of the page. Tests that
 * exercise reconnect/offline flows assert this stays empty so a swallowed
 * runtime error cannot hide behind a UI that merely looks alive.
 */
export function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

/**
 * Opens a run from the sidebar by title, tolerating a selection restored by the
 * initial `/api/runs` load (the app has no URL routing for run ids).
 */
export async function openRunByTitle(page: Page, title: string): Promise<void> {
  const item = page.locator(".run-item-main", { hasText: title });
  await expect(item).toBeVisible({ timeout: 20_000 });
  await item.click();
  await expect(page.locator(".run-heading h1")).toHaveText(title, { timeout: 20_000 });
}

/** Returns the rendered activity-timeline messages (newest first, as rendered). */
export async function timelineMessages(page: Page): Promise<string[]> {
  return page.locator(".timeline-item .timeline-content strong").allInnerTexts();
}

/**
 * Best-effort cancel of a run created by a test.
 *
 * The run list is ordered by `updatedAt`, and the app has no URL routing for run
 * ids (a reload re-selects `runs[0]`). A demo run left ticking after its test
 * would therefore keep becoming the newest run and break other tests' reload
 * assumptions, so tests that create runs cancel them on the way out.
 */
export async function stopRun(request: APIRequestContext, runId: string): Promise<void> {
  try {
    await request.post(`/api/runs/${runId}/cancel`);
  } catch {
    // Already terminal or the server is gone; nothing to clean up.
  }
}

/** Returns a human-readable reason when Chromium is not available on disk. */
export function missingBrowserReason(): string | undefined {
  try {
    const executable = chromium.executablePath();
    if (!executable || !existsSync(executable)) {
      return `Playwright browsers are not installed (looked for ${executable || "chromium"}). Install them with: npx playwright install chromium`;
    }
  } catch {
    return "Playwright could not resolve the Chromium executable. Install browsers with: npx playwright install chromium";
  }
  return undefined;
}

/** Returns a human-readable reason when the server health probe fails. */
async function unreachableServerReason(request: APIRequestContext): Promise<string | undefined> {
  try {
    const response = await request.get("/api/health", { timeout: 5_000 });
    if (!response.ok()) {
      return `PiGO server at ${E2E_BASE_URL} answered HTTP ${response.status()} for /api/health.`;
    }
  } catch (error) {
    return `PiGO server is not reachable at ${E2E_BASE_URL} (${(error as Error).message}). Start it and set PI_E2E_BASE_URL if needed.`;
  }
  return undefined;
}

type GuardFixtures = { e2eGuard: void };

export const test = base.extend<GuardFixtures>({
  e2eGuard: [
    async ({ request }, use) => {
      const browserReason = missingBrowserReason();
      if (browserReason) test.skip(true, browserReason);
      const serverReason = await unreachableServerReason(request);
      if (serverReason) test.skip(true, serverReason);
      await use();
    },
    { auto: true },
  ],
});

export { expect };

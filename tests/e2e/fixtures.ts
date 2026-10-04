import { existsSync } from "node:fs";
import { chromium, test as base, expect, type APIRequestContext } from "@playwright/test";

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

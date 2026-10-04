import { defineConfig, devices } from "@playwright/test";

/**
 * PiGO browser end-to-end configuration.
 *
 * The suite targets an already-running server; it never starts one itself
 * (real runs need PostgreSQL + a worker, which are provisioned by the
 * deployment). Point it at any environment with PI_E2E_BASE_URL.
 *
 *   PI_E2E_BASE_URL       base URL of the running server (default http://127.0.0.1:3100)
 *   PI_E2E_DEV_EMAIL      dev identity used for the `x-pigo-dev-email` header
 *                         (default developer@localhost)
 *   PI_E2E_WORKSPACE_PATH optional controlled relative path; enables the
 *                         positive workspace-registration assertions when set
 *   PI_E2E_LIVE          set to `1` to unlock the production-only acceptance
 *                         scenarios (E2E-01..08); they stay `fixme` otherwise
 *
 * Tests self-skip (never fail) when browsers are not installed or the server
 * is unreachable, so `npm run e2e:browser` is safe to run in any environment.
 *
 * Projects:
 * - `chromium` (Desktop Chrome) runs every spec except `@mobile`-tagged tests.
 * - `mobile` (390x844, isMobile, hasTouch — Chromium engine) runs only
 *   `@mobile`-tagged tests. It is deliberately Chromium-based rather than
 *   `devices["iPhone 13"]` (which defaults to WebKit) so the suite has no extra
 *   browser dependency; add a WebKit project if Safari rendering must be covered.
 * Run one project with `--project=chromium` / `--project=mobile`.
 */
const baseURL = process.env.PI_E2E_BASE_URL ?? "http://127.0.0.1:3100";
const devEmail = process.env.PI_E2E_DEV_EMAIL ?? "developer@localhost";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL,
    extraHTTPHeaders: { "x-pigo-dev-email": devEmail },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", grepInvert: /@mobile/, use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", grep: /@mobile/, use: { browserName: "chromium", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } },
  ],
});

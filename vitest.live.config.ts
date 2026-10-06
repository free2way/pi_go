import { defineConfig } from "vitest/config";

/**
 * Live-smoke vitest configuration (docs/27 §4.1/§4.2/§8).
 *
 * Colleague of `vitest.config.ts`, NOT a replacement: it collects only
 * `tests/live/**`, whose suites are themselves gated behind an explicit env
 * opt-in (e.g. `PI_JEV_LIVE=1`). `tests/e2e` stays excluded so Playwright specs
 * are never collected here, and the main `npm test` run keeps its `src/**`
 * include, so this file can never pull a network-dependent suite into the
 * regular gate.
 *
 * Run it through `npm run test:jev:live`. The generous timeouts cover a real
 * provider round trip (the in-test engine budget is PI_JEV_TIMEOUT_MS, default
 * 30s); they are not a licence to hang.
 */
export default defineConfig({
  test: {
    include: ["tests/live/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**", "tests/e2e/**"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});

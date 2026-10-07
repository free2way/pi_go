import { defineConfig } from "vitest/config";

/**
 * Performance / capacity vitest configuration (docs/27 §7.8, AT-JEV-070/072/073).
 *
 * Colleague of `vitest.config.ts`, NOT a replacement — same pattern as
 * `vitest.live.config.ts`:
 *
 *  - it collects only `tests/perf/**`, so the main `npm test` run (whose include
 *    is `src/**`) can never pull these volume-bearing suites into the default
 *    gate;
 *  - `tests/e2e` stays excluded so Playwright specs are never collected here;
 *  - every suite additionally self-skips unless `PI_DECISION_PERF=1`, a second
 *    safety net for anyone who points vitest at this file directly.
 *
 * `--expose-gc` is passed to the (single) fork so the heap-growth assertions have
 * a real `global.gc`; without it they fall back to a deliberately wide threshold
 * and are reported as the weaker evidence they are. `fileParallelism: false`
 * keeps the timing/memory numbers from being skewed by other test files.
 *
 * Run it through `npm run test:decision:perf`.
 */
export default defineConfig({
  test: {
    include: ["tests/perf/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**", "tests/e2e/**"],
    pool: "forks",
    execArgv: ["--expose-gc"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});

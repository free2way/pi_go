import { defineConfig } from "vitest/config";

/**
 * Unit tests are vitest's only job. Playwright specs live under `tests/e2e`
 * and must never be collected by vitest, so both the include and exclude
 * patterns are pinned explicitly.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**", "dist/**", "tests/e2e/**"],
  },
});

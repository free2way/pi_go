import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Pragmatic flat config for PiGO.
 *
 * The goal is to catch genuine mistakes (unused code, accidental globals,
 * broken TypeScript constructs) without forcing a repo-wide reformat. Rules
 * that would require large behavioural refactors are deliberately left off and
 * can be tightened incrementally.
 */
export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "data/**",
      "deploy/docker/workspace/**",
      "playwright-report/**",
      "test-results/**",
      "**/*.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      // The codebase intentionally models JSON-ish payloads with `any`/`unknown`
      // at the edges; keep this visible but non-blocking.
      "@typescript-eslint/no-explicit-any": "off",
      // Allow intentionally-unused arguments/values prefixed with `_` and
      // ignore variables only used in type positions. Surfaced as warnings so
      // pre-existing dead imports are visible without failing the build.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "none",
          ignoreRestSiblings: true,
        },
      ],
      // Empty catch blocks are used deliberately for best-effort cleanup.
      "no-empty": ["error", { allowEmptyCatch: true }],
      // `tsc` already reports undefined identifiers; `no-undef` produces false
      // positives for DOM/Node types referenced in TS files.
      "no-undef": "off",
      // Intentional multi-space regexes in deploy tooling (human-readable
      // column alignment); `{n}` quantifiers would hurt readability there.
      "no-regex-spaces": "off",
      // The sandbox sanitizer deliberately matches control characters.
      "no-control-regex": "off",
      // ESLint 10 additions that flag defensive re-assignment used across the
      // worker/server; enabling them would require unrelated refactors.
      "no-useless-assignment": "off",
      "preserve-caught-error": "off",
    },
  },
  {
    // Test files and specs often use non-null assertions and dangling promises.
    files: ["**/*.test.{ts,tsx}", "tests/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unused-expressions": "off",
    },
  },
);

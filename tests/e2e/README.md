# PiGO browser end-to-end suite

Playwright (`@playwright/test`) specs covering the core console flows against a
**running** PiGO server:

- `auth.spec.ts` — development identity via the `x-pigo-dev-email` header and
  the authenticated console shell (no login wall in dev mode).
- `workspaces.spec.ts` — workspaces page, register form validation, and an
  optional positive registration round-trip.
- `runs.spec.ts` — create a demo run from the dialog, the budget/usage metrics
  panel, activity timeline, checks/diff panels, model selection in real mode,
  and SSE reconnect + event replay.
- `errors.spec.ts` — error paths driven through the real UI with `page.route`
  interception: run-creation 400/422, an aborted/timed-out POST, a 500 on the
  run list, and 404/500 on run-detail resources.
- `reconnect.spec.ts` — reload re-hydration + event replay without duplicated
  timeline rows, and `context.setOffline()` → degraded → `setOffline(false)` →
  stream resumes.
- `mobile.spec.ts` — `@mobile`-tagged core read flows (shell/navigation, run
  list → detail, no horizontal overflow) on a 390x844 mobile viewport.
- `acceptance.spec.ts` — one `test.describe` per acceptance scenario E2E-01..08
  from `docs/05-acceptance-test-specification.md` §13 (see the coverage table
  below for implemented vs `fixme`).

The suite never starts a server. Real runs need PostgreSQL and a worker, which
are provisioned by the deployment.

## 1. Install browsers (one-time)

```bash
npx playwright install chromium
# Linux CI images also need system deps:
# npx playwright install --with-deps chromium
```

Only Chromium is required: the `mobile` project is Chromium-based (390x844,
`isMobile`, `hasTouch`) rather than `devices["iPhone 13"]`, whose default browser
is WebKit.

You do **not** need browsers to validate that the suite loads:

```bash
npx playwright test --list
```

If browsers are missing, every test is reported as **skipped** (not failed),
with a message telling you how to install them.

## 2. Run against a server

```bash
npm run e2e:browser
```

By default this targets `http://127.0.0.1:3100`, which is where the compose
stack publishes the web service (`deploy/docker/compose.yaml`).

### Projects

| Project | Viewport | Selection | Command |
| --- | --- | --- | --- |
| `chromium` | Desktop Chrome (1280x720) | everything except `@mobile` tests | `npx playwright test --project=chromium` |
| `mobile` | 390x844, `isMobile`, `hasTouch`, Chromium | only `@mobile` tests | `npx playwright test --project=mobile` |

`npx playwright test` runs both projects.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PI_E2E_BASE_URL` | `http://127.0.0.1:3100` | Base URL of the running server. |
| `PI_E2E_DEV_EMAIL` | `developer@localhost` | Value sent as `x-pigo-dev-email` (dev auth mode). |
| `PI_E2E_WORKSPACE_PATH` | unset | Controlled relative repo path; enables the positive workspace-registration test. |
| `PI_E2E_LIVE` | unset | `1` unlocks the production-only acceptance scenarios (E2E-01b, E2E-02, E2E-04..08). Unset/`0` keeps them `fixme`. |

Example against the isolated e2e deployment:

```bash
PI_E2E_BASE_URL=http://127.0.0.1:3100 \
PI_E2E_DEV_EMAIL=e2e@localhost \
npx playwright test
```

## 3. Local development server

The browser suite needs the client UI and the API on the **same origin**.

- **Built server (matches deployment):** `npm run build && npm start` serves
  `dist/client` and the API on `http://127.0.0.1:3100` (`PORT`).
- **Vite dev server:** `npm run dev` serves the UI on `http://localhost:5173`
  and proxies `/api` to the API on port 3100. Point the suite at Vite:

  ```bash
  PI_E2E_BASE_URL=http://localhost:5173 npm run e2e:browser
  ```

  Running `npm run dev:server` alone does not serve `index.html`, so the root
  URL would 404; use one of the two options above.

`npm run dev:server` / `npm start` need `PI_VAULT_SECRET` (base64, 32 bytes) and
`PI_DATABASE_URL`. With `PI_AUTH_MODE=development` (the default) the suite's
dev-auth header works without Cloudflare Access.

Tests that need real runs self-skip unless `PI_REAL_RUNS_ENABLED=true` and the
user has configured credentials plus an active workspace.

## 4. Skip semantics

Each spec runs through a shared guard (`fixtures.ts`). A test is **skipped**
with a clear reason when:

- the Chromium executable is not installed, or
- `/api/health` on `PI_E2E_BASE_URL` does not answer `200`.

This makes `npm run e2e:browser` safe on machines and CI images without
browsers or a deployment.

Additional, visible skips:

- `runs.spec.ts` / `reconnect.spec.ts` / `acceptance.spec.ts` demo flows skip
  when `/api/config/status` reports `demoMode: false` (`PI_DEMO_MODE=false`).
- real-run flows skip unless `realRunsAvailable` is true.
- the positive workspace-registration test skips without
  `PI_E2E_WORKSPACE_PATH`.
- the production-only acceptance scenarios are `test.fixme(...)` by default.
  They do **not run** and are reported with `-` plus a
  `（fixme：需生产验收环境）` title suffix; set `PI_E2E_LIVE=1` to enable them.
  The precondition list is also recorded as a `preconditions` annotation, which
  the HTML/JSON reporters display.

Nothing is silently skipped: every skip carries a reason string visible in the
run output or in the report annotations.

## 5. Acceptance coverage map (docs/05 §13 E2E-01..08)

| Scenario | Spec / test | Status | Why |
| --- | --- | --- | --- |
| E2E-01 单 Agent 完整闭环 | `acceptance.spec.ts` › `E2E-01a 本地演示闭环…` | implemented | Demo runner end-to-end locally: one Developer node, checks all pass, review approved, Diff/usage/budget/logs visible, no auto push/merge. |
| E2E-01 (real) | `acceptance.spec.ts` › `E2E-01b 真实闭环…（fixme…）` | `fixme` | Needs Cloudflare OTP, real Provider A/B credentials, `fixture-small-auth` workspace, and the human Approve gate. |
| E2E-02 检查失败自动返修 | `acceptance.spec.ts` › `E2E-02 …（fixme…）` | `fixme` | Needs a fixture whose first implementation fails a check, plus a real Pi Worker and two Provider credentials. |
| E2E-03 审核退回自动返修 | `acceptance.spec.ts` › `E2E-03 …` | implemented | Demo runner replays review→repair→approve: structured high finding (file/line/evidence/requiredChange), resolved after round 2, `review.changes_requested` back-edge in the timeline. |
| E2E-04 并行 Sub Agent | `acceptance.spec.ts` › `E2E-04 …（fixme…）` | `fixme` | Needs `fixture-parallel-app` + real Pi Worker with multi-process parallelism. |
| E2E-05 Provider 故障不浪费开发成本 | `acceptance.spec.ts` › `E2E-05 …（fixme…）` | `fixme` | Needs real runs plus a credential that is valid but unauthorized for the reviewer model. |
| E2E-06 Worker 崩溃恢复 | `acceptance.spec.ts` › `E2E-06 …（fixme…）` | `fixme` | Needs a real Pi Worker that can be force-restarted (the browser only observes the result). |
| E2E-07 预算停止 | `acceptance.spec.ts` › `E2E-07 …（fixme…）` | `fixme` | Needs a deployment with `PI_RUN_BUDGET_*` tight enough to stop before the second round. |
| E2E-08 恶意仓库隔离 | `acceptance.spec.ts` › `E2E-08 …（fixme…）` | `fixme` | Needs the malicious fixture (symlink / unapproved extension / prompt injection) and an isolated Worker. Note: v0.20.2 review NEW-01/NEW-02 say this scenario currently fails; it is a remediation tracker. |

Non-acceptance specs cover the review's other asks: error paths
(`errors.spec.ts`), refresh/offline (`reconnect.spec.ts`), mobile
(`mobile.spec.ts`).

## 6. Known limitations observed while writing this suite

- `src/client/App.tsx` swallows run-detail load failures and has no dedicated
  "not found" view; `errors.spec.ts` therefore pins the observable degradation
  (overview state, shell stays usable) instead of a non-existent selector. A 500
  on the **runs list** also raises an uncaught rejection (`pageerror:
  "Internal Server Error"`) from `void Promise.all([...]).finally(...)`; the test
  documents this and does not assert `pageerror` on that path, because the fix
  lives in `src/**` (out of scope for `tests/e2e`).
- The console has no URL routing for run ids, so refresh/reconnect tests reload
  the app and re-select the run from the sidebar.

## 7. Notes

- Unit tests are intentionally excluded from vitest (`vitest.config.ts` limits
  collection to `src/**/*.test.ts`), so `npm test` stays fast and focused.
- The current UI has no dedicated artifacts panel; the run's hard budget and
  usage are asserted through the metrics grid (tokens and estimated cost).
- Type-checking of these files is covered by `npm run typecheck` (the root
  `tsconfig.json` includes `tests` and `playwright.config.ts`).

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

The suite never starts a server. Real runs need PostgreSQL and a worker, which
are provisioned by the deployment.

## 1. Install browsers (one-time)

```bash
npx playwright install chromium
# Linux CI images also need system deps:
# npx playwright install --with-deps chromium
```

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

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PI_E2E_BASE_URL` | `http://127.0.0.1:3100` | Base URL of the running server. |
| `PI_E2E_DEV_EMAIL` | `developer@localhost` | Value sent as `x-pigo-dev-email` (dev auth mode). |
| `PI_E2E_WORKSPACE_PATH` | unset | Controlled relative repo path; enables the positive workspace-registration test. |

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

## 5. Notes

- Unit tests are intentionally excluded from vitest (`vitest.config.ts` limits
  collection to `src/**/*.test.ts`), so `npm test` stays fast and focused.
- The current UI has no dedicated artifacts panel; the run's hard budget and
  usage are asserted through the metrics grid (tokens and estimated cost).
- Type-checking of these files is covered by `npm run typecheck` (the root
  `tsconfig.json` includes `tests` and `playwright.config.ts`).

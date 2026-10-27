import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Locator, Page } from "@playwright/test";
import type { Run, RunArtifact, Workspace, WorkspaceRemoteStatus } from "../../src/shared/types";
import { E2E_DEV_EMAIL, expect, test, trackPageErrors } from "./fixtures";

/**
 * Bilingual console (中文 / English) end to end (docs/23-i18n.md, v0.27.x).
 *
 * The suite at large drives the Chinese UI (playwright.config.ts pins
 * `locale: "zh-CN"`), so this spec proves the language selector exists, that a
 * switch re-renders the app in place (no reload) across independent surfaces,
 * that the choice persists in `localStorage`, and that switching back to 中文
 * restores the labels every other spec selects by.
 *
 * Deliberate boundary (docs/23-i18n.md §6): server/model runtime text (run event
 * messages, review summaries, check output, artifacts) stays Chinese by design,
 * so the "Chinese-only text is gone" assertions only target the localized
 * chrome (nav labels, headings, title) — never run/event content.
 */

/** The one `<select>` in the topbar; role-scoped so it survives re-labeling. */
function localeSelect(page: Page): Locator {
  return page.locator(".topbar").getByRole("combobox");
}

const ZH = {
  localeLabel: "界面语言",
  navWorkflow: "工作流",
  navRecentRuns: "最近任务",
  navNewRun: "新建任务",
  navSystem: "系统状态",
  title: "PiGO · 多模型开发与审核控制台",
} as const;

const EN = {
  localeLabel: "Language",
  navWorkflow: "Workflows",
  navRecentRuns: "Recent runs",
  navSystem: "System status",
  title: "PiGO · Multi-model development & review console",
} as const;

test.describe("bilingual UI (中文 / English)", () => {
  test("diagnostics downloads verify bytes and display safe failures in both locales", async ({ page }) => {
    const pageErrors = trackPageErrors(page);
    const stamp = "2026-01-01T00:00:00Z";
    const run: Run = {
      id: "artifact-ui", ownerId: "fixture", title: "Diagnostic artifact fixture", task: "Synthetic UI contract",
      repository: "fixture", branch: "fixture", mode: "real", state: "completed", round: 1, maxRounds: 1,
      createdAt: stamp, updatedAt: stamp, developer: { provider: "deepseek", model: "fixture" },
      reviewer: { provider: "openai", model: "fixture" }, checks: [], findings: [], diff: "", summary: "Synthetic only",
      usage: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 }, durationMs: 0, lastSeq: 0,
    };
    const body = "Safe trace [redacted] 中文\n";
    const artifact: RunArtifact = { runId: run.id, artifactId: "trace", kind: "trace", bytes: Buffer.byteLength(body), sha256: createHash("sha256").update(body).digest("hex"), baseSha: null, createdAt: stamp };
    let status = 200;
    let returnedBody = body;
    let listFails = false;
    await page.route("**/api/runs", (route) => route.fulfill({ json: [run] }));
    await page.route("**/api/runs/artifact-ui", (route) => route.fulfill({ json: run }));
    await page.route("**/api/runs/artifact-ui/events", (route) => route.fulfill({ json: [] }));
    await page.route("**/api/runs/artifact-ui/stream", (route) => route.fulfill({ contentType: "text/event-stream", body: "" }));
    await page.route("**/api/runs/artifact-ui/artifacts", (route) => route.fulfill(listFails
      ? { status: 500, json: { error: "DUMMY_private_list_failure" } }
      : { json: { artifacts: [artifact, { ...artifact, artifactId: "diff", kind: "patch" }] } }));
    await page.route("**/api/runs/artifact-ui/artifacts/trace/download", (route) => route.fulfill({ status, contentType: status === 200 ? "application/octet-stream" : "application/json", body: status === 200 ? returnedBody : '{"error":"DUMMY_private_proxy_failure"}' }));
    await page.goto("/");
    await expect(page.locator(".run-heading h1")).toHaveText(run.title);
    for (const copy of [
      { locale: "zh", tab: "诊断制品", download: "下载 trace", refresh: "刷新", unsafe: "已阻止下载", unavailable: "无权访问", integrity: "SHA-256 与列表不一致", loadFailed: "无法读取制品" },
      { locale: "en", tab: "Diagnostics", download: "Download trace", refresh: "Refresh", unsafe: "failed a safety check", unavailable: "access denied", integrity: "SHA-256 differs", loadFailed: "Unable to load artifacts" },
    ]) {
      await localeSelect(page).selectOption(copy.locale);
      await page.locator(".detail-tabs").getByRole("button", { name: copy.tab, exact: true }).click();
      const panel = page.getByRole("region", { name: copy.tab, exact: true });
      await expect(panel.locator("li")).toHaveCount(1);
      await expect(panel).toContainText(artifact.sha256!.slice(0, 16));
      const button = panel.getByRole("button", { name: copy.download, exact: true });
      status = 200; returnedBody = body;
      const downloadEvent = page.waitForEvent("download");
      await button.click();
      const download = await downloadEvent;
      expect(download.suggestedFilename()).toBe("artifact-ui-trace.txt");
      expect(await readFile((await download.path())!, "utf8")).toBe(body);
      let unexpectedDownloads = 0;
      const unexpected = () => { unexpectedDownloads += 1; };
      page.on("download", unexpected);
      for (const scenario of [{ code: 409, message: copy.unsafe }, { code: 404, message: copy.unavailable }, { code: 200, message: copy.integrity }]) {
        status = scenario.code; returnedBody = body.replace("Safe", "Fake");
        await button.click();
        await expect(panel.getByRole("alert")).toContainText(scenario.message);
        await expect(button).toBeEnabled();
        await expect(panel).not.toContainText("DUMMY_private");
      }
      expect(unexpectedDownloads).toBe(0); page.off("download", unexpected);
      listFails = true;
      await panel.getByRole("button", { name: copy.refresh, exact: true }).click();
      await expect(panel.getByRole("alert")).toContainText(copy.loadFailed);
      await expect(panel).not.toContainText("DUMMY_private");
      listFails = false;
      await panel.getByRole("button", { name: copy.refresh, exact: true }).click();
      await expect(button).toBeVisible();
    }
    expect(pageErrors).toEqual([]);
  });

  test("SCM confirmation supports cancellation, keyboard focus and one explicit push in both locales", async ({ page }) => {
    const pageErrors = trackPageErrors(page);
    const stamp = "2026-01-01T00:00:00Z";
    const workspace: Workspace = {
      id: "dialog-test", ownerId: "fixture", nodeId: "server", name: "confirmation-fixture", type: "server",
      rootPath: "confirmation-fixture", canonicalPath: "/workspace/projects/confirmation-fixture",
      repositoryUrl: "https://example.invalid/fixture.git", defaultBranch: "main", defaultChecks: [], status: "active",
      git: { branch: "main", head: "a".repeat(40), dirty: false, dirtyFiles: [] },
      lastCheckedAt: stamp, createdAt: stamp, updatedAt: stamp, permission: "write",
    };
    const remote: WorkspaceRemoteStatus = {
      provider: "generic", remote: workspace.repositoryUrl!, branch: "main", localHead: "a".repeat(40),
      remoteHead: "a".repeat(40), relation: "synchronized", ahead: 0, behind: 0, checkedAt: stamp,
    };
    const pushes: unknown[] = [];
    let releasePush = () => {};
    // UI contract fixture only. Server permission, scanning and persistence are
    // verified separately through real HTTP/PostgreSQL acceptance tests.
    await page.route("**/api/me", async (route) => {
      const response = await route.fetch();
      await route.fulfill({ json: { ...await response.json(), isAdmin: true } });
    });
    await page.route("**/api/workspaces", (route) => route.fulfill({ json: { workspaces: [workspace] } }));
    await page.route("**/api/workspaces/dialog-test/scm", (route) => route.fulfill({ json: {
      settings: { provider: "generic", authMode: "https_token", username: null, tokenConfigured: true, updatedAt: stamp },
      remote, attempts: [],
    } }));
    await page.route("**/api/workspaces/dialog-test/scm/check", (route) => route.fulfill({ json: remote }));
    await page.route("**/api/workspaces/dialog-test/scm/push", async (route) => {
      pushes.push(route.request().postDataJSON());
      await new Promise<void>((resolve) => { releasePush = resolve; });
      await route.fulfill({ status: 503, json: { error: "Controlled failure [redacted]", code: "SCM_REMOTE_UNREACHABLE" } });
    });
    await page.goto("/");
    await page.getByRole("button", { name: "工作区", exact: true }).click();
    await page.getByRole("button", { name: "仓库同步", exact: true }).click();
    for (const copy of [
      { locale: "zh", title: "确认推送代码", push: "推送到远程", cancel: "取消", failed: "仓库同步失败" },
      { locale: "en", title: "Confirm code push", push: "Push to remote", cancel: "Cancel", failed: "Repository sync failed" },
    ]) {
      await localeSelect(page).selectOption(copy.locale);
      const opener = page.locator(".ws-scm-actions").getByRole("button", { name: copy.push, exact: true });
      const dialog = page.getByRole("dialog", { name: copy.title, exact: true });
      const countBefore = pushes.length;
      await opener.click();
      await expect(dialog).toContainText(workspace.name);
      await expect(dialog.getByRole("button", { name: copy.cancel, exact: true })).toBeFocused();
      await dialog.getByRole("button", { name: copy.cancel, exact: true }).press("Enter");
      await expect(dialog).not.toBeVisible();
      await expect(opener).toBeFocused();
      expect(pushes).toHaveLength(countBefore);
      await opener.click();
      await page.keyboard.press("Escape");
      await expect(dialog).not.toBeVisible();
      await expect(opener).toBeFocused();
      expect(pushes).toHaveLength(countBefore);
      await opener.click();
      await page.keyboard.press("Shift+Tab");
      await expect(dialog.getByRole("button", { name: copy.push, exact: true })).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(dialog.getByRole("button", { name: copy.cancel, exact: true })).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(dialog.getByRole("button", { name: copy.push, exact: true })).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(dialog.getByRole("button", { name: copy.cancel, exact: true })).toBeFocused();
      await dialog.getByRole("button", { name: copy.push, exact: true }).click({ clickCount: 2 });
      await expect.poll(() => pushes.length).toBe(countBefore + 1);
      await expect(dialog).not.toBeVisible();
      await expect(opener).toBeDisabled();
      expect(pushes.at(-1)).toEqual({ confirm: true });
      releasePush();
      await expect(page.locator(".ws-scm-panel .form-error")).toContainText(copy.failed);
      await expect(page.locator(".ws-scm-panel .form-error")).toContainText("[redacted]");
      await expect(opener).toBeEnabled();
      expect(pushes).toHaveLength(countBefore + 1);
    }
    expect(pageErrors).toEqual([]);
  });

  test("topbar language selector lists both locales and defaults to 中文 for a zh-CN browser", async ({ page }) => {
    await page.goto("/");

    // Precondition for the default resolution: the pinned browser locale is zh.
    // resolveLocale() consults navigator.languages when localStorage is empty.
    expect(await page.evaluate(() => navigator.language)).toMatch(/^zh/i);

    // The selector is visible in the topbar and its accessible name is the
    // localized label of the *current* language.
    const select = page.locator(".topbar").getByRole("combobox", { name: ZH.localeLabel });
    await expect(select).toBeVisible();
    await expect(select.locator("option")).toHaveText(["中文", "English"]);
    await expect(select).toHaveValue("zh");

    // The default is resolved from the browser, not persisted until the user
    // actually chooses: no stored override yet.
    expect(await page.evaluate(() => window.localStorage.getItem("pigo.locale"))).toBeNull();

    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    await expect(page).toHaveTitle(ZH.title);

    // The authenticated shell (dev identity from the shared `x-pigo-dev-email`
    // header) renders with the Chinese labels the rest of the suite relies on.
    await expect(page.locator(".account-footer")).toContainText(E2E_DEV_EMAIL);
    await expect(page.getByRole("button", { name: ZH.navWorkflow, exact: true })).toBeVisible();
    await expect(page.getByText(ZH.navNewRun)).toBeVisible();
  });

  test("switching to English re-renders in place, persists across a reload, and 中文 restores the labels", async ({ page }) => {
    const pageErrors = trackPageErrors(page);
    await page.goto("/");

    const select = localeSelect(page);
    await expect(select).toHaveValue("zh");

    // Move to a main-content page so the switch has two *independent* surfaces
    // to prove: the sidebar nav item and the page heading.
    await page.getByRole("button", { name: ZH.navSystem, exact: true }).click();
    await expect(page.getByRole("heading", { name: ZH.navSystem, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: ZH.navWorkflow, exact: true })).toBeVisible();

    // A reload would wipe this window marker; the locale switch must not navigate.
    await page.evaluate(() => {
      (window as Window & { __pigoLocaleProbe?: string }).__pigoLocaleProbe = "alive";
    });
    let mainFrameNavigations = 0;
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) mainFrameNavigations += 1;
    });
    const errorsBeforeSwitch = pageErrors.length;

    await select.selectOption("en");

    // Surface 1 — sidebar nav item; Surface 2 — main-content page heading.
    await expect(page.getByRole("button", { name: EN.navWorkflow, exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: EN.navSystem, exact: true })).toBeVisible();
    await expect(page.getByText(EN.navRecentRuns, { exact: true })).toBeVisible();

    // Chinese-only chrome text is gone (run/event text stays Chinese by design).
    await expect(page.getByRole("button", { name: ZH.navWorkflow, exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: ZH.navSystem, exact: true })).toHaveCount(0);
    await expect(page.getByText(ZH.navRecentRuns, { exact: true })).toHaveCount(0);

    // <html lang> and the document title follow the locale.
    await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
    await expect(page).toHaveTitle(EN.title);

    // No reload: the probe survived and the main frame never navigated.
    expect(mainFrameNavigations, "the locale switch must not reload the page").toBe(0);
    expect(await page.evaluate(() => (window as Window & { __pigoLocaleProbe?: string }).__pigoLocaleProbe)).toBe("alive");

    // The choice is persisted, so a full reload comes back in English.
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
    await expect(page.getByRole("button", { name: EN.navWorkflow, exact: true })).toBeVisible();
    await expect(page.getByText(ZH.navRecentRuns, { exact: true })).toHaveCount(0);
    await expect(page).toHaveTitle(EN.title);
    expect(await page.evaluate(() => window.localStorage.getItem("pigo.locale"))).toBe("en");

    // The app has no URL routing, so a reload resets the view; re-open the
    // heading surface and confirm it is still English after the reload.
    await page.getByRole("button", { name: EN.navSystem, exact: true }).click();
    await expect(page.getByRole("heading", { name: EN.navSystem, exact: true })).toBeVisible();

    // Switching back to 中文 restores the Chinese labels other specs select by.
    await localeSelect(page).selectOption("zh");
    await expect(page.getByRole("button", { name: ZH.navWorkflow, exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: ZH.navSystem, exact: true })).toBeVisible();
    await expect(page.getByText(ZH.navRecentRuns, { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: EN.navSystem, exact: true })).toHaveCount(0);
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    await expect(page).toHaveTitle(ZH.title);
    expect(await page.evaluate(() => window.localStorage.getItem("pigo.locale"))).toBe("zh");

    // Nothing thrown by the app across both switches.
    expect(
      pageErrors.slice(errorsBeforeSwitch),
      `uncaught page errors during the locale switch: ${pageErrors.join(" | ")}`,
    ).toEqual([]);
  });
});

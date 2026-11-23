import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "./fixtures";

type CatalogEntry = { provider: string; model: string; roles: string[] };
type Profile = { id: string; name: string };
type Team = { id: string; name: string };

async function createProfile(request: APIRequestContext, name: string, role: "developer" | "reviewer", entry: CatalogEntry): Promise<Profile> {
  const response = await request.post("/api/agent-profiles", {
    data: { name, role, provider: entry.provider, model: entry.model },
  });
  if (!response.ok()) throw new Error(`profile creation failed: HTTP ${response.status()} ${await response.text()}`);
  return response.json() as Promise<Profile>;
}

async function openTeams(page: Page, locale: "zh" | "en" = "zh") {
  await page.goto("/");
  await page.getByRole("button", { name: locale === "zh" ? "模型与凭据" : "Models & Credentials" }).click();
  await expect(page.getByRole("heading", { name: locale === "zh" ? "Agent Profiles 与 Teams" : "Agent Profiles & Teams" })).toBeVisible();
}

test.describe("multi-agent team UI", () => {
  test("configures an ordered team, survives refresh, and appears in run creation", async ({ page, request }) => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const developerName = `E2E Developer ${suffix}`;
    const reviewerName = `E2E Reviewer ${suffix}`;
    const teamName = `E2E Team ${suffix}`;
    const updatedTeamName = `${teamName} Updated`;
    let developer: Profile | undefined;
    let reviewer: Profile | undefined;
    let team: Team | undefined;

    const catalogResponse = await request.get("/api/models");
    expect(catalogResponse.ok()).toBeTruthy();
    const catalog = await catalogResponse.json() as { models: CatalogEntry[] };
    const developerModel = catalog.models.find((entry) => entry.roles.includes("developer"));
    const reviewerModel = catalog.models.find((entry) => entry.roles.includes("reviewer"));
    expect(developerModel, "model catalog must contain a developer model").toBeTruthy();
    expect(reviewerModel, "model catalog must contain a reviewer model").toBeTruthy();

    try {
      developer = await createProfile(request, developerName, "developer", developerModel!);
      reviewer = await createProfile(request, reviewerName, "reviewer", reviewerModel!);

      await openTeams(page);
      const profileRows = page.locator(".team-settings-column").first().locator(".team-rows");
      await expect(profileRows.locator(".team-row", { hasText: developerName })).toBeVisible();
      await expect(profileRows.locator(".team-row", { hasText: reviewerName })).toBeVisible();

      await page.getByLabel("Team 名称").fill(teamName);
      await page.locator(".team-member-picker label", { hasText: developerName }).getByRole("checkbox").check();
      await page.locator(".team-member-picker label", { hasText: reviewerName }).getByRole("checkbox").check();
      await page.getByRole("button", { name: `上移 ${reviewerName}` }).click();

      const orderedMembers = page.getByRole("list", { name: "团队成员顺序" }).getByRole("listitem");
      await expect(orderedMembers).toHaveCount(2);
      await expect(orderedMembers.nth(0)).toContainText(reviewerName);
      await expect(orderedMembers.nth(1)).toContainText(developerName);
      await page.getByRole("button", { name: "创建 Team" }).click();
      await expect(page.locator(".team-row-stacked", { hasText: teamName })).toBeVisible();

      const created = await request.get("/api/teams");
      expect(created.ok()).toBeTruthy();
      team = ((await created.json()) as { teams: Team[] }).teams.find((item) => item.name === teamName);
      expect(team, "team must be persisted by the UI").toBeTruthy();

      await page.reload();
      await page.getByRole("button", { name: "模型与凭据" }).click();
      const persistedRow = page.locator(".team-row-stacked", { hasText: teamName });
      await expect(persistedRow).toBeVisible();
      const persistedText = await persistedRow.innerText();
      expect(persistedText.indexOf(reviewerName)).toBeLessThan(persistedText.indexOf(developerName));

      await persistedRow.getByRole("button", { name: "编辑 Team" }).click();
      await page.getByLabel("Team 名称").fill(updatedTeamName);
      await page.getByRole("button", { name: "更新 Team" }).click();
      await expect(page.locator(".team-row-stacked", { hasText: updatedTeamName })).toBeVisible();

      await page.evaluate(() => localStorage.setItem("pigo.locale", "en"));
      await openTeams(page, "en");
      await expect(page.locator(".team-row-stacked", { hasText: updatedTeamName })).toBeVisible();

      const config = await request.get("/api/config/status");
      const configBody = await config.json() as Record<string, unknown>;
      await page.route("**/api/config/status", (route) => route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...configBody, realRunsAvailable: true }),
      }));
      await page.route("**/api/workspaces", (route) => route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ workspaces: [{ id: `ws-${suffix}`, name: "E2E Workspace", status: "active", defaultChecks: ["npm test"], git: { branch: "main", dirty: false, dirtyFiles: [] } }] }),
      }));
      await page.goto("/");
      await page.getByRole("button", { name: /New run/ }).click();
      await page.getByRole("button", { name: "Real development" }).click();
      const runDialog = page.locator(".create-run-modal");
      await runDialog.getByLabel("Multi-agent team").selectOption({ label: updatedTeamName });
      await expect(runDialog.locator(".selected-team-summary")).toContainText(updatedTeamName);
      await expect(runDialog.getByLabel("Developer model")).toHaveCount(0);
      await expect(runDialog.getByLabel("Reviewer model")).toHaveCount(0);
    } finally {
      if (team) await request.delete(`/api/teams/${team.id}`).catch(() => undefined);
      if (developer) await request.delete(`/api/agent-profiles/${developer.id}`).catch(() => undefined);
      if (reviewer) await request.delete(`/api/agent-profiles/${reviewer.id}`).catch(() => undefined);
    }
  });
});

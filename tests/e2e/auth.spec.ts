import { E2E_DEV_EMAIL, expect, test } from "./fixtures";

/**
 * The suite talks to a development-mode server where identity comes from the
 * `x-pigo-dev-email` header (see src/server/auth.ts). These checks prove the
 * header is what selects the identity and that the console renders the
 * authenticated user without a login wall.
 */
test.describe("development authentication", () => {
  test("x-pigo-dev-email selects the identity", async ({ request }) => {
    const me = await request.get("/api/me");
    expect(me.ok()).toBeTruthy();
    expect(((await me.json()) as { email?: string }).email?.toLowerCase()).toBe(E2E_DEV_EMAIL);

    // A different header value selects a different identity.
    const other = await request.get("/api/me", { headers: { "x-pigo-dev-email": "e2e-alt@localhost" } });
    expect(other.ok()).toBeTruthy();
    expect(((await other.json()) as { email?: string }).email).toBe("e2e-alt@localhost");
  });

  test("console renders the authenticated user without a login wall", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".brand")).toContainText("PiGO");
    const footer = page.locator(".account-footer");
    await expect(footer).toBeVisible();
    await expect(footer).toContainText(E2E_DEV_EMAIL);
  });
});

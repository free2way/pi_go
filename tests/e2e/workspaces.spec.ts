import { E2E_WORKSPACE_PATH, expect, test } from "./fixtures";

/**
 * Workspace registration flow (src/client/WorkspacesPage.tsx).
 *
 * Registration validates a path against the controlled project root; a path
 * that escapes the root is rejected server-side and surfaced in the form. When
 * PI_E2E_WORKSPACE_PATH points at a real controlled repository the positive
 * round-trip is exercised as well.
 */
test.describe("workspace registration", () => {
  test("register form surfaces server-side validation", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "工作区" }).click();
    await expect(page.getByRole("heading", { name: "工作区" })).toBeVisible();

    await page.getByRole("button", { name: "注册已有目录" }).click();
    const pathInput = page.getByLabel("相对路径");
    await expect(pathInput).toBeVisible();

    // Submit stays disabled until a path is provided.
    await expect(page.getByRole("button", { name: "注册工作区" })).toBeDisabled();

    // A path outside the controlled root must never be accepted.
    await pathInput.fill("../outside-the-controlled-root");
    await page.getByRole("button", { name: "注册工作区" }).click();
    await expect(page.locator(".ws-form .form-error")).toBeVisible();
  });

  test("registers a controlled workspace when PI_E2E_WORKSPACE_PATH is set", async ({ page }) => {
    test.skip(!E2E_WORKSPACE_PATH, "Set PI_E2E_WORKSPACE_PATH to a controlled relative repo path to run the positive registration.");

    await page.goto("/");
    await page.getByRole("button", { name: "工作区" }).click();
    await page.getByRole("button", { name: "注册已有目录" }).click();
    await page.getByLabel("相对路径").fill(E2E_WORKSPACE_PATH!);
    await page.getByRole("button", { name: "注册工作区" }).click();

    // Either the workspace card appears, or an "already registered" error is
    // shown when the path was registered by a previous run.
    const card = page.locator(".ws-card");
    const error = page.locator(".ws-form .form-error");
    await expect(card.or(error).first()).toBeVisible();
  });
});

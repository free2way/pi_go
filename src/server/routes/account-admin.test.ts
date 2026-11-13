import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { AccountAdminRouteDependencies } from "./account-admin.js";
import { registerAccountAdminRoutes } from "./account-admin.js";

function routeApp(overrides: Partial<AccountAdminRouteDependencies> = {}) {
  const accounts = {
    list: vi.fn(async () => []),
    listWorkspaces: vi.fn(async () => [{ id: "workspace-1", name: "Workspace", status: "active" as const }]),
    get: vi.fn(async () => undefined),
    update: vi.fn(),
    setGrant: vi.fn(),
    removeGrant: vi.fn(),
  } as unknown as AccountAdminRouteDependencies["accounts"];
  const releaseSettings = {
    get: vi.fn(() => undefined),
    set: vi.fn(),
    delete: vi.fn(),
  } as unknown as AccountAdminRouteDependencies["releaseSettings"];
  const releaseSettingsProjection = vi.fn(() => ({ configured: false }));
  const app = Fastify();
  const deps: AccountAdminRouteDependencies = {
    currentUser: () => ({ id: "user-1", email: ["admin", "example.com"].join("@") }),
    isAdmin: async () => true,
    accounts,
    releaseSettings,
    releaseSettingsProjection,
    credentialWrites: { check: () => ({ allowed: true, remaining: 9, retryAfterMs: 0 }) },
    ...overrides,
  };
  registerAccountAdminRoutes(app, deps);
  return { app, accounts: deps.accounts, releaseSettings: deps.releaseSettings, releaseSettingsProjection };
}

describe("account and release administration routes", () => {
  it("rejects a non-admin before reading account or release state", async () => {
    const fixture = routeApp({ isAdmin: async () => false });
    const response = await fixture.app.inject({ method: "GET", url: "/api/admin/release-settings" });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "仅管理员可以管理账户", code: "ADMIN_REQUIRED" });
    expect(fixture.releaseSettingsProjection).not.toHaveBeenCalled();
  });

  it("keeps the static workspaces route ahead of the account id route", async () => {
    const fixture = routeApp();
    const response = await fixture.app.inject({ method: "GET", url: "/api/accounts/workspaces" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ workspaces: [{ id: "workspace-1", name: "Workspace", status: "active" }] });
    expect(fixture.accounts.listWorkspaces).toHaveBeenCalledOnce();
    expect(fixture.accounts.get).not.toHaveBeenCalled();
  });

  it("requires a token in the first saved release configuration", async () => {
    const fixture = routeApp();
    const response = await fixture.app.inject({
      method: "PUT",
      url: "/api/admin/release-settings",
      payload: {
        webhookUrl: "https://executor.example.test/hooks/release",
        publicOrigin: "https://pigo.example.test",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "首次配置必须填写 Webhook Token", code: "RELEASE_TOKEN_REQUIRED" });
    expect(fixture.releaseSettings.set).not.toHaveBeenCalled();
  });

  it("preserves the rate-limit response and Retry-After header", async () => {
    const fixture = routeApp({
      credentialWrites: { check: () => ({ allowed: false, remaining: 0, retryAfterMs: 1_001 }) },
    });
    const response = await fixture.app.inject({ method: "DELETE", url: "/api/admin/release-settings" });

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("2");
    expect(response.json()).toEqual({ error: "请求过于频繁，请稍后再试", code: "RATE_LIMITED" });
    expect(fixture.releaseSettings.delete).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from "vitest";
import { scrubEnvironment, workerOnlySecrets } from "./pi-env.js";

describe("scrubEnvironment", () => {
  it("keeps the current role's credential and drops every other secret (AT-SEC-008)", () => {
    const sanitized = scrubEnvironment({
      PATH: "/usr/bin",
      HOME: "/home/node",
      DEEPSEEK_API_KEY: "deepseek-secret",
      OPENAI_API_KEY: "openai-secret",
      PI_INTERNAL_TOKEN: "internal",
      PI_VAULT_SECRET: "vault",
      PIGO_POSTGRES_PASSWORD: "pg",
      PI_WORKSPACE_ROOT: "/workspace",
    }, ["DEEPSEEK_API_KEY"]);

    expect(sanitized.DEEPSEEK_API_KEY).toBe("deepseek-secret");
    expect(sanitized.PATH).toBe("/usr/bin");
    expect(sanitized.PI_WORKSPACE_ROOT).toBe("/workspace");
    for (const name of ["OPENAI_API_KEY", "PI_INTERNAL_TOKEN", "PI_VAULT_SECRET", "PIGO_POSTGRES_PASSWORD"]) {
      expect(sanitized[name]).toBeUndefined();
    }
  });

  it("drops all known worker secrets when no credential is kept", () => {
    const sanitized = scrubEnvironment({
      PATH: "/usr/bin",
      NODE_ENV: "production",
      ...Object.fromEntries(workerOnlySecrets.map((name) => [name, "value"])),
    });
    expect(Object.keys(sanitized).sort()).toEqual(["NODE_ENV", "PATH"]);
  });

  it("covers custom provider key names via the secret suffix rule", () => {
    const sanitized = scrubEnvironment({ SOMEPROVIDER_API_KEY: "x", MY_CREDENTIAL: "y", PI_ALERT_WEBHOOK: "https://hooks.example" });
    expect(sanitized.SOMEPROVIDER_API_KEY).toBeUndefined();
    expect(sanitized.MY_CREDENTIAL).toBeUndefined();
    expect(sanitized.PI_ALERT_WEBHOOK).toBe("https://hooks.example");
  });
});

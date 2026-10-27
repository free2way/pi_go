import { describe, expect, it, vi } from "vitest";
import { sourceExportCredentials } from "./source-export-credentials.js";
import { parseExportCredentialContext } from "../shared/export-credential-context.js";

describe("source export credential context", () => {
  it("reads only the actor and migrated alias and deduplicates current providers", async () => {
    const vault = {
      configuredProviders: vi.fn((owner: string) => owner === "actor" ? ["dev", "review"] : ["dev", "other"]),
      get: vi.fn((owner: string, provider: string) => owner === "actor" ? provider === "dev" ? "DUMMY_current" : "DUMMY_review" : provider === "dev" ? "DUMMY_current" : "DUMMY_legacy"),
    };
    expect(await sourceExportCredentials("actor", vault, async () => "legacy")).toEqual(["DUMMY_current", "DUMMY_review", "DUMMY_legacy"]);
    expect(vault.configuredProviders.mock.calls).toEqual([["actor"], ["legacy"]]);
    expect(vault.get.mock.calls).toEqual([["actor", "dev"], ["actor", "review"], ["legacy", "dev"], ["legacy", "other"]]);
  });
  it("allows absent individual keys without looking up other identities", async () => {
    const get = vi.fn(() => undefined);
    expect(await sourceExportCredentials("actor", { configuredProviders: () => ["dev"], get }, async () => "actor")).toEqual([]);
    expect(get).toHaveBeenCalledExactlyOnceWith("actor", "dev");
  });
  it("does not cache keys across rotation", async () => {
    let key = "DUMMY_before";
    const vault = { configuredProviders: () => ["dev"], get: () => key };
    expect(await sourceExportCredentials("actor", vault, async () => undefined)).toEqual([key]);
    key = "DUMMY_after";
    expect(await sourceExportCredentials("actor", vault, async () => undefined)).toEqual([key]);
  });
  it("propagates identity lookup failures before reading any keys", async () => {
    const get = vi.fn();
    await expect(sourceExportCredentials("actor", { configuredProviders: () => [], get }, async () => { throw new Error("fixture"); })).rejects.toThrow("fixture");
    expect(get).not.toHaveBeenCalled();
  });
  it("propagates decrypt failures instead of returning a partial context", async () => {
    await expect(sourceExportCredentials("actor", { configuredProviders: () => ["dev", "review"], get: (_id, provider) => { if (provider === "review") throw new Error("fixture"); return "DUMMY_partial"; } }, async () => undefined)).rejects.toThrow("fixture");
  });
  it("rejects unsupported context sizes without reflecting private values", async () => {
    await expect(sourceExportCredentials("actor", { configuredProviders: () => ["dev"], get: () => "x".repeat(513) }, async () => undefined)).rejects.toThrow("Export credential context unavailable");
    await expect(sourceExportCredentials("actor", { configuredProviders: () => Array(257).fill("dev"), get: vi.fn() }, async () => undefined)).rejects.toThrow("Export credential context unavailable");
  });
  it.each([undefined, null, "value", {}, [null], [12], [""], ["x".repeat(513)], Array(257).fill("fixture")])("rejects malformed guarded-push context: %j", (value) => {
    expect(parseExportCredentialContext(value)).toBeUndefined();
  });
  it("accepts an empty context and deduplicates valid opaque values", () => {
    expect(parseExportCredentialContext([])).toEqual([]);
    expect(parseExportCredentialContext(["opaque/+ value", "opaque/+ value"])).toEqual(["opaque/+ value"]);
  });
});

import { describe, expect, it } from "vitest";
import { releaseCallbackTokens, resolveReleaseRoute } from "./release-routing.js";

describe("resolveReleaseRoute", () => {
  it("routes staging and production to distinct executor pairs", () => {
    const variables = {
      PI_STAGING_DEPLOY_HOOK: "http://staging-executor:3300/hooks/pigo-release",
      PI_STAGING_DEPLOY_TOKEN: "staging-token",
      PI_PRODUCTION_DEPLOY_HOOK: "http://production-executor:3300/hooks/pigo-release",
      PI_PRODUCTION_DEPLOY_TOKEN: "production-token",
      PI_POST_MERGE_DEPLOY_HOOK: "http://legacy-executor:3300/hooks/pigo-release",
      PI_POST_MERGE_DEPLOY_TOKEN: "legacy-token",
    };

    expect(resolveReleaseRoute({ environment: "staging", variables })).toEqual({
      webhookUrl: variables.PI_STAGING_DEPLOY_HOOK,
      webhookToken: "staging-token",
      source: "environment",
      environmentSpecific: true,
    });
    expect(resolveReleaseRoute({ environment: "production", variables })).toEqual({
      webhookUrl: variables.PI_PRODUCTION_DEPLOY_HOOK,
      webhookToken: "production-token",
      source: "environment",
      environmentSpecific: true,
    });
  });

  it("fails closed when a specific URL has no matching token", () => {
    expect(resolveReleaseRoute({
      environment: "staging",
      variables: {
        PI_STAGING_DEPLOY_HOOK: "http://staging-executor:3300/hooks/pigo-release",
        PI_POST_MERGE_DEPLOY_TOKEN: "must-not-cross-environments",
      },
    })).toMatchObject({ webhookToken: "", environmentSpecific: true });
  });

  it("keeps saved and legacy configurations backward compatible", () => {
    const saved = {
      webhookUrl: "https://deploy.example.com/hook",
      webhookToken: "saved-token",
      publicOrigin: "https://pigo.example.com",
      updatedAt: "2026-10-17T00:00:00.000Z",
    };
    expect(resolveReleaseRoute({ environment: "staging", saved, variables: {} })).toMatchObject({
      webhookUrl: saved.webhookUrl,
      webhookToken: saved.webhookToken,
      source: "web",
      environmentSpecific: false,
    });
    expect(resolveReleaseRoute({
      environment: "production",
      variables: { PI_POST_MERGE_DEPLOY_HOOK: "cmd:deploy", PI_POST_MERGE_DEPLOY_TOKEN: "legacy-token" },
    })).toMatchObject({ webhookUrl: "cmd:deploy", webhookToken: "legacy-token", environmentSpecific: false });
  });
});

describe("releaseCallbackTokens", () => {
  it("deduplicates every configured callback credential without exposing it elsewhere", () => {
    expect(releaseCallbackTokens(undefined, {
      PI_STAGING_DEPLOY_TOKEN: "staging-token",
      PI_PRODUCTION_DEPLOY_TOKEN: "production-token",
      PI_POST_MERGE_DEPLOY_TOKEN: "production-token",
    })).toEqual(["staging-token", "production-token"]);
  });
});

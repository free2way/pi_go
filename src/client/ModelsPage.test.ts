import { describe, expect, it } from "vitest";
import type { CredentialStatus, ModelInfo } from "../shared/types";
import { DECISION_PROVIDER_ID, decisionPlaneNotice, providerIdentity, providerIdsForCards } from "./ModelsPage";

function model(provider: string, id: string): ModelInfo {
  return {
    id,
    provider,
    model: id.split("/")[1] ?? id,
    label: id,
    toolCalling: true,
    reasoning: false,
    roles: ["developer"],
    status: "available",
    available: true,
    unavailableReason: null,
  };
}

/** Only `provider` matters to the card list; the rest of the status shape is irrelevant here. */
const credentials = (...providers: string[]): Pick<CredentialStatus, "providers"> =>
  ({ providers: providers.map((provider) => ({ provider })) } as unknown as Pick<CredentialStatus, "providers">);

describe("providerIdsForCards (decision-plane provider visibility)", () => {
  it("unions catalogue providers with stored credentials, catalogue order first", () => {
    const ids = providerIdsForCards(
      { models: [model("deepseek", "deepseek/chat"), model("openai", "openai/gpt")] },
      credentials(DECISION_PROVIDER_ID, "deepseek"),
    );
    expect(ids).toEqual(["deepseek", "openai", "typesafe"]);
  });

  it("keeps a stored provider that has no catalogue models visible", () => {
    expect(providerIdsForCards({ models: [] }, credentials(DECISION_PROVIDER_ID))).toEqual(["typesafe"]);
  });

  it("tolerates a missing catalogue or credential status", () => {
    expect(providerIdsForCards(undefined, undefined)).toEqual([]);
    expect(providerIdsForCards({ models: [model("deepseek", "deepseek/chat")] }, undefined)).toEqual(["deepseek"]);
    expect(providerIdsForCards(undefined, credentials(DECISION_PROVIDER_ID))).toEqual(["typesafe"]);
  });
});

describe("providerIdentity", () => {
  it("gives typesafe a human label without hiding the raw provider id", () => {
    const identity = providerIdentity(DECISION_PROVIDER_ID);
    expect(identity.decisionPlane).toBe(true);
    expect(identity.id).toBe("typesafe");
    expect(identity.label).toBe("TypeSafe · Jev 决策平面");
    expect(providerIdentity(DECISION_PROVIDER_ID, "en").label).toBe("TypeSafe · Jev decision plane");
  });

  it("keeps the plain id for every provider that is not the decision plane", () => {
    const identity = providerIdentity("deepseek", "en");
    expect(identity.decisionPlane).toBe(false);
    expect(identity.label).toBe("deepseek");
  });
});

describe("decisionPlaneNotice", () => {
  it("never reads as enabled unless the deployment reports engine=jev", () => {
    for (const engine of ["disabled", "mock"] as const) {
      const notice = decisionPlaneNotice({ engine, mode: "shadow", configured: true, policyVersion: null });
      expect(notice.enabled).toBe(false);
      expect(notice.hint).toContain("PI_DECISION_ENGINE=jev");
    }
    expect(decisionPlaneNotice(undefined).enabled).toBe(false);
    expect(decisionPlaneNotice(undefined).hint).toContain("PI_DECISION_ENGINE=jev");
  });

  it("reports the deployment engine and mode verbatim", () => {
    const notice = decisionPlaneNotice({ engine: "mock", mode: "shadow", configured: true, policyVersion: null });
    expect(notice.engine).toBe("mock");
    expect(notice.mode).toBe("shadow");
    expect(notice.state).toBe("决策平面：引擎 mock · 模式 shadow");
    expect(decisionPlaneNotice({ engine: "jev", mode: "enforce", configured: true, policyVersion: "v1" }, "en").state)
      .toBe("Decision plane: engine jev · mode enforce");
  });

  it("announces activation only when the deployment enabled jev", () => {
    const notice = decisionPlaneNotice({ engine: "jev", mode: "shadow", configured: true, policyVersion: null });
    expect(notice.enabled).toBe(true);
    expect(notice.hint).toContain("PI_DECISION_ENGINE=jev");
    expect(notice.hint).not.toContain("must also enable");
  });
});

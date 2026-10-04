import { describe, expect, it } from "vitest";
import { verifyPendingCredentials, type PendingCredential } from "./credential-verification.js";
import type { ProviderProbeResult } from "./provider-probe.js";

function harness(input: {
  pending: PendingCredential[];
  keys?: Record<string, string>;
  probeResults?: Record<string, ProviderProbeResult>;
  probeDisabled?: boolean;
  now?: () => number;
}) {
  const verified: Array<{ userId: string; provider: string; models: string[] | null }> = [];
  const unverified: Array<{ userId: string; provider: string }> = [];
  const logs: Array<{ message: string; detail?: Record<string, unknown> }> = [];
  const keyFor = (credential: PendingCredential) => input.keys?.[`${credential.userId}/${credential.provider}`];
  return {
    verified,
    unverified,
    logs,
    deps: {
      listPending: () => input.pending,
      readKey: (userId: string, provider: string) => input.keys?.[`${userId}/${provider}`],
      probe: async ({ provider }: { provider: string; apiKey: string }): Promise<ProviderProbeResult> =>
        input.probeResults?.[provider] ?? { ok: true, models: [] },
      markVerified: async (userId: string, provider: string, models: string[] | null) => {
        verified.push({ userId, provider, models });
      },
      markUnverified: async (userId: string, provider: string) => {
        unverified.push({ userId, provider });
      },
      probeDisabled: () => input.probeDisabled ?? false,
      log: (message: string, detail?: Record<string, unknown>) => { logs.push({ message, detail }); },
      now: input.now,
    },
    keyFor,
  };
}

describe("verifyPendingCredentials (AUD-08 cutover safety)", () => {
  it("probes each unverified credential once and records the outcome", async () => {
    const h = harness({
      pending: [
        { userId: "u1", provider: "deepseek" },
        { userId: "u1", provider: "openai-proxy" },
      ],
      keys: { "u1/deepseek": "k1", "u1/openai-proxy": "k2" },
      probeResults: {
        deepseek: { ok: true, models: ["deepseek-chat"] },
        "openai-proxy": { ok: false, code: "PROBE_UNAUTHORIZED", message: "provider 探测返回 HTTP 401" },
      },
    });
    const result = await verifyPendingCredentials(h.deps, { budgetMs: 5_000 });
    expect(result.verified).toEqual(["deepseek"]);
    expect(result.unverified).toEqual(["openai-proxy"]);
    expect(h.verified).toEqual([{ userId: "u1", provider: "deepseek", models: ["deepseek-chat"] }]);
    expect(h.unverified).toEqual([{ userId: "u1", provider: "openai-proxy" }]);
    // Logs carry provider names and codes only, never the key.
    expect(JSON.stringify(h.logs)).not.toContain("k1");
    expect(JSON.stringify(h.logs)).not.toContain("k2");
  });

  it("marks every credential verified for all models when probing is disabled", async () => {
    const h = harness({
      pending: [
        { userId: "u1", provider: "deepseek" },
        { userId: "u2", provider: "anthropic" },
      ],
      keys: { "u1/deepseek": "k1", "u2/anthropic": "k3" },
      probeDisabled: true,
    });
    const result = await verifyPendingCredentials(h.deps, { budgetMs: 1_000 });
    expect(result.probeDisabled).toBe(true);
    expect(result.verified.sort()).toEqual(["anthropic", "deepseek"]);
    expect(h.verified.every((item) => item.models === null)).toBe(true);
    expect(h.unverified).toEqual([]);
  });

  it("skips credentials whose key cannot be resolved", async () => {
    const h = harness({ pending: [{ userId: "u1", provider: "deepseek" }], keys: {} });
    const result = await verifyPendingCredentials(h.deps, { budgetMs: 1_000 });
    expect(result.skipped).toEqual(["deepseek"]);
    expect(result.verified).toEqual([]);
    expect(h.verified).toEqual([]);
  });

  it("defers credentials past the budget instead of delaying startup", async () => {
    let clock = 0;
    const h = harness({
      pending: [
        { userId: "u1", provider: "deepseek" },
        { userId: "u2", provider: "anthropic" },
        { userId: "u3", provider: "google" },
      ],
      keys: { "u1/deepseek": "k1", "u2/anthropic": "k2", "u3/google": "k3" },
      now: () => clock,
    });
    // Each probe advances the clock past a 5ms budget.
    h.deps.probe = async ({ provider }) => {
      clock += 10;
      return { ok: true, models: [provider] };
    };
    const result = await verifyPendingCredentials(h.deps, { budgetMs: 5, concurrency: 1 });
    expect(result.timedOut).toBe(true);
    expect(result.deferred.length).toBeGreaterThan(0);
    expect(result.verified.length + result.deferred.length).toBe(3);
  });

  it("records an erroring credential as unverified and keeps going", async () => {
    const h = harness({
      pending: [
        { userId: "u1", provider: "deepseek" },
        { userId: "u1", provider: "openai-proxy" },
      ],
      keys: { "u1/deepseek": "k1", "u1/openai-proxy": "k2" },
    });
    let calls = 0;
    h.deps.probe = async () => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      return { ok: true, models: [] };
    };
    const result = await verifyPendingCredentials(h.deps, { budgetMs: 5_000 });
    expect(result.unverified.length).toBe(1);
    expect(result.verified.length).toBe(1);
  });
});

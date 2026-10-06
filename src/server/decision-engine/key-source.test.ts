import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DECISION_ENGINE_DEFAULTS, loadDecisionEngineConfig } from "./config.js";
import { createDecisionEngine } from "./index.js";
import { resetDecisionCircuitBreakers } from "./jev.js";
import type { DecisionEngineConfig, DecisionRequest } from "./types.js";

/**
 * docs/26 §11 · the Jev engine's key may come from the per-user credential
 * vault (wired by `index.ts`/`decision-routes.ts`) instead of only
 * `process.env.TYPESAFE_API_KEY`. This suite pins the ENGINE seam added for that:
 * an injected `resolveApiKey` is the sole source when present, the environment
 * stays the fallback when it is absent, and `disabled`/`mock` never consult it.
 */

const VAULT_KEY = "sk-DUMMY-VAULT-ONLY-DO-NOT-LEAK-0123456789";
const ENV_KEY = "sk-DUMMY-ENV-FALLBACK-DO-NOT-LEAK-abcdef";

const config = (overrides: Partial<DecisionEngineConfig> = {}): DecisionEngineConfig => ({
  engine: "jev",
  mode: "shadow",
  baseUrl: DECISION_ENGINE_DEFAULTS.baseUrl,
  model: DECISION_ENGINE_DEFAULTS.model,
  timeoutMs: 3000,
  maxAttempts: 1,
  maxStateTokens: DECISION_ENGINE_DEFAULTS.maxStateTokens,
  maxStateBytes: DECISION_ENGINE_DEFAULTS.maxStateBytes,
  reviewMaxFindings: 50,
  shadowSampleRate: 1,
  policyVersion: "review-triage-v1",
  allowSource: false,
  hasApiKey: false,
  ...overrides,
});

const request = (): DecisionRequest => ({
  evaluationId: "de_key_source",
  runId: "run_1",
  kind: "review_triage",
  mode: "shadow",
  policyVersion: "review-triage-v1",
  stateHash: "hash",
  state: { run: { round: 1 } },
  questions: { q_choice: { type: "choice", prompt: "impact?", options: ["none", "material"] } },
  timeoutMs: 3000,
});

const validBody = () => ({
  model: "jev-1.13.0",
  answers: { q_choice: { choice: "material", probabilities: { none: 0.1, material: 0.9 }, confidence: 0.9 } },
  usage: { input_tokens: 10, output_tokens: 5 },
});

const originalKey = process.env.TYPESAFE_API_KEY;

beforeEach(() => {
  resetDecisionCircuitBreakers();
  process.env.TYPESAFE_API_KEY = ENV_KEY;
});

afterEach(() => {
  if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = originalKey;
  resetDecisionCircuitBreakers();
  vi.restoreAllMocks();
});

describe("createDecisionEngine — TypeSafe/Jev key source", () => {
  it("[AT-JEV-050] uses the injected resolver (vault) ahead of the environment, with exactly one provider call", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(validBody()), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    const resolveApiKey = vi.fn(() => VAULT_KEY);
    const engine = createDecisionEngine(config(), { resolveApiKey, fetchImpl: fetchImpl as unknown as typeof fetch });

    const evaluation = await engine.evaluate(request());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${VAULT_KEY}`);
    expect(evaluation.status).toBe("completed");
    expect(evaluation.provider).toBe("typesafe");
    // Neither key ever leaks into the evaluation.
    const serialized = JSON.stringify(evaluation);
    expect(serialized).not.toContain(VAULT_KEY);
    expect(serialized).not.toContain(ENV_KEY);
  });

  it("falls back to process.env.TYPESAFE_API_KEY when no resolver is provided", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(validBody()), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    const engine = createDecisionEngine(config({ hasApiKey: true }), { fetchImpl: fetchImpl as unknown as typeof fetch });

    const evaluation = await engine.evaluate(request());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${ENV_KEY}`);
    expect(evaluation.status).toBe("completed");
  });

  it("reports missing_credentials without any provider call when neither source resolves a key", async () => {
    delete process.env.TYPESAFE_API_KEY;
    const fetchImpl = vi.fn();
    const engine = createDecisionEngine(config(), {
      resolveApiKey: () => undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const evaluation = await engine.evaluate(request());

    expect(evaluation.status).toBe("fallback");
    expect(evaluation.fallbackReason).toBe("missing_credentials");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("dispatches even when config.hasApiKey is false, because the resolver owns key availability", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(validBody()), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    const engine = createDecisionEngine(config({ hasApiKey: false }), {
      resolveApiKey: () => VAULT_KEY,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect((await engine.evaluate(request())).status).toBe("completed");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("never consults the resolver for disabled/mock engines", async () => {
    const resolveApiKey = vi.fn(() => VAULT_KEY);
    const fetchImpl = vi.fn();

    const disabled = createDecisionEngine(config({ engine: "disabled", mode: "shadow" }), { resolveApiKey });
    expect((await disabled.evaluate(request())).status).toBe("disabled");

    const mock = createDecisionEngine(config({ engine: "mock", mode: "shadow" }), { resolveApiKey, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect((await mock.evaluate(request())).status).toBe("completed");

    expect(resolveApiKey).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("loadDecisionEngineConfig — vault-backed key opt-in", () => {
  it("keeps the strict env contract by default", () => {
    const strict = loadDecisionEngineConfig({ PI_DECISION_ENGINE: "jev", PI_JEV_MODE: "shadow" });
    expect(strict).toMatchObject({ ok: false, reason: "missing_credentials" });
  });

  it("loads jev without an env key when the caller opts into runtime resolution", () => {
    const loaded = loadDecisionEngineConfig(
      { PI_DECISION_ENGINE: "jev", PI_JEV_MODE: "shadow" },
      { allowMissingApiKey: true },
    );
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.config.engine).toBe("jev");
    expect(loaded.config.mode).toBe("shadow");
    // Presence only: no key material was invented or stored.
    expect(loaded.config.hasApiKey).toBe(false);
    expect(JSON.stringify(loaded.config)).not.toContain(VAULT_KEY);
  });
});

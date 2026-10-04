import type { ProviderProbeResult } from "./provider-probe.js";

/**
 * AUD-08 production cutover safety.
 *
 * Live verification makes `verifiedAt === null` credentials unavailable, which is
 * correct for new keys but would otherwise block every real run in a deployment
 * where keys were stored before verification existed and the operator cannot
 * re-enter them. This bounded startup pass resolves exactly those credentials:
 *
 * - `PI_MODEL_PROBE_MODE=off` (probe disabled) → the operator asserts the stored
 *   keys are valid, so each is marked verified once with `verifiedModels: null`
 *   (null means "all models on this provider are allowed").
 * - otherwise → each credential is probed once (reusing `createProviderProbe`)
 *   and marked verified (with the provider-reported model ids) or unverified.
 *
 * It never logs key material — only provider names, model counts and outcome
 * codes. A budget bounds the wall-clock time the caller waits.
 */

export interface PendingCredential {
  userId: string;
  provider: string;
}

export interface CredentialVerificationDeps {
  listPending: () => PendingCredential[];
  /** Resolves the stored key for one provider; the callee owns the key material. */
  readKey: (userId: string, provider: string) => string | undefined;
  probe: (input: { provider: string; apiKey: string }) => Promise<ProviderProbeResult>;
  markVerified: (userId: string, provider: string, models: string[] | null) => Promise<unknown>;
  markUnverified: (userId: string, provider: string) => Promise<unknown>;
  /** True when `PI_MODEL_PROBE_MODE=off`. */
  probeDisabled?: () => boolean;
  log?: (message: string, detail?: Record<string, unknown>) => void;
  now?: () => number;
}

export interface CredentialVerificationOptions {
  /** Wall-clock budget for the whole pass (default 10_000 ms). */
  budgetMs?: number;
  /** Parallel probes (default 4). */
  concurrency?: number;
}

export interface CredentialVerificationResult {
  /** Provider names marked verified. */
  verified: string[];
  /** Provider names that failed a probe or errored. */
  unverified: string[];
  /** Credentials whose key could not be resolved (no key material). */
  skipped: string[];
  /** Credentials not attempted because the budget was exhausted. */
  deferred: string[];
  considered: number;
  timedOut: boolean;
  probeDisabled: boolean;
}

function pushUnique(list: string[], value: string) {
  if (!list.includes(value)) list.push(value);
}

export async function verifyPendingCredentials(
  deps: CredentialVerificationDeps,
  options: CredentialVerificationOptions = {},
): Promise<CredentialVerificationResult> {
  const budgetMs = Math.max(0, options.budgetMs ?? 10_000);
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const now = deps.now ?? Date.now;
  const probeDisabled = deps.probeDisabled?.() ?? false;
  const start = now();
  const pending = deps.listPending();
  const queue = [...pending];

  const result: CredentialVerificationResult = {
    verified: [],
    unverified: [],
    skipped: [],
    deferred: [],
    considered: pending.length,
    timedOut: false,
    probeDisabled,
  };

  const workers = Array.from({ length: Math.min(concurrency, Math.max(queue.length, 1)) }, async () => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      // Probing mode enforces a wall-clock budget; the disabled path is local.
      if (!probeDisabled && now() - start >= budgetMs) {
        pushUnique(result.deferred, item.provider);
        continue;
      }
      try {
        const apiKey = deps.readKey(item.userId, item.provider);
        if (!apiKey) {
          pushUnique(result.skipped, item.provider);
          continue;
        }
        if (probeDisabled) {
          await deps.markVerified(item.userId, item.provider, null);
          pushUnique(result.verified, item.provider);
          deps.log?.("credential marked verified (probe disabled)", { provider: item.provider, models: "all" });
          continue;
        }
        const probe = await deps.probe({ provider: item.provider, apiKey });
        if (probe.ok) {
          await deps.markVerified(item.userId, item.provider, probe.models);
          pushUnique(result.verified, item.provider);
          deps.log?.("credential verified", { provider: item.provider, models: probe.models.length });
        } else {
          await deps.markUnverified(item.userId, item.provider);
          pushUnique(result.unverified, item.provider);
          deps.log?.("credential verification failed", { provider: item.provider, code: probe.code });
        }
      } catch (error) {
        pushUnique(result.unverified, item.provider);
        // Provider name and message only; key material is never observed here.
        deps.log?.("credential verification error", { provider: item.provider, error: (error as Error).message });
      }
    }
  });

  await Promise.all(workers);
  result.timedOut = result.deferred.length > 0;
  return result;
}

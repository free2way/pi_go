import type { AlertManager } from "./alerts.js";
import type { Queryable } from "./db.js";

export const PROVIDER_ALERT_KEY = "model_provider_failures";
const PROVIDER_LIMIT = 64;
const OUTCOME_LIMIT = 4;
const THRESHOLD = 3;

interface Observation {
  failingProviders: number;
  observedConsecutiveFailures: number;
  recovered: boolean;
}

/** Read only outcomes, never prompts, error text, credentials or model names. */
export async function readProviderAlertObservation(db: Queryable, configuredProviders: readonly string[]): Promise<Observation> {
  const configured = [...new Set(configuredProviders)];
  if (configured.length > PROVIDER_LIMIT || configured.some((p) => !p || p.length > 80)) throw new Error("Invalid provider observation scope");
  const rows: Record<string, unknown>[] = [];
  for (const provider of configured) {
    // A provider-specific index lookup prevents a busy provider from hiding an
    // older unresolved failure on another provider. Work is bounded per scope.
    const result = await db.query(`SELECT run_id, seq, at, type,
      CASE WHEN LENGTH(meta_json) <= 4096 THEN meta_json ELSE NULL END AS meta_json FROM run_events
      WHERE source = 'system' AND type IN ('provider.attempt_failed', 'session.metrics')
        AND (meta_json::jsonb ->> 'provider') = $1
      ORDER BY at DESC, run_id DESC, seq DESC LIMIT $2`, [provider, OUTCOME_LIMIT]);
    if (result.rows.length > OUTCOME_LIMIT) throw new Error("Invalid provider observation");
    rows.push(...result.rows);
  }
  const providers = new Map<string, { failures: number; ended: boolean; healthy: boolean; at: string; run: string }>();
  let complete = true;
  for (const row of rows) {
    if (typeof row.meta_json !== "string" || row.meta_json.length > 4096 || typeof row.at !== "string" || !Number.isFinite(Date.parse(row.at))
      || typeof row.run_id !== "string" || !Number.isSafeInteger(Number(row.seq)) || Number(row.seq) < 1) {
      throw new Error("Invalid provider observation");
    }
    const meta: unknown = JSON.parse(row.meta_json);
    if (!meta || typeof meta !== "object" || !("provider" in meta) || typeof meta.provider !== "string"
      || !meta.provider || !configured.includes(meta.provider)) {
      complete = false;
      continue;
    }
    const success = row.type === "session.metrics";
    if (row.type !== "provider.attempt_failed" && !success) throw new Error("Invalid provider observation");
    if (success && (!("modelCalls" in meta) || !Number.isSafeInteger(meta.modelCalls) || Number(meta.modelCalls) < 1)) {
      complete = false;
      continue;
    }
    let state = providers.get(meta.provider);
    if (!state) {
      state = { failures: 0, ended: false, healthy: success, at: row.at, run: row.run_id };
      providers.set(meta.provider, state);
    } else if (state.at === row.at && state.run !== row.run_id) {
      // Millisecond timestamps do not order different concurrent runs. An
      // ambiguous success is not evidence that a known fault recovered.
      complete = false;
    }
    if (state.ended) continue;
    if (success) state.ended = true;
    else state.failures += 1;
  }
  const states = [...providers.values()];
  return {
    failingProviders: states.filter((state) => state.failures >= THRESHOLD).length,
    observedConsecutiveFailures: Math.max(0, ...states.map((state) => state.failures)),
    // Silence or malformed/ambiguous observations cannot establish recovery.
    recovered: complete && states.length > 0 && states.every((state) => state.healthy),
  };
}

/** Durable event observation survives Web restarts and requires no health page. */
export function createProviderAlertSweeper(options: {
  alerts: AlertManager;
  read: () => Promise<Observation>;
  warn: () => void;
}) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let inFlight = false;
  async function sweep() {
    if (stopped || inFlight) return;
    inFlight = true;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const observation = await Promise.race([
        Promise.resolve().then(options.read),
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => reject(new Error("Provider observation timed out")), 5_000);
          deadline.unref?.();
        }),
      ]);
      if (stopped) return;
      if (observation.failingProviders > 0) {
        options.alerts.raise({
          key: PROVIDER_ALERT_KEY,
          severity: "warning",
          message: "模型服务连续调用失败，请检查服务状态与模型配置",
          details: { providers: observation.failingProviders, threshold: THRESHOLD, observedConsecutiveFailures: observation.observedConsecutiveFailures },
        });
      } else if (observation.recovered) options.alerts.clear(PROVIDER_ALERT_KEY);
    } catch {
      if (!stopped) options.warn();
    } finally {
      if (deadline) clearTimeout(deadline);
      inFlight = false;
    }
  }
  return {
    sweep,
    start() {
      if (timer || stopped) return;
      void sweep();
      timer = setInterval(() => { void sweep(); }, 60_000);
      timer.unref?.();
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

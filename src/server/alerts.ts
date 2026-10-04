export type AlertSeverity = "warning" | "critical";

export interface Alert {
  key: string;
  severity: AlertSeverity;
  message: string;
  details?: Record<string, unknown>;
}

export type AlertSink = (alert: Alert) => void;

/**
 * REL-006: deduplicated alerting for degraded infrastructure (database, worker,
 * queue, disk). Alerts go to the structured log and, when configured, to
 * `PI_ALERT_WEBHOOK`.
 */
export class AlertManager {
  private lastRaised = new Map<string, number>();

  constructor(
    private readonly sink: AlertSink,
    private readonly cooldownMs = Number(process.env.PI_ALERT_COOLDOWN_SECONDS || 900) * 1_000,
  ) {}

  /** Raises an alert unless the same key fired within the cooldown window. */
  raise(alert: Alert) {
    const now = Date.now();
    const last = this.lastRaised.get(alert.key) ?? 0;
    if (now - last < this.cooldownMs) return false;
    this.lastRaised.set(alert.key, now);
    this.sink(alert);
    return true;
  }

  /** Alerts fire again as soon as the condition clears and returns. */
  clear(key: string) {
    this.lastRaised.delete(key);
  }

  get activeKeys() {
    return [...this.lastRaised.keys()];
  }
}

/** Builds the production sink: structured logs plus an optional webhook. */
export function createAlertSink(options: {
  log: (level: "warn" | "error", payload: Record<string, unknown>, message: string) => void;
  webhookUrl?: string;
  fetchImpl?: typeof fetch;
}): AlertSink {
  const doFetch = options.fetchImpl ?? fetch;
  return (alert) => {
    options.log(alert.severity === "critical" ? "error" : "warn", { alert: alert.key, ...alert.details }, alert.message);
    if (!options.webhookUrl) return;
    void doFetch(options.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...alert, at: new Date().toISOString() }),
      signal: AbortSignal.timeout(10_000),
    }).catch((error) => {
      options.log("warn", { alert: alert.key, error: (error as Error).message }, "alert webhook delivery failed");
    });
  };
}

import { diagnosticSecrets, redactDiagnosticText, redactDiagnosticValue } from "../shared/diagnostics.js";

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
  environment?: NodeJS.ProcessEnv;
}): AlertSink {
  const doFetch = options.fetchImpl ?? fetch;
  const secrets = diagnosticSecrets(options.environment);
  const environment = options.environment ?? process.env;
  const configuredEnvironment = environment.PI_DEPLOYMENT_ENVIRONMENT?.trim() || environment.NODE_ENV;
  const deploymentEnvironment = ["production", "staging", "development", "test"].includes(configuredEnvironment ?? "")
    ? configuredEnvironment! : "unknown";
  const version = redactDiagnosticText(environment.PI_WEB_VERSION?.trim() || "unknown", secrets);
  const labels = {
    service: "pigo-web",
    environment: deploymentEnvironment,
    version: /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(version) ? version : "unknown",
  };
  return (alert) => {
    const safe = {
      severity: alert.severity,
      key: redactDiagnosticText(alert.key, secrets),
      message: redactDiagnosticText(alert.message, secrets),
      ...(alert.details ? { details: redactDiagnosticValue(alert.details, secrets) as Record<string, unknown> } : {}),
    };
    options.log(safe.severity === "critical" ? "error" : "warn", { ...safe.details, ...labels, alert: safe.key }, safe.message);
    if (!options.webhookUrl) return;
    const failed = (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      options.log("warn", { ...labels, alert: safe.key, error: redactDiagnosticText(message, secrets) }, "alert webhook delivery failed");
    };
    try {
      void doFetch(options.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...safe, ...labels, at: new Date().toISOString() }),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      }).then((response) => {
        if (!response.ok) failed(new Error(`HTTP ${response.status}`));
        // Alert delivery never consumes or logs a receiver's potentially private body.
        void response.body?.cancel().catch(() => undefined);
      }).catch(failed);
    } catch (error) {
      failed(error);
    }
  };
}

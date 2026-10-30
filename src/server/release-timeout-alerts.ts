import type { AlertManager } from "./alerts.js";
import type { Queryable } from "./db.js";

export interface ReleaseTimeoutObservation { outstanding: number }

/** An expiry audit remains unresolved through retries and failures. Only a
 * later successful attempt for that exact delivery/environment resolves it.
 * `system` is the legacy expiry writer; new expiry audits use a dedicated actor.
 * Read failures propagate so an unknown observation cannot clear a fault.
 */
export async function readReleaseTimeoutObservation(db: Queryable): Promise<ReleaseTimeoutObservation> {
  const row = (await db.query(`SELECT COUNT(DISTINCT timed_out.release_id) AS outstanding
    FROM agile_release_audit timed_out
    WHERE timed_out.action = 'release.deploy_failed' AND timed_out.status = 'failed'
      AND timed_out.actor_id IN ('system', 'system:release-callback-timeout')
      AND NOT EXISTS (
        SELECT 1 FROM agile_release_audit recovered
        WHERE recovered.release_id = timed_out.release_id AND recovered.status = 'ok'
          AND recovered.action IN ('release.deploy_succeeded', 'release.deploy_result')
          AND recovered.created_at >= timed_out.created_at
          AND (recovered.deploy_json::jsonb ->> 'deliveryId') = (timed_out.deploy_json::jsonb ->> 'deliveryId')
          AND (recovered.deploy_json::jsonb ->> 'environment') = (timed_out.deploy_json::jsonb ->> 'environment')
          AND (recovered.deploy_json::jsonb ->> 'attempt')::integer > (timed_out.deploy_json::jsonb ->> 'attempt')::integer
      )`)).rows[0];
  const value = row?.outstanding;
  if (!(typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value)))
    || !Number.isSafeInteger(Number(value)) || Number(value) < 0) throw new Error("Invalid release timeout observation");
  return { outstanding: Number(value) };
}

export function syncReleaseTimeoutAlerts(alerts: AlertManager, observation: ReleaseTimeoutObservation | undefined): void {
  if (!observation || !Number.isSafeInteger(observation.outstanding) || observation.outstanding < 0) return;
  if (observation.outstanding === 0) {
    alerts.clear("release_deploy_timeout");
    return;
  }
  alerts.raise({
    key: "release_deploy_timeout",
    severity: "warning",
    message: "发布部署回调超时，存在尚未成功恢复的发布",
    details: { count: observation.outstanding },
  });
}

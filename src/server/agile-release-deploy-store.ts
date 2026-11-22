import type {
  AgileRelease,
  ReleaseDeployRecord,
  ReleaseDeploySettlementRejection,
} from "../shared/agile.js";
import { newId, type Db } from "./db.js";
import {
  AgileError,
  parseJson,
  type ReleaseRow,
  toRelease,
} from "./agile-model.js";
import type { ReleasePublishStory } from "./release-publish.js";

/** Persistence boundary for release-deployment claims, results and audit rows. */
export class AgileReleaseDeployStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => string,
  ) {}

  async start(input: {
    releaseId: string;
    deliveryId: string;
    attempt: number;
    releasedBy: string;
    releasedAt: string;
    note?: string;
    deploy: ReleaseDeployRecord;
    stories: ReleasePublishStory[];
  }): Promise<{ claimed: boolean; attempt: number; release: AgileRelease }> {
    const now = this.now();
    const existing = (await this.db.query("SELECT * FROM agile_releases WHERE id = $1", [input.releaseId])).rows[0] as unknown as ReleaseRow | undefined;
    if (!existing) throw new AgileError("RELEASE_NOT_FOUND", "发布不存在", 404);
    const claimed = await this.db.withTransaction(async (tx) => {
      const claimId = newId("reldeploy");
      // pg-mem returns the conflicting row from `DO NOTHING … RETURNING` (real
      // PostgreSQL returns zero rows), so compare the stored id with this id.
      await tx.query(
        `INSERT INTO agile_release_deploy_claims (id, release_id, attempt, idempotency_key, delivery_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [claimId, input.releaseId, input.attempt, `${input.deliveryId}#${input.attempt}`, input.deliveryId, now],
      );
      const stored = (await tx.query(
        "SELECT id FROM agile_release_deploy_claims WHERE idempotency_key = $1",
        [`${input.deliveryId}#${input.attempt}`],
      )).rows[0] as { id: string } | undefined;
      if (!stored || stored.id !== claimId) return false;
      await tx.query(
        `UPDATE agile_releases SET status = 'released', released_at = $1, released_by = $2, deploy_json = $3, updated_at = $4 WHERE id = $5`,
        [input.releasedAt, input.releasedBy, JSON.stringify(input.deploy), now, input.releaseId],
      );
      await tx.query(
        `INSERT INTO agile_release_audit (id, release_id, owner_id, action, actor_id, note, status, deploy_json, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [newId("relaudit"), input.releaseId, existing.owner_id, "release.published", input.releasedBy, input.note?.trim() || null, "released", JSON.stringify(input.deploy), now],
      );
      return true;
    });
    const release = (await this.db.query("SELECT * FROM agile_releases WHERE id = $1", [input.releaseId])).rows[0] as unknown as ReleaseRow;
    return { claimed, attempt: input.attempt, release: toRelease(release) };
  }

  async settle(input: {
    releaseId: string;
    deploy: ReleaseDeployRecord;
    action: "release.deploy_result" | "release.deploy_succeeded" | "release.deploy_failed";
    actorId: string;
    now?: string;
  }): Promise<{ applied: boolean; release: AgileRelease; rejected?: ReleaseDeploySettlementRejection }> {
    const now = input.now ?? this.now();
    const releaseRow = (await this.db.query("SELECT * FROM agile_releases WHERE id = $1", [input.releaseId])).rows[0] as unknown as ReleaseRow | undefined;
    if (!releaseRow) throw new AgileError("RELEASE_NOT_FOUND", "发布不存在", 404);
    const current = parseJson<ReleaseDeployRecord | null>(releaseRow.deploy_json, null);
    const identityMatches = Boolean(current)
      && input.deploy.deliveryId !== undefined
      && input.deploy.attempt !== undefined
      && current!.deliveryId === input.deploy.deliveryId
      && current!.attempt === input.deploy.attempt;
    if (!identityMatches) {
      return { applied: false, release: toRelease(releaseRow), rejected: "stale_attempt" };
    }
    if (current!.status !== "pending") {
      return { applied: false, release: toRelease(releaseRow), rejected: "not_pending" };
    }
    const applied = await this.db.withTransaction(async (tx) => {
      const row = (await tx.query(
        `UPDATE agile_releases SET deploy_json = $1, updated_at = $2
         WHERE id = $3 AND deploy_json = $4 RETURNING id`,
        [JSON.stringify(input.deploy), now, input.releaseId, releaseRow.deploy_json],
      )).rows[0];
      if (!row) return false;
      await tx.query(
        `INSERT INTO agile_release_audit (id, release_id, owner_id, action, actor_id, note, status, deploy_json, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [newId("relaudit"), input.releaseId, releaseRow.owner_id, input.action, input.actorId, null, input.deploy.status, JSON.stringify(input.deploy), now],
      );
      return true;
    });
    const release = toRelease((await this.db.query("SELECT * FROM agile_releases WHERE id = $1", [input.releaseId])).rows[0] as unknown as ReleaseRow);
    if (applied) return { applied, release };
    const stored = release.deploy ?? null;
    const sameIdentity = Boolean(stored) && stored!.deliveryId === input.deploy.deliveryId && stored!.attempt === input.deploy.attempt;
    return { applied, release, rejected: sameIdentity ? "not_pending" : "stale_attempt" };
  }

  async recordRejection(input: {
    releaseId: string;
    actorId: string;
    detail: string;
    deploy: ReleaseDeployRecord;
    now?: string;
    action?: string;
  }): Promise<void> {
    const now = input.now ?? this.now();
    const releaseRow = (await this.db.query("SELECT owner_id FROM agile_releases WHERE id = $1", [input.releaseId])).rows[0] as { owner_id: string } | undefined;
    if (!releaseRow) throw new AgileError("RELEASE_NOT_FOUND", "发布不存在", 404);
    await this.db.query(
      `INSERT INTO agile_release_audit (id, release_id, owner_id, action, actor_id, note, status, deploy_json, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [newId("relaudit"), input.releaseId, releaseRow.owner_id, input.action ?? "release.deploy_rejected", input.actorId, input.detail, input.deploy.status, JSON.stringify(input.deploy), now],
    );
  }

  async expireStale(input: { now?: string; timeoutMs: number }): Promise<string[]> {
    const now = input.now ?? this.now();
    const rows = (await this.db.query("SELECT id, deploy_json FROM agile_releases WHERE deploy_json IS NOT NULL")).rows as unknown as Array<{ id: string; deploy_json: string | null }>;
    const expired: string[] = [];
    for (const row of rows) {
      const deploy = parseJson<ReleaseDeployRecord | null>(row.deploy_json, null);
      if (!deploy || deploy.status !== "pending") continue;
      const startedAt = deploy.startedAt ?? deploy.at;
      const age = Date.parse(now) - Date.parse(startedAt);
      if (!Number.isFinite(age) || age < input.timeoutMs) continue;
      const result = await this.settle({
        releaseId: row.id,
        actorId: "system:release-callback-timeout",
        now,
        action: "release.deploy_failed",
        deploy: {
          ...deploy,
          status: "failed",
          detail: `等待部署系统回调超时（超过 ${Math.round(input.timeoutMs / 60_000)} 分钟未收到结果）`,
          at: now,
          finishedAt: now,
        },
      });
      if (result.applied) expired.push(row.id);
    }
    return expired;
  }
}

import type { Run } from "../shared/types.js";
import { encodeRunCursor, type RunPageRequest } from "../shared/run-pagination.js";
import type { Db } from "./db.js";
import type { RunSearchFilter } from "./run-search.js";

const FINISHED = "state IN ('completed', 'failed', 'cancelled')";
const RUN_COLUMNS = "id, owner_id, last_seq, updated_at, document_json";
const ORDER = "updated_at DESC, id DESC";
const RECENT_MS = 7 * 24 * 60 * 60 * 1000;

type CatalogRow = { owner_id: string; last_seq: number; updated_at: string; document_json: string };

export class RunCatalog {
  constructor(private readonly db: Db) {}

  private parse(row: Record<string, unknown>) {
    const { owner_id, last_seq, updated_at, document_json } = row as CatalogRow;
    const run = JSON.parse(document_json) as Run;
    return { ...run, ownerId: owner_id, lastSeq: Number(last_seq), updatedAt: updated_at };
  }

  async warm(limit: number) {
    const since = new Date(Date.now() - RECENT_MS).toISOString();
    const result = await this.db.query(
      `SELECT ${RUN_COLUMNS} FROM runs WHERE NOT (${FINISHED}) OR updated_at >= $1
       ORDER BY CASE WHEN ${FINISHED} THEN 1 ELSE 0 END, ${ORDER} LIMIT $2`,
      [since, limit],
    );
    return result.rows.map((row) => this.parse(row));
  }

  async read(id: string, owner?: string | string[]) {
    const keys = owner === undefined ? undefined : typeof owner === "string" ? [owner] : owner;
    if (keys?.length === 0) return undefined;
    const result = await this.db.query(
      `SELECT ${RUN_COLUMNS} FROM runs WHERE id = $1${keys ? " AND owner_id = ANY($2)" : ""}`,
      keys ? [id, keys] : [id],
    );
    return result.rows[0] && this.parse(result.rows[0]);
  }

  private filter(owner: string | string[], filter: RunSearchFilter) {
    const args: unknown[] = [Array.isArray(owner) ? owner : [owner]];
    const conditions = ["owner_id = ANY($1)"];
    if (filter.state) {
      args.push(filter.state);
      conditions.push(`state = $${args.length}`);
    }
    if (filter.query) {
      args.push(filter.query.toLowerCase());
      const value = `$${args.length}`;
      const doc = "CAST(document_json AS jsonb)";
      const notes = `${doc} -> 'humanNotes'`;
      conditions.push(`(
        strpos(lower(${doc} ->> 'title'), ${value}) > 0
        OR strpos(lower(${doc} ->> 'task'), ${value}) > 0
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(${notes}) = 'array' THEN ${notes} ELSE '[]'::jsonb END
          ) AS n(note) WHERE strpos(lower(n.note ->> 'note'), ${value}) > 0
        )
      )`);
    }
    return { args, where: conditions.join(" AND ") };
  }

  async list(owner: string | string[], filter: RunSearchFilter) {
    const { args, where } = this.filter(owner, filter);
    const result = await this.db.query(`SELECT ${RUN_COLUMNS} FROM runs WHERE ${where} ORDER BY ${ORDER}`, args);
    return result.rows.map((row) => this.parse(row));
  }

  async page(owner: string | string[], filter: RunSearchFilter, { limit, cursor }: RunPageRequest) {
    const { args, where } = this.filter(owner, filter);
    const pageArgs = [...args];
    let after = "";
    if (cursor) {
      const timestamp = pageArgs.push(cursor[0]);
      const id = pageArgs.push(cursor[1]);
      after = ` AND (updated_at, id) < ($${timestamp}, $${id})`;
    }
    const end = pageArgs.push(limit + 1);
    const [result, count] = await Promise.all([
      this.db.query(`SELECT ${RUN_COLUMNS} FROM runs WHERE ${where}${after} ORDER BY ${ORDER} LIMIT $${end}`, pageArgs),
      this.db.query(`SELECT count(*) AS total,
        count(*) FILTER (WHERE state NOT IN ('completed','failed','cancelled','needs_human')) AS running
        FROM runs WHERE ${where}`, args),
    ]);
    const runs = result.rows.slice(0, limit).map((row) => this.parse(row));
    return {
      runs,
      nextCursor: result.rows.length > limit ? encodeRunCursor(runs[runs.length - 1]) : null,
      total: Number(count.rows[0].total),
      running: Number(count.rows[0].running),
    };
  }

  async findByKey(owner: string | string[], key: string) {
    const result = await this.db.query(
      `SELECT ${RUN_COLUMNS} FROM runs
       WHERE owner_id = ANY($1) AND CAST(document_json AS jsonb) ->> 'idempotencyKey' = $2
       ORDER BY ${ORDER} LIMIT 1`,
      [Array.isArray(owner) ? owner : [owner], key],
    );
    return result.rows[0] && this.parse(result.rows[0]);
  }
}

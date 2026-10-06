import { DEFAULT_LOCALE, t, type Locale } from "./i18n";

/**
 * A2 — pure merge planning shared by the web server (admin gate + response
 * shaping) and the worker (the actual Git commands). Keeping the decision logic
 * here means the conflict/fast-forward semantics are unit-testable without a
 * real git remote, worker or docker.
 */

export type MergeStrategy = "fast-forward" | "merge-commit";

/**
 * A merge is only fast-forwarded when the workspace's default branch is already
 * an ancestor of the run branch. Otherwise a real merge commit is required;
 * force-pushing or rewriting history is never an option.
 */
export function planMergeStrategy(input: { headIsAncestor: boolean }): MergeStrategy {
  return input.headIsAncestor ? "fast-forward" : "merge-commit";
}

/**
 * Parses `git diff --name-only --diff-filter=U` output (one unmerged path per
 * line) or a porcelain status block into a stable, de-duplicated, bounded list
 * of conflicting paths. Never invents paths from unrelated output.
 */
export function parseConflictingPaths(output: string | null | undefined, limit = 50): string[] {
  const text = typeof output === "string" ? output : "";
  const paths = new Set<string>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line.trim()) continue;
    const porcelain = /^([ MADRCU?!]{2})\s+(.+)$/.exec(line);
    if (porcelain) {
      // Porcelain status: only unmerged codes are conflicts; ordinary modified
      // entries (` M`, `??`, ...) must never be reported as conflicting.
      if (/^(?:UU|AA|DD|AU|UA|DU|UD)$/.test(porcelain[1])) paths.add(porcelain[2].trim());
      continue;
    }
    paths.add(line.trim());
  }
  return [...paths].filter(Boolean).slice(0, limit);
}

/**
 * R: the workspace-restore state the worker reports on a failed merge. Forwarded
 * verbatim so the UI can distinguish "restored to the original branch" from
 * "restore failed, needs a human". Absent fields stay absent (never fabricated).
 */
export interface MergeRestoreFields {
  restored?: boolean;
  restoreError?: string;
}

/** Narrows an untrusted merge failure payload into the two restore fields. */
export function mergeRestoreFields(input: { restored?: unknown; restoreError?: unknown }): MergeRestoreFields {
  const fields: MergeRestoreFields = {};
  if (typeof input.restored === "boolean") fields.restored = input.restored;
  if (typeof input.restoreError === "string" && input.restoreError.trim()) fields.restoreError = input.restoreError;
  return fields;
}

/**
 * Human-readable line for the run detail's merge/approve area. The copy is
 * client-visible, so it is rendered from the catalog; `locale` defaults to 中文
 * to keep the server-side callers and existing tests unchanged.
 */
export function describeMergeRestore(input: MergeRestoreFields, locale: Locale = DEFAULT_LOCALE): string | undefined {
  if (input.restored === true) return t(locale, "merge.restored");
  if (input.restored === false) {
    return input.restoreError
      ? t(locale, "merge.restoreFailedDetail", { detail: input.restoreError })
      : t(locale, "merge.restoreFailed");
  }
  return undefined;
}

export interface MergeConflictReply extends MergeRestoreFields {
  status: 409;
  code: "MERGE_CONFLICT";
  message: string;
  conflictingPaths: string[];
}

/** Client-visible shape of a refused merge (workspace left untouched). */
export function mergeConflictReply(paths: string[], detail: MergeRestoreFields = {}): MergeConflictReply {
  const conflictingPaths = [...new Set(paths.filter(Boolean))].slice(0, 50);
  return {
    status: 409,
    code: "MERGE_CONFLICT",
    message: `合并存在冲突（${conflictingPaths.length} 个文件），已中止且未修改工作区：${conflictingPaths.slice(0, 5).join("、")}`,
    conflictingPaths,
    ...mergeRestoreFields(detail),
  };
}

/** Body the worker returns from `POST /runs/:id/merge`. */
export interface MergeOutcome {
  ok: true;
  commit: string;
  targetBranch: string;
  strategy: MergeStrategy;
}

export type MergeResult =
  | MergeOutcome
  | ({ ok: false; code: string; error: string; conflictingPaths?: string[] } & MergeRestoreFields);

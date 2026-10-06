import type { Locale } from "./i18n.js";

export type RunState =
  | "queued"
  | "preparing"
  | "developing"
  | "checking"
  | "reviewing"
  | "completed"
  | "needs_human"
  | "failed"
  | "cancelled";

export type RunMode = "demo" | "real";

/**
 * Per-run review scope for the repair loop.
 *
 * - `"all"` (default, and the behaviour of every pre-existing run): every
 *   unresolved medium/high/critical finding keeps blocking the review verdict
 *   and completion.
 * - `"blocking"`: medium/low findings are still recorded on the run (and stay in
 *   the acceptance snapshot's remaining list) but no longer block the verdict or
 *   completion, so a large-scope loop can converge on the critical/high work
 *   instead of looping to the round cap. Critical/high findings block exactly as
 *   before.
 */
export type ReviewScope = "all" | "blocking";

export interface Finding {
  id: string;
  severity: "critical" | "high" | "medium" | "low";
  file: string | null;
  line: number | null;
  title: string;
  evidence: string;
  requiredChange: string;
  resolved: boolean;
  /** AUD-11: stable identity across rounds (id-independent fingerprint). */
  fingerprint?: string;
  /** AUD-11: first round this problem was reported in. */
  firstSeenRound?: number;
  /** AUD-11: most recent round this problem was reported in. */
  lastSeenRound?: number;
  /** AUD-11: how many reviews reported this problem. */
  observations?: number;
  /** GAP-03: consecutive reviews that reported this problem unresolved. */
  consecutiveRounds?: number;
}

export interface CheckResult {
  id: string;
  name: string;
  command: string;
  status: "pending" | "running" | "passed" | "failed";
  durationMs?: number;
  /** GAP-04: process exit code for the check command (AT-REVIEW-002). */
  exitCode?: number;
  output?: string;
}

export interface RunEvent {
  seq: number;
  runId: string;
  round: number;
  source: "system" | "developer" | "checks" | "reviewer";
  type: string;
  message: string;
  at: string;
  meta?: Record<string, unknown>;
}

/** Terminal verdict a review round can carry; `none` means no verdict (yet). */
export type RoundVerdict = "approved" | "changes_requested" | "none";

/**
 * Read-only per-round workflow summary returned by `GET /api/runs/:id/rounds`.
 *
 * It is aggregated server-side from all of a run's `run_events` + `run_findings`
 * so the topology's round model never depends on how many events a client
 * currently buffers. Additive: older servers simply do not serve the route and
 * the client falls back to its event-derived model.
 */
export interface RoundSummary {
  round: number;
  /** Timestamp of the round's first event, when one exists. */
  startedAt?: string;
  /** Timestamp of the terminal review verdict, when the round has one. */
  finishedAt?: string;
  verdict: RoundVerdict;
  /** The `review.changes_requested` message for this round, when one exists. */
  reason?: string;
  checks: { passed: number; failed: number };
  findings: { total: number; resolved: number };
  /** Deadline / recovery / failed-resume with no review verdict in this round. */
  interrupted: boolean;
}

export interface RunRoundsResponse {
  schemaVersion: number;
  rounds: RoundSummary[];
}

export type ChatChannel = "developer" | "reviewer" | "handoff" | "checks" | "system";

export type ChatParticipant = "orchestrator" | "developer" | "reviewer" | "checks" | "user";

export type ChatRole = "prompt" | "response" | "feedback" | "status" | "tool";

export interface ChatMessage {
  id: string;
  seq: number;
  runId: string;
  round: number;
  channel: ChatChannel;
  from: ChatParticipant;
  to: ChatParticipant;
  role: ChatRole;
  content: string;
  at: string;
  /**
   * Item-2 (additive): structured review findings carried by a review hand-off
   * message. Present on messages produced after this field existed; older runs
   * fall back to parsing JSON findings out of `content`.
   */
  findings?: Finding[];
  /** Item-3 (additive): sub-agent codename when this message belongs to one. */
  agent?: string;
}

/** The human action a stored requirement note came from. */
export type HumanNoteKind = "approve_continue" | "approve_accept" | "resume" | "reject" | "reopen";

/**
 * A durable, human-authored note attached to a run (approve note, resume
 * instruction, reject reason). Distinct from event `meta`, which stays as-is.
 */
export interface HumanNote {
  at: string;
  kind: HumanNoteKind;
  note: string;
  by?: string;
}

export type WorkloadSize = "small" | "medium" | "large";

export interface SubAgentTask {
  id: string;
  title: string;
  description: string;
  files: string[];
  dependsOn: string[];
  status: "planned" | "running" | "completed" | "merged" | "failed";
  branch?: string;
  summary?: string;
  durationMs?: number;
  /**
   * Item-3 (additive): stable, human-readable codename assigned deterministically
   * from runId + task id. The `title` stays the authoritative task description.
   */
  name?: string;
}

export interface DevelopmentPlan {
  complexity: WorkloadSize;
  rationale: string;
  strategy: "single" | "parallel";
  tasks: SubAgentTask[];
}

export interface Run {
  id: string;
  ownerId: string;
  title: string;
  task: string;
  repository: string;
  workspaceId?: string;
  branch: string;
  mode: RunMode;
  state: RunState;
  round: number;
  maxRounds: number;
  createdAt: string;
  updatedAt: string;
  developer: { provider: string; model: string };
  reviewer: { provider: string; model: string };
  checks: CheckResult[];
  findings: Finding[];
  diff: string;
  summary: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    estimatedCost: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    totalTokens?: number;
  };
  durationMs: number;
  lastSeq: number;
  worktree?: string;
  plan?: DevelopmentPlan;
  /** COST-001: per-role (planner/developer/sub-agent/integrator/reviewer) usage. */
  usageRoles?: RunRoleUsage[];
  /**
   * Sprint 2: additive per-Pi-session reuse/latency summary. Tokens here are a
   * breakdown of the same stream counted in `usage`; they are never added to it.
   */
  sessions?: RunSessionSummary[];
  /** COST-002: number of model calls started for this run. */
  modelCalls?: number;
  /** AUD-04: content snapshot hash that passed the required checks. */
  checkSnapshot?: string;
  /** AUD-04: content snapshot hash the latest review verdict applies to. */
  reviewSnapshot?: string;
  /** AUD-04: whether the checks for `checkSnapshot` passed. */
  checkPassed?: boolean;
  /** GAP-01: idempotency key supplied at creation time. */
  idempotencyKey?: string;
  /** GAP-01: pinned base commit for reproducible diffs (AT-GIT-001). */
  baseSha?: string;
  /** GAP-01: acceptance criteria captured with the task. */
  acceptanceCriteria?: string;
  /**
   * Sprint 3: the story this run was submitted for (when created through
   * `POST /api/stories/:id/runs`). Additive; the worker ignores it.
   */
  storyId?: string;
  /**
   * Sprint 3: story-level parallel task cap captured at submission. Additive
   * metadata for the UI; the orchestrator's own concurrency rules are unchanged.
   */
  maxParallel?: number;
  /** GAP-01/COST-002: hard budget fixed at creation and shown in the UI. */
  budget?: {
    maxTokens: number;
    maxCostUsd: number;
    maxModelCalls: number;
    maxDurationSeconds: number;
  };
  /** GAP-01: credential fingerprint (sha256 prefix) per role at creation time. */
  credentialVersions?: { developer?: string; reviewer?: string };
  /** GAP-01: workflow/prompt/plugin policy snapshot used for this run. */
  pipelineVersion?: string;
  /**
   * RESUME: ISO timestamp stamped whenever a human continues/resumes a run. The
   * worker measures the next round's `maxDurationSeconds` window from
   * `max(deadlineBaseAt, startedAt, createdAt)`, so a run whose original window
   * already elapsed gets a fresh budget instead of bouncing to needs_human with
   * `run.deadline_exceeded`. Additive and backward compatible — runs written
   * before this field exist without it (initial-round semantics unchanged).
   */
  deadlineBaseAt?: string;
  /** AUD-10: calls whose provider usage could not be determined. */
  usageUnknownCalls?: number;
  /** GAP-04: human approval of the delivered worktree. */
  approvedAt?: string;
  approvedBy?: string;
  /**
   * 需求历史: durable human notes (approve/resume/reject) written on this run.
   * Additive and backward compatible — runs written before this field exist
   * without it and must be treated as an empty array.
   */
  humanNotes?: HumanNote[];
  /** A2: the merge commit, when an admin accepted with `mergeIntoWorkspace`. */
  merge?: RunMergeRecord;
  /**
   * B1: durable two-phase marker for an in-flight admin merge. Phase 1 writes it
   * to claim the merge before the worker touches Git; phase 2 clears it when the
   * merge record is committed. A crash between the worker merge and the DB write
   * leaves it as `committed_unrecorded` so a replay can converge the row.
   */
  mergePending?: RunMergePending;
  /** B1: when a delivered run was reopened (state moved back to needs_human). */
  reopenedAt?: string;
  reopenedBy?: string;
  /** B2: durable snapshot of what the operator accepted. */
  acceptance?: AcceptanceSnapshot;
  /**
   * REL-PUBLISH: durable, run-scoped code release. Development completion and
   * release are deliberately separate: a run may be `completed` while its
   * reviewed commit is still waiting to be merged or published.
   */
  release?: RunReleaseRecord;
  /**
   * Per-run review scope chosen by the operator when continuing a run. Additive
   * and backward compatible: runs written before this field exist are treated as
   * `"all"` (see `resolveReviewScope`), so no migration is required — the value
   * travels inside the run document and is read by the worker's review gate.
   */
  reviewScope?: ReviewScope;
  /**
   * 运行时文案语言 (docs/24-i18n.md §9): the locale this run was created in,
   * resolved from the creating request (`Accept-Language` → `?locale` → `zh`).
   * Additive and backward compatible — runs written before this field exist are
   * treated as `zh`. The worker uses it for its guard/stop event text and for the
   * agent prompts' locale instruction; historical events are never rewritten.
   */
  locale?: Locale;
}

/** A2: recorded outcome of merging a run branch into the workspace default branch. */
export interface RunMergeRecord {
  commit: string;
  strategy: "fast-forward" | "merge-commit";
  targetBranch: string;
  mergedAt: string;
  mergedBy: string;
}

export type RunReleaseStatus = "publishing" | "triggered" | "succeeded" | "failed";

/**
 * Durable result of an explicit administrator release request. `deliveryId`
 * stays stable across retries so a webhook can make delivery idempotent.
 */
export interface RunReleaseRecord {
  deliveryId: string;
  status: RunReleaseStatus;
  environment: string;
  commit: string;
  targetBranch: string;
  requestedAt: string;
  requestedBy: string;
  startedAt: string;
  finishedAt?: string;
  attempt: number;
  kind: "webhook" | "command";
  detail?: string;
  httpStatus?: number;
  deploymentId?: string;
  url?: string;
}

/** B1: lifecycle of the durable merge marker between the two phases. */
export type MergePendingState = "in_progress" | "committed_unrecorded";

/**
 * B1: durable marker that claims a merge for one approval attempt and, when the
 * worker has already produced a commit but the run row could not be updated,
 * carries everything a replay needs to converge the database.
 */
export interface RunMergePending {
  /** Unique per attempt; a CAS guard uses it so two approvals cannot both merge. */
  token: string;
  state: MergePendingState;
  sourceBranch: string;
  targetBranch: string | null;
  startedAt: string;
  startedBy: string;
  /**
   * The approval payload captured before the worker call, so a replay can
   * finish the accept (state/acceptance/notes) without the original request.
   */
  approval: {
    acceptedAt: string;
    acceptedBy: string;
    summary: string;
    note: string | null;
    acceptance: AcceptanceSnapshot;
  };
  /** Worker-reported commit/strategy, recorded once the merge succeeded. */
  commit?: string;
  strategy?: RunMergeRecord["strategy"];
  mergedAt?: string;
  attempts?: number;
  lastError?: string;
}

/**
 * B2: durable record of an accepted delivery. Additive and backward compatible.
 * `null` identity fields mean genuinely unknown, never a fabricated zero.
 */
export interface AcceptanceSnapshot {
  acceptedAt: string;
  acceptedBy: string;
  note: string | null;
  acknowledgedOpenFindings: boolean;
  findings: {
    resolved: { count: number; ids: string[] };
    remaining: { count: number; items: Array<{ id: string; severity: Finding["severity"] }> };
  };
  diff: { artifactId: string | null; sha256: string | null; bytes: number | null };
  checks: { total: number; passed: number; failed: number };
  usage: { inputTokens: number; outputTokens: number; estimatedCost: number; modelCalls: number };
}

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
}

export interface RunRoleUsage {
  role: "planner" | "developer" | "sub-agent" | "integrator" | "reviewer" | string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  estimatedCost: number;
  calls: number;
}

/**
 * Sprint 2 phase 1: summary of one Pi session (one `--session-id` reused across
 * invocations, or one stateless `--no-session` call). Additive and backward
 * compatible: runs written before this field exist are treated as having no
 * per-session data. `rounds` are the distinct rounds the session was used in;
 * `calls` counts instrumented invocations (a session may be resumed several
 * times within a round, e.g. a protocol retry is its own session).
 */
export interface RunSessionSummary {
  sessionId: string;
  role: "planner" | "developer" | "sub-agent" | "integrator" | "reviewer" | string;
  rounds: number[];
  calls: number;
  /** True when at least one invocation continued an existing session. */
  resumed: boolean;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  modelCalls: number;
  firstAt: string;
  lastAt: string;
}

export interface ProjectInfo {
  id: string;
  name: string;
  relativePath: string;
  branch: string;
  dirty: boolean;
}

export interface CreateRunInput {
  title: string;
  task: string;
  repository: string;
  workspaceId?: string;
  mode: RunMode;
  checks?: string[];
  developerModel?: ModelSelection;
  reviewerModel?: ModelSelection;
  /** GAP-01: idempotent creation key; the same key returns the existing run. */
  idempotencyKey?: string;
  /** GAP-01: acceptance criteria captured with the task. */
  acceptanceCriteria?: string;
}

export interface ConfigStatus {
  demoMode: boolean;
  piVersion: string;
  developer: { provider: string; model: string; credentialConfigured: boolean };
  reviewer: { provider: string; model: string; credentialConfigured: boolean };
  /**
   * AUD-09 / AT-MODEL-006/007: execution availability is decoupled from the
   * default provider/credential combination. It is true as long as real runs are
   * enabled and the user has at least one provider credential; the actual
   * per-role model combination is preflighted when a run is created.
   */
  realRunsAvailable: boolean;
  /** Providers the current user has a configured credential for. */
  configuredProviders?: string[];
  /** Configured providers whose key was live-verified (AUD-08 / AT-MODEL-004). */
  verifiedProviders?: string[];
  /**
   * AUD-08: providers whose key was asserted valid by the operator because
   * probing is disabled (`PI_MODEL_PROBE_MODE=off`). These are NOT live-verified
   * and must never be presented as such.
   */
  assertedProviders?: string[];
  /** A1: true when `PI_MERGE_REQUEST_*` is configured, so the UI can enable MR. */
  mergeRequestConfigured?: boolean;
  /** Explicit release action is available; no hook URL or secret is exposed. */
  releaseConfigured?: boolean;
}

export interface CurrentUser {
  id: string;
  email: string;
  legacyOwnerId?: string;
  /** Server-derived role hint used only to hide privileged controls in the UI. */
  isAdmin?: boolean;
}

/**
 * AUD-08 / AT-MODEL-004: credential verification history for one provider.
 * - `unchecked`: a key is stored but nothing is known about it.
 * - `operator_asserted`: probing is disabled and the operator asserted the key
 *   is valid (`PI_MODEL_PROBE_MODE=off`). Never carries a `verifiedAt`.
 * - `live`: a live provider `/models` probe succeeded and set `verifiedAt`.
 */
export type CredentialVerificationState = "unchecked" | "operator_asserted" | "live";

/**
 * AUD-08 / AT-MODEL-001: per-model capabilities reported by the provider at
 * probe time. Every field is optional and only present when the provider
 * actually reported it — values are never invented from the static catalog.
 */
export interface ProviderModelCapability {
  contextWindow?: number;
  maxOutputTokens?: number;
  toolCalling?: boolean;
  reasoning?: boolean;
}

export interface CredentialStatus {
  developerConfigured: boolean;
  reviewerConfigured: boolean;
  updatedAt: string | null;
  providers: Array<{
    provider: string;
    configured: boolean;
    masked: string | null;
    updatedAt: string | null;
    /** AUD-08 / AT-MODEL-004: last successful live probe, null when unverified. */
    verifiedAt?: string | null;
    /** AUD-08 / AT-MODEL-001: provider-reported model ids captured by the probe. */
    verifiedModels?: string[] | null;
    /** AUD-08: `live` | `operator_asserted` | `unchecked`. */
    verification?: CredentialVerificationState;
    /** Convenience: true only for the opt-out `operator_asserted` state. */
    asserted?: boolean;
    /** Human-readable status label, e.g. 未校验（操作者断言）. */
    verificationLabel?: string;
    /** AUD-08 / AT-MODEL-001: provider-reported per-model capabilities. */
    capabilities?: Record<string, ProviderModelCapability> | null;
  }>;
}

/**
 * AUD-08 / AT-MODEL-004: what we actually know about a provider credential.
 * `configured` only means a key is stored; `verifiedAt`/`verifiedModels` come
 * from a live provider preflight. A length-valid key on its own is never enough
 * to call a model available. `operator_asserted` credentials were explicitly
 * accepted by the operator with probing disabled, and are surfaced distinctly.
 */
export interface ProviderAvailability {
  provider: string;
  configured: boolean;
  verifiedAt: string | null;
  verifiedModels: string[] | null;
  /** Convenience flag; when omitted it is derived from a live `verifiedAt`. */
  verified?: boolean;
  /** AUD-08: full verification state; defaults to derived value when omitted. */
  verification?: CredentialVerificationState;
  /** Convenience: true only for `operator_asserted`. */
  asserted?: boolean;
  /** AUD-08 / AT-MODEL-001: provider-reported per-model capabilities, by model. */
  capabilities?: Record<string, ProviderModelCapability> | null;
}

export type ModelRole = "developer" | "reviewer";

export interface ModelCatalogEntry {
  id: string;
  provider: string;
  model: string;
  label: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  toolCalling: boolean;
  reasoning: boolean;
  roles: ModelRole[];
  status: "available" | "preview" | "deprecated";
}

export interface ModelInfo extends ModelCatalogEntry {
  available: boolean;
  unavailableReason: "credential_missing" | "credential_unverified" | "model_unverified" | "role_restricted" | null;
  /** AUD-08 / AT-MODEL-001: model is backed by a live-verified credential. */
  verified?: boolean;
  /** AUD-08 / AT-MODEL-004: when the backing provider key was last verified. */
  verifiedAt?: string | null;
  /** AUD-08: `live` | `operator_asserted` | `unchecked` for the backing provider. */
  verification?: CredentialVerificationState;
  /** AUD-08: true when usable only because the operator asserted the key. */
  asserted?: boolean;
  /** Human-readable verification label, e.g. 未校验（操作者断言）. */
  verificationLabel?: string;
  /**
   * AUD-08 / AT-MODEL-001: true only when the provider itself reported
   * capabilities for this model. When false the catalog values are used but are
   * not runtime-verified.
   */
  capabilitiesVerified?: boolean;
  /** AUD-08 / AT-MODEL-001: the provider-reported capability payload, if any. */
  capabilities?: ProviderModelCapability | null;
}

export interface ModelSelection {
  provider: string;
  model: string;
}

export interface ModelCatalogResponse {
  models: ModelInfo[];
  defaultDeveloper: ModelSelection;
  defaultReviewer: ModelSelection;
  /**
   * AUD-08 / AT-MODEL-001: provider-level runtime verification, so the UI can
   * surface the concrete verifiedModels captured from the Pi/provider probe.
   */
  verifiedProviders?: Array<{
    provider: string;
    verifiedAt: string | null;
    verifiedModels: string[] | null;
    verification?: CredentialVerificationState;
    asserted?: boolean;
    verificationLabel?: string;
    capabilities?: Record<string, ProviderModelCapability> | null;
  }>;
}

export type WorkspaceStatus = "active" | "unregistered" | "invalid";

/** GAP-04 / AUD-16: a downloadable run artifact (metadata only in listings). */
export interface RunArtifact {
  runId: string;
  artifactId: string;
  kind: string;
  bytes: number;
  sha256: string | null;
  /** GAP-01: pinned base commit the patch was produced against. */
  baseSha: string | null;
  createdAt: string;
}

export interface WorkspaceGitInfo {
  branch: string | null;
  head: string | null;
  dirty: boolean;
  dirtyFiles: string[];
}

/** B4: what the *calling* user may do with a workspace. */
export type WorkspacePermission = "read" | "write";

export interface Workspace {
  id: string;
  ownerId: string;
  nodeId: string;
  name: string;
  type: "server";
  rootPath: string;
  canonicalPath: string;
  repositoryUrl: string | null;
  defaultBranch: string | null;
  defaultChecks: string[];
  status: WorkspaceStatus;
  git: WorkspaceGitInfo | null;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * B4: the caller's permission on this workspace — `write` for the owner/an
   * admin or a write grant, `read` for a read-only grant. Mutating routes reject
   * `read` with `WORKSPACE_READ_ONLY`.
   */
  permission: WorkspacePermission;
}

export interface WorkspaceVerifyResult {
  ok: boolean;
  code?: string;
  error?: string;
  relativePath?: string;
  canonicalPath?: string;
  name?: string;
  branch?: string;
  head?: string;
  dirty?: boolean;
  dirtyFiles?: string[];
}

/** 账户管理: the two internal roles. `admin` may manage accounts and merge/publish. */
export type AccountRole = "admin" | "user";
/** 账户管理: soft account state; `disabled` blocks new logins but keeps history. */
export type AccountStatus = "active" | "disabled";

/**
 * 账户管理: one row of `GET /api/accounts`. Additive; contains no credential,
 * identity-issuer or subject data — only what an administrator needs to manage
 * an account. `lastLoginAt` is null when the user has never logged in.
 */
export interface AccountSummary {
  id: string;
  email: string;
  role: AccountRole;
  status: AccountStatus;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  /** Runs whose owner id (internal or legacy) is this user. */
  runsOwned: number;
  /** Non-unregistered workspaces owned by this user. */
  workspacesOwned: number;
}

/** 账户管理: an explicit `workspace_grants` row, with the workspace name for display. */
export interface AccountGrant {
  workspaceId: string;
  workspaceName: string | null;
  permission: WorkspacePermission;
  grantedBy: string | null;
  createdAt: string;
}

/** 账户管理: `GET /api/accounts/:id` — summary plus this user's workspace grants. */
export interface AccountDetail extends AccountSummary {
  grants: AccountGrant[];
}

/** 账户管理: admin-only workspace catalog used by the grants editor. */
export interface AccountWorkspaceOption {
  id: string;
  name: string;
  ownerId: string;
  status: WorkspaceStatus;
}

import type { ProviderCreditUpdate, ProviderCreditUpdateResponse, ProviderCreditsResponse } from "../shared/provider-credits-api";
import type { AgileMetricsResponse, ReleaseRetrospective, ReleaseSummary } from "../shared/agile-metrics";
import type { DecisionBrief } from "../shared/decision-brief";
import type { DecisionAuditProjection } from "../shared/decision-audit";
import type { DecisionMetricsResponse } from "../shared/decision-metrics";
export type { DecisionMetricsResponse } from "../shared/decision-metrics";
import type { AgileProject, AgileRelease, AgileSprint, AgileStory, ReleaseDeployRecord, ModelTemplate, StoryDetail, StoryPriority, StoryStatus } from "../shared/agile";
import type { ConfigStatus, CredentialStatus, CurrentUser, ModelCatalogResponse, ModelSelection, Run, RunArtifact, RunEvent, RunRoundsResponse, RunState, Workspace, AccountDetail, AccountSummary, AccountWorkspaceOption, WorkspacePermission } from "../shared/types";
import { LOCALE_TAGS, type Locale } from "../shared/i18n";

/**
 * AUD-09 / docs/26 §11: `/api/config/status` augments the shared `ConfigStatus`
 * with the decision-plane preflight. Only presence/shape is projected — the key,
 * base URL and every env value stay server-side, so the client must never expect
 * a credential value here.
 */
export interface DecisionEngineStatus {
  engine: "disabled" | "mock" | "jev";
  mode: "off" | "shadow" | "assist" | "enforce";
  /** Engine is `jev` and the deployment reports a key — never the key itself. */
  configured: boolean;
  policyVersion: string | null;
  /** Present only when the configuration was rejected (standard reason code). */
  reason?: string;
}

/** A3: read-only deployment status returned by `GET /api/deployments`. */
export interface DeploymentRecord {
  at: string | null;
  version: string | null;
  role: string | null;
  commit: string | null;
  status: string | null;
  note: string | null;
  raw: string;
}

export interface DeploymentStatus {
  web: { version: string | null };
  worker: { version: string | null };
  rollbackTags: string[];
  records: DeploymentRecord[];
  log: { available: boolean; path: string; error?: string };
  at: string;
}

export interface BatchSummary {
  action: "continue" | "accept" | "cleanup";
  total: number;
  succeeded: number;
  failed: number;
  /** B6: per-run on-disk outcome for cleanup actions. */
  results: Array<{ runId: string; ok: boolean; code?: string; error?: string; state?: string; storage?: "removed" | "kept" }>;
}

/** SYS-01: availability marker shared by every system status section. */
export type SystemSectionStatus = "ok" | "unavailable";

/** SYS-01: read-only system status returned by `GET /api/system/status`. */
export interface SystemStatusResponse {
  schemaVersion: number;
  at: string;
  versions: { web: string | null; worker: string | null };
  infrastructure: {
    database: { status: SystemSectionStatus; error?: string };
    worker: { status: "ok" | "unreachable" | "unknown"; activeJobs?: number; storage?: "ok" | "low" | "critical" };
  };
  queue: {
    status: SystemSectionStatus;
    byState: Record<string, number>;
    total: number;
    active: number;
    oldestQueuedAt: string | null;
    oldestQueuedAgeMs: number | null;
  };
  runs: {
    status: SystemSectionStatus;
    byState: Record<string, number>;
    total: number;
    active: { queued: number; preparing: number; developing: number; checking: number; reviewing: number; total: number };
    oldestQueuedAt: string | null;
    oldestQueuedAgeMs: number | null;
  };
  usage: {
    status: SystemSectionStatus;
    date: string;
    basis: "runs-updated-today";
    scannedRuns: number;
    truncated: boolean;
    modelCalls: number | null;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    estimatedCost: number;
  };
  failures: {
    status: SystemSectionStatus;
    windowHours: number;
    byCategory: Record<string, number>;
    total: number;
    scanned: number;
    truncated: boolean;
    recent: Array<{ at: string | null; type: string; category: string; summary: string }>;
  };
  /** Deployment summary reusing `/api/deployments`, minus the server-side log path. */
  deployments: {
    web: { version: string | null };
    worker: { version: string | null };
    rollbackTags: string[];
    records: DeploymentRecord[];
    log: { available: boolean; error?: string };
    at: string;
  } | null;
}


/**
 * Locale-aware request headers (docs/24-i18n.md §9): the client tells the server
 * which language the requester reads, so `POST /api/runs` records `run.locale`
 * and the worker writes its live text in that language. A browser sends its own
 * `Accept-Language` anyway; this makes the in-app choice explicit and wins.
 */
function localeHeaders(locale?: Locale): Record<string, string> | undefined {
  return locale ? { "Accept-Language": LOCALE_TAGS[locale] } : undefined;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as Record<string, unknown> & { error?: string; code?: string };
    // Keep the whole failure body: merge failures carry `restored`/`restoreError`
    // (R) that the run detail renders, beyond the human-readable `error`.
    const failure = new Error(error.error || `Request failed: ${response.status}`) as Error & { code?: string; status?: number; body?: Record<string, unknown> };
    failure.code = error.code;
    failure.status = response.status;
    failure.body = error;
    throw failure;
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  config: () => request<ConfigStatus>("/api/config/status"),
  me: () => request<CurrentUser>("/api/me"),
  credentialStatus: () => request<CredentialStatus>("/api/credentials/status"),
  models: () => request<ModelCatalogResponse>("/api/models"),
  saveCredentials: (body: { provider: string; apiKey: string } | { developerApiKey?: string; reviewerApiKey?: string }) =>
    request<CredentialStatus>("/api/credentials", { method: "PUT", body: JSON.stringify(body) }),
  deleteCredentials: (provider?: string) =>
    request<void>(`/api/credentials${provider ? `?provider=${encodeURIComponent(provider)}` : ""}`, { method: "DELETE" }),
  workspaces: () => request<{ workspaces: Workspace[] }>("/api/workspaces"),
  registerWorkspace: (body: { relativePath: string }) =>
    request<Workspace>("/api/workspaces/register", { method: "POST", body: JSON.stringify(body) }),
  createWorkspace: (body: { name: string }) =>
    request<Workspace>("/api/workspaces/create", { method: "POST", body: JSON.stringify(body) }),
  cloneWorkspace: (body: { url: string; name: string }) =>
    request<Workspace>("/api/workspaces/clone", { method: "POST", body: JSON.stringify(body) }),
  refreshWorkspace: (id: string) => request<Workspace>(`/api/workspaces/${id}/refresh`, { method: "POST" }),
  patchWorkspace: (id: string, body: { defaultChecks?: string[]; defaultBranch?: string }) =>
    request<Workspace>(`/api/workspaces/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  unregisterWorkspace: (id: string) => request<void>(`/api/workspaces/${id}`, { method: "DELETE" }),
  runs: (params: { query?: string; state?: RunState } = {}) => {
    const search = new URLSearchParams();
    if (params.query?.trim()) search.set("query", params.query.trim());
    if (params.state) search.set("state", params.state);
    const suffix = search.toString();
    return request<Run[]>(`/api/runs${suffix ? `?${suffix}` : ""}`);
  },
  run: (id: string) => request<Run>(`/api/runs/${id}`),
  events: (id: string) => request<RunEvent[]>(`/api/runs/${id}/events`),
  /** 拓扑轮次模型: server-aggregated per-round summary (source of truth for branches/badges). */
  runRounds: (id: string) => request<RunRoundsResponse>(`/api/runs/${id}/rounds`),
  /** 决策摘要: read-only aggregate answering accept-vs-continue for a parked run. */
  decisionBrief: (id: string, locale?: Locale) => request<DecisionBrief>(`/api/runs/${id}/decision-brief`, { headers: localeHeaders(locale) }),
  /**
   * 决策审计 (docs/26 §8.2): owner-scoped list of redacted decision-audit
   * projections, newest first. `limit` is bounded server-side.
   */
  decisions: (id: string, limit?: number) =>
    request<{ decisions: DecisionAuditProjection[] }>(`/api/runs/${id}/decisions${limit ? `?limit=${limit}` : ""}`),
  /**
   * docs/26 §16.1: read-only decision-plane monitoring aggregate (owner-agnostic).
   * The server window/threshold are configured by env, not by the caller.
   */
  decisionMetrics: () => request<DecisionMetricsResponse>("/api/decisions/metrics"),
  /** AT-JEV-062：人工录入的 provider 额度 + 由决策审计算出的已花费（运营读数）。 */
  providerCredits: () => request<ProviderCreditsResponse>("/api/provider-credits"),
  setProviderCredit: (body: ProviderCreditUpdate) =>
    request<ProviderCreditUpdateResponse>("/api/provider-credits", { method: "PUT", body: JSON.stringify(body) }),
  artifacts: (id: string) => request<{ artifacts: RunArtifact[] }>(`/api/runs/${id}/artifacts`),
  artifactDownloadUrl: (id: string, artifactId: string) => `/api/runs/${id}/artifacts/${encodeURIComponent(artifactId)}/download`,
  /** A1: full run patch (regenerated on the worker when no artifact body exists). */
  runPatchUrl: (id: string) => `/api/runs/${id}/patch`,
  createMergeRequest: (id: string) =>
    request<{ ok: boolean; mergeRequest: { url: string | null; id: string | null; number: string | null } }>(`/api/runs/${id}/merge-request`, { method: "POST" }),
  deployments: () => request<DeploymentStatus>("/api/deployments"),
  systemStatus: () => request<SystemStatusResponse>("/api/system/status"),
  reopenRun: (id: string, body: { note?: string; confirm?: boolean } = {}) =>
    request<Run>(`/api/runs/${id}/reopen`, { method: "POST", body: JSON.stringify(body) }),
  batchRuns: (body: { action: "continue" | "accept" | "cleanup"; runIds: string[]; note?: string; acknowledgeOpenFindings?: boolean; deleteRunDirectory?: boolean }) =>
    request<BatchSummary>("/api/runs/batch", { method: "POST", body: JSON.stringify(body) }),
  createRun: (body: { title: string; task: string; repository?: string; workspaceId?: string; mode: "demo" | "real"; checks?: string[]; developerModel?: ModelSelection; reviewerModel?: ModelSelection }, options: { locale?: Locale } = {}) =>
    request<Run>("/api/runs", { method: "POST", body: JSON.stringify(body), headers: localeHeaders(options.locale) }),
  cancelRun: (id: string) => request<Run>(`/api/runs/${id}/cancel`, { method: "POST" }),
  approveRun: (id: string, body: { mode?: "continue" | "accept"; note?: string; acknowledgeOpenFindings?: boolean; mergeIntoWorkspace?: boolean; reviewScope?: "all" | "blocking" } = {}) =>
    request<Run>(`/api/runs/${id}/approve`, { method: "POST", body: JSON.stringify(body) }),
  mergeRun: (id: string, body: { confirm: true; note?: string }) =>
    request<Run>(`/api/runs/${id}/merge`, { method: "POST", body: JSON.stringify(body) }),
  publishRun: (id: string, body: { environment: string; confirm: true; retry?: boolean }) =>
    request<Run>(`/api/runs/${id}/publish`, { method: "POST", body: JSON.stringify(body) }),
  rejectRun: (id: string, body: { reason?: string } = {}) =>
    request<Run>(`/api/runs/${id}/reject`, { method: "POST", body: JSON.stringify(body) }),
  cleanupRuns: (body: { runIds?: string[]; states?: Run["state"][]; olderThanDays?: number; scope?: "own" | "all"; dryRun?: boolean; deleteRunDirectory?: boolean } = {}) =>
    request<{ dryRun: boolean; deleteRunDirectory?: boolean; deleted?: number; runIds: string[]; matched: number }>("/api/runs/cleanup", { method: "POST", body: JSON.stringify(body) }),
  resumeRun: (id: string, body: { instruction?: string }) =>
    request<Run>(`/api/runs/${id}/resume`, { method: "POST", body: JSON.stringify(body) }),
  retryReviewRun: (id: string) => request<Run>(`/api/runs/${id}/retry-review`, { method: "POST" }),
  deleteRun: (id: string) => request<void>(`/api/runs/${id}`, { method: "DELETE" }),
  // ---------------------------------------------------------------- agile
  agileProjects: () => request<{ projects: AgileProject[] }>("/api/agile/projects"),
  createAgileProject: (body: { name: string; key: string; description?: string }) =>
    request<AgileProject>("/api/agile/projects", { method: "POST", body: JSON.stringify(body) }),
  agileStories: (params: { projectId?: string; sprintId?: string; status?: StoryStatus } = {}) => {
    const search = new URLSearchParams();
    if (params.projectId) search.set("projectId", params.projectId);
    if (params.sprintId) search.set("sprintId", params.sprintId);
    if (params.status) search.set("status", params.status);
    const suffix = search.toString();
    return request<{ stories: AgileStory[] }>(`/api/stories${suffix ? `?${suffix}` : ""}`);
  },
  createStory: (body: {
    projectId: string;
    title: string;
    description?: string;
    acceptanceCriteria?: string[];
    priority?: StoryPriority;
    estimate?: number | null;
    definitionOfDone?: string[];
    sprintId?: string | null;
    workspaceId?: string | null;
    status?: StoryStatus;
    developerModel?: ModelSelection | null;
    reviewerModel?: ModelSelection | null;
    budget?: { maxTokens: number; maxCostUsd: number; maxModelCalls: number; maxDurationSeconds: number } | null;
    maxParallel?: number | null;
  }) => request<AgileStory>("/api/stories", { method: "POST", body: JSON.stringify(body) }),
  story: (id: string) => request<StoryDetail>(`/api/stories/${id}`),
  patchStory: (id: string, body: { status?: StoryStatus; sprintId?: string | null; acceptanceCriteria?: string[]; definitionOfDone?: string[]; priority?: StoryPriority; estimate?: number | null; description?: string; title?: string }) =>
    request<AgileStory>(`/api/stories/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteStory: (id: string) => request<void>(`/api/stories/${id}`, { method: "DELETE" }),
  submitStory: (id: string, body: { mode: "demo" | "real"; workspaceId?: string; checks?: string[] } = { mode: "real" }) =>
    request<{ run: Run; story: StoryDetail }>(`/api/stories/${id}/runs`, { method: "POST", body: JSON.stringify(body) }),
  /** Kanban manual block with a required reason. */
  blockStory: (id: string, reason: string) =>
    request<StoryDetail>(`/api/stories/${encodeURIComponent(id)}/block`, { method: "POST", body: JSON.stringify({ reason }) }),
  /** Clears a manual block; 409 BLOCKED_BY_RUN while a linked run is parked. */
  unblockStory: (id: string) =>
    request<StoryDetail>(`/api/stories/${encodeURIComponent(id)}/unblock`, { method: "POST", body: JSON.stringify({}) }),
  /** Reopens a story whose latest run is terminal failed/cancelled back to `ready`.
   * 409 BLOCKED_BY_RUN (live/needs_human, run id in the message), 409
   * BLOCKED_BY_MANUAL or 409 STORY_NOT_REOPENABLE. Audited as `story.reopened`. */
  reopenStory: (id: string) =>
    request<StoryDetail>(`/api/stories/${encodeURIComponent(id)}/reopen`, { method: "POST", body: JSON.stringify({}) }),
  sprints: (projectId?: string) =>
    request<{ sprints: AgileSprint[] }>(`/api/sprints${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`),
  createSprint: (body: { projectId: string; name: string; goal?: string; startDate?: string | null; endDate?: string | null }) =>
    request<AgileSprint>("/api/sprints", { method: "POST", body: JSON.stringify(body) }),
  patchSprint: (id: string, body: { name?: string; goal?: string; status?: "planned" | "active" | "closed"; startDate?: string | null; endDate?: string | null }) =>
    request<AgileSprint>(`/api/sprints/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  releases: (projectId?: string) =>
    request<{ releases: AgileRelease[] }>(`/api/releases${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`),
  createRelease: (body: { projectId: string; name: string; version: string; notes?: string; status?: "planned" | "in_progress" | "released" | "cancelled"; storyIds?: string[] }) =>
    request<AgileRelease>("/api/releases", { method: "POST", body: JSON.stringify(body) }),
  patchRelease: (id: string, body: { name?: string; version?: string; notes?: string; status?: "planned" | "in_progress" | "released" | "cancelled"; storyIds?: string[] }) =>
    request<AgileRelease>(`/api/releases/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteRelease: (id: string) => request<void>(`/api/releases/${encodeURIComponent(id)}`, { method: "DELETE" }),
  /** Sprint 5: explicit release publish. Without `confirm` the server returns a
   * dry-run preview (guards + blocked stories) for the confirmation dialog.
   * `retry: true` is required to start a new deploy attempt after a failed or
   * timed-out one. */
  publishRelease: (id: string, body: { confirm?: boolean; note?: string; retry?: boolean } = {}) =>
    request<{
      published: boolean;
      release: AgileRelease;
      stories?: Array<{ storyId: string; title: string; status: StoryStatus; reason?: string; runState?: string | null }>;
      deploy?: ReleaseDeployRecord | null;
    }>(`/api/agile/releases/${encodeURIComponent(id)}/publish`, { method: "POST", body: JSON.stringify(body) }),
  /** Sprint 4: read-only sprint metrics + project rollup. */
  agileMetrics: (params: { projectId?: string; sprintId?: string } = {}) => {
    const search = new URLSearchParams();
    if (params.projectId) search.set("projectId", params.projectId);
    if (params.sprintId) search.set("sprintId", params.sprintId);
    const suffix = search.toString();
    return request<AgileMetricsResponse>(`/api/agile/metrics${suffix ? `?${suffix}` : ""}`);
  },
  /** Sprint 4 core: owner-scoped release summary (per-story outcomes + totals). */
  releaseSummary: (id: string) => request<ReleaseSummary>(`/api/agile/releases/${encodeURIComponent(id)}/summary`),
  /** Sprint 4 core: owner-scoped release retrospective dataset. */
  releaseRetrospective: (id: string) => request<ReleaseRetrospective>(`/api/agile/releases/${encodeURIComponent(id)}/retrospective`),
  // Sprint 4: owner-scoped saved model combinations ("模板").
  templates: () => request<{ templates: ModelTemplate[] }>("/api/templates"),
  createTemplate: (body: { name: string; developerModel: ModelSelection; reviewerModel: ModelSelection; budget?: ModelTemplate["budget"]; maxParallel?: number | null }) =>
    request<ModelTemplate>("/api/templates", { method: "POST", body: JSON.stringify(body) }),
  deleteTemplate: (id: string) => request<void>(`/api/templates/${id}`, { method: "DELETE" }),
  // 账户管理（仅管理员）: role/status + workspace grants.
  accounts: () => request<{ accounts: AccountSummary[] }>("/api/accounts"),
  account: (id: string) => request<AccountDetail>(`/api/accounts/${encodeURIComponent(id)}`),
  patchAccount: (id: string, body: { role?: "admin" | "user"; status?: "active" | "disabled" }) =>
    request<AccountDetail>(`/api/accounts/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) }),
  accountWorkspaces: () => request<{ workspaces: AccountWorkspaceOption[] }>("/api/accounts/workspaces"),
  addAccountGrant: (id: string, body: { workspaceId: string; permission: WorkspacePermission }) =>
    request<AccountDetail>(`/api/accounts/${encodeURIComponent(id)}/grants`, { method: "POST", body: JSON.stringify(body) }),
  removeAccountGrant: (id: string, workspaceId: string) =>
    request<AccountDetail>(`/api/accounts/${encodeURIComponent(id)}/grants/${encodeURIComponent(workspaceId)}`, { method: "DELETE" }),
};

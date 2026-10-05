import type { ConfigStatus, CredentialStatus, CurrentUser, ModelCatalogResponse, ModelSelection, Run, RunArtifact, RunEvent, RunRoundsResponse, RunState, Workspace } from "../shared/types";

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
  createRun: (body: { title: string; task: string; repository?: string; workspaceId?: string; mode: "demo" | "real"; checks?: string[]; developerModel?: ModelSelection; reviewerModel?: ModelSelection }) =>
    request<Run>("/api/runs", { method: "POST", body: JSON.stringify(body) }),
  cancelRun: (id: string) => request<Run>(`/api/runs/${id}/cancel`, { method: "POST" }),
  approveRun: (id: string, body: { mode?: "continue" | "accept"; note?: string; acknowledgeOpenFindings?: boolean; mergeIntoWorkspace?: boolean } = {}) =>
    request<Run>(`/api/runs/${id}/approve`, { method: "POST", body: JSON.stringify(body) }),
  rejectRun: (id: string, body: { reason?: string } = {}) =>
    request<Run>(`/api/runs/${id}/reject`, { method: "POST", body: JSON.stringify(body) }),
  cleanupRuns: (body: { runIds?: string[]; states?: Run["state"][]; olderThanDays?: number; scope?: "own" | "all"; dryRun?: boolean; deleteRunDirectory?: boolean } = {}) =>
    request<{ dryRun: boolean; deleteRunDirectory?: boolean; deleted?: number; runIds: string[]; matched: number }>("/api/runs/cleanup", { method: "POST", body: JSON.stringify(body) }),
  resumeRun: (id: string, body: { instruction?: string }) =>
    request<Run>(`/api/runs/${id}/resume`, { method: "POST", body: JSON.stringify(body) }),
  retryReviewRun: (id: string) => request<Run>(`/api/runs/${id}/retry-review`, { method: "POST" }),
  deleteRun: (id: string) => request<void>(`/api/runs/${id}`, { method: "DELETE" }),
};

import type { ConfigStatus, CredentialStatus, CurrentUser, ModelCatalogResponse, ModelSelection, Run, RunArtifact, RunEvent, RunState, Workspace } from "../shared/types";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as { error?: string; code?: string };
    const failure = new Error(error.error || `Request failed: ${response.status}`) as Error & { code?: string; status?: number };
    failure.code = error.code;
    failure.status = response.status;
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
  artifacts: (id: string) => request<{ artifacts: RunArtifact[] }>(`/api/runs/${id}/artifacts`),
  artifactDownloadUrl: (id: string, artifactId: string) => `/api/runs/${id}/artifacts/${encodeURIComponent(artifactId)}/download`,
  createRun: (body: { title: string; task: string; repository?: string; workspaceId?: string; mode: "demo" | "real"; checks?: string[]; developerModel?: ModelSelection; reviewerModel?: ModelSelection }) =>
    request<Run>("/api/runs", { method: "POST", body: JSON.stringify(body) }),
  cancelRun: (id: string) => request<Run>(`/api/runs/${id}/cancel`, { method: "POST" }),
  approveRun: (id: string, body: { mode?: "continue" | "accept"; note?: string; acknowledgeOpenFindings?: boolean } = {}) =>
    request<Run>(`/api/runs/${id}/approve`, { method: "POST", body: JSON.stringify(body) }),
  rejectRun: (id: string, body: { reason?: string } = {}) =>
    request<Run>(`/api/runs/${id}/reject`, { method: "POST", body: JSON.stringify(body) }),
  cleanupRuns: (body: { runIds?: string[]; states?: Run["state"][]; olderThanDays?: number; scope?: "own" | "all"; dryRun?: boolean } = {}) =>
    request<{ dryRun: boolean; deleted?: number; runIds: string[]; matched: number }>("/api/runs/cleanup", { method: "POST", body: JSON.stringify(body) }),
  resumeRun: (id: string, body: { instruction?: string }) =>
    request<Run>(`/api/runs/${id}/resume`, { method: "POST", body: JSON.stringify(body) }),
  retryReviewRun: (id: string) => request<Run>(`/api/runs/${id}/retry-review`, { method: "POST" }),
  deleteRun: (id: string) => request<void>(`/api/runs/${id}`, { method: "DELETE" }),
};

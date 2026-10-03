import type { ConfigStatus, ProjectInfo, Run, RunEvent } from "../shared/types";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(error.error || `Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export const api = {
  config: () => request<ConfigStatus>("/api/config/status"),
  projects: () => request<ProjectInfo[]>("/api/projects"),
  runs: () => request<Run[]>("/api/runs"),
  run: (id: string) => request<Run>(`/api/runs/${id}`),
  events: (id: string) => request<RunEvent[]>(`/api/runs/${id}/events`),
  createRun: (body: { title: string; task: string; repository: string; mode: "demo" | "real"; checks?: string[] }) =>
    request<Run>("/api/runs", { method: "POST", body: JSON.stringify(body) }),
  cancelRun: (id: string) => request<Run>(`/api/runs/${id}/cancel`, { method: "POST" }),
};

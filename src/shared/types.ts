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

export interface Finding {
  id: string;
  severity: "critical" | "high" | "medium" | "low";
  file: string | null;
  line: number | null;
  title: string;
  evidence: string;
  requiredChange: string;
  resolved: boolean;
}

export interface CheckResult {
  id: string;
  name: string;
  command: string;
  status: "pending" | "running" | "passed" | "failed";
  durationMs?: number;
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

export interface Run {
  id: string;
  title: string;
  task: string;
  repository: string;
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
  usage: { inputTokens: number; outputTokens: number; estimatedCost: number };
  durationMs: number;
  lastSeq: number;
  worktree?: string;
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
  mode: RunMode;
  checks?: string[];
}

export interface ConfigStatus {
  demoMode: boolean;
  piVersion: string;
  developer: { provider: string; model: string; credentialConfigured: boolean };
  reviewer: { provider: string; model: string; credentialConfigured: boolean };
  realRunsAvailable: boolean;
}

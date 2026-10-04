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
}

export interface ConfigStatus {
  demoMode: boolean;
  piVersion: string;
  developer: { provider: string; model: string; credentialConfigured: boolean };
  reviewer: { provider: string; model: string; credentialConfigured: boolean };
  realRunsAvailable: boolean;
}

export interface CurrentUser {
  id: string;
  email: string;
  legacyOwnerId?: string;
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
  }>;
}

export type ModelRole = "developer" | "reviewer";

export interface ModelCatalogEntry {
  id: string;
  provider: string;
  model: string;
  label: string;
  contextWindow?: number;
  toolCalling: boolean;
  reasoning: boolean;
  roles: ModelRole[];
  status: "available" | "preview" | "deprecated";
}

export interface ModelInfo extends ModelCatalogEntry {
  available: boolean;
  unavailableReason: "credential_missing" | "role_restricted" | null;
}

export interface ModelSelection {
  provider: string;
  model: string;
}

export interface ModelCatalogResponse {
  models: ModelInfo[];
  defaultDeveloper: ModelSelection;
  defaultReviewer: ModelSelection;
}

export type WorkspaceStatus = "active" | "unregistered" | "invalid";

export interface WorkspaceGitInfo {
  branch: string | null;
  head: string | null;
  dirty: boolean;
  dirtyFiles: string[];
}

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

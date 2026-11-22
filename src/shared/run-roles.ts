import type {
  AgentProfileRole,
  ModelCredentials,
  ModelSelection,
  Run,
  RunAgentProfile,
} from "./types.js";

/** Stable order used by admission, validation, cleanup and serialization. */
export const TEAM_AGENT_ROLES: readonly AgentProfileRole[] = [
  "planner", "developer", "integrator", "reviewer", "custom",
];

/** Pinned selection for a role, with legacy planner/integrator fallback. */
export function runModelForRole(run: Run, role: AgentProfileRole): ModelSelection {
  const pinned = run.agents?.[role];
  if (pinned) return { provider: pinned.provider, model: pinned.model };
  return role === "reviewer" ? run.reviewer : run.developer;
}

/** Roles whose provider keys must be present before a run may enter the queue. */
export function requiredCredentialRoles(run: Run): AgentProfileRole[] {
  if (!run.agents) return ["developer", "reviewer"];
  const roles = TEAM_AGENT_ROLES.filter((role) => Boolean(run.agents?.[role]));
  for (const required of ["developer", "reviewer"] as const) {
    if (!roles.includes(required)) roles.push(required);
  }
  return roles;
}

export type RunCredentialResolution =
  | { ok: true; credentials: ModelCredentials }
  | { ok: false; role: AgentProfileRole; provider: string };

/** Resolve only the keys required by the run's immutable role snapshot. */
export function resolveRunCredentials(
  run: Run,
  readProviderKey: (provider: string) => string | undefined,
): RunCredentialResolution {
  const projected: Partial<Record<AgentProfileRole, string>> = {};
  for (const role of requiredCredentialRoles(run)) {
    const provider = runModelForRole(run, role).provider;
    const key = readProviderKey(provider);
    if (!key) return { ok: false, role, provider };
    projected[role] = key;
  }
  return { ok: true, credentials: projected as ModelCredentials };
}

export function clearModelCredentials(credentials: ModelCredentials): void {
  for (const role of TEAM_AGENT_ROLES) {
    if (role in credentials) credentials[role] = "";
  }
}

export function hasRequiredCredentials(run: Run, credentials: Partial<ModelCredentials> | undefined): credentials is ModelCredentials {
  return Boolean(credentials) && requiredCredentialRoles(run).every((role) => Boolean(credentials?.[role]));
}

/** Exact key for a role; a pinned Team role never falls back to another key. */
export function credentialForRole(run: Run, credentials: ModelCredentials, role: AgentProfileRole): string {
  const exact = credentials[role];
  if (exact) return exact;
  if (run.agents?.[role]) throw new Error(`Credential unavailable for pinned role ${role}`);
  return role === "reviewer" ? credentials.reviewer : credentials.developer;
}

export function isRunAgentProfile(value: unknown): value is RunAgentProfile {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<RunAgentProfile>;
  return typeof item.id === "string" && typeof item.name === "string"
    && TEAM_AGENT_ROLES.includes(item.role as AgentProfileRole)
    && typeof item.provider === "string" && typeof item.model === "string";
}

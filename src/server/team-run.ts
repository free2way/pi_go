import type {
  AgentProfileRole,
  AgentTeam,
  RunAgentProfile,
} from "../shared/types.js";
import { TEAM_AGENT_ROLES } from "../shared/run-roles.js";

export class TeamRunError extends Error {
  constructor(
    readonly code: "TEAM_ROLE_REQUIRED" | "TEAM_ROLE_AMBIGUOUS",
    message: string,
  ) {
    super(message);
    this.name = "TeamRunError";
  }
}

/** Freeze mutable Team members into the Run document before queue admission. */
export function snapshotTeamAgents(team: AgentTeam): Partial<Record<AgentProfileRole, RunAgentProfile>> {
  const agents: Partial<Record<AgentProfileRole, RunAgentProfile>> = {};
  for (const profile of team.profiles) {
    if (!TEAM_AGENT_ROLES.includes(profile.role)) continue;
    if (agents[profile.role]) {
      throw new TeamRunError("TEAM_ROLE_AMBIGUOUS", `Team role ${profile.role} must have exactly one Agent Profile`);
    }
    agents[profile.role] = {
      id: profile.id,
      name: profile.name,
      role: profile.role,
      provider: profile.provider,
      model: profile.model,
    };
  }
  for (const role of ["developer", "reviewer"] as const) {
    if (!agents[role]) throw new TeamRunError("TEAM_ROLE_REQUIRED", `Team requires a ${role} Agent Profile`);
  }
  return agents;
}

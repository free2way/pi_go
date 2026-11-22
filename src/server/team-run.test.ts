import { describe, expect, it } from "vitest";
import type { AgentProfile, AgentTeam } from "../shared/types.js";
import { snapshotTeamAgents, TeamRunError } from "./team-run.js";

const profile = (id: string, role: AgentProfile["role"]): AgentProfile => ({
  id, ownerId: "owner", name: role, role, provider: `${role}-provider`, model: `${role}-model`,
  createdAt: "2026-11-22T00:00:00.000Z", updatedAt: "2026-11-22T00:00:00.000Z",
});
const team = (profiles: AgentProfile[]): AgentTeam => ({
  id: "team", ownerId: "owner", name: "Team", profiles,
  createdAt: "2026-11-22T00:00:00.000Z", updatedAt: "2026-11-22T00:00:00.000Z",
});

describe("Team run snapshot", () => {
  it("freezes the ordered Team into a role-indexed run snapshot", () => {
    expect(snapshotTeamAgents(team([profile("p", "planner"), profile("d", "developer"), profile("r", "reviewer")]))).toEqual({
      planner: { id: "p", name: "planner", role: "planner", provider: "planner-provider", model: "planner-model" },
      developer: { id: "d", name: "developer", role: "developer", provider: "developer-provider", model: "developer-model" },
      reviewer: { id: "r", name: "reviewer", role: "reviewer", provider: "reviewer-provider", model: "reviewer-model" },
    });
  });

  it("rejects an incomplete or ambiguous execution Team", () => {
    expect(() => snapshotTeamAgents(team([profile("r", "reviewer")]))).toThrowError(TeamRunError);
    expect(() => snapshotTeamAgents(team([profile("d1", "developer"), profile("d2", "developer"), profile("r", "reviewer")]))).toThrowError(TeamRunError);
  });
});

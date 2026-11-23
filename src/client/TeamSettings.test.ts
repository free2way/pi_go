import { describe, expect, it } from "vitest";
import type { AgentProfile, AgentProfileRole } from "../shared/types.js";
import { teamProfileIssue } from "./TeamSettings.js";

function profile(id: string, role: AgentProfileRole): AgentProfile {
  return {
    id,
    ownerId: "owner",
    name: `${role}-${id}`,
    role,
    provider: "fixture",
    model: `fixture-${role}`,
    createdAt: "2026-11-22T00:00:00.000Z",
    updatedAt: "2026-11-22T00:00:00.000Z",
  };
}

describe("Team settings validation", () => {
  it("requires developer and reviewer without duplicate roles", () => {
    expect(teamProfileIssue([profile("d", "developer")])).toBe("missing");
    expect(teamProfileIssue([
      profile("d1", "developer"),
      profile("d2", "developer"),
      profile("r", "reviewer"),
    ])).toBe("duplicate");
    expect(teamProfileIssue([
      profile("p", "planner"),
      profile("d", "developer"),
      profile("i", "integrator"),
      profile("r", "reviewer"),
    ])).toBeUndefined();
  });
});

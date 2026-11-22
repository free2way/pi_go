import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { AgentProfileRole } from "../../shared/types.js";
import { AgentTeamService } from "../agent-teams.js";
import type { Db } from "../db.js";
import { createTestDb } from "../test-db.js";
import { registerAgentTeamRoutes } from "./agent-teams.js";

async function routeApp() {
  const db = await createTestDb();
  const teams = new AgentTeamService(db);
  const app = Fastify();
  registerAgentTeamRoutes(app, {
    currentUser: (request) => ({
      id: String(request.headers["x-user"] ?? "owner-a"),
      email: String(request.headers["x-email"] ?? ""),
    }),
    teams,
  });
  return { app, db, teams };
}

const profile = (name: string, role: AgentProfileRole = "developer") => ({
  name,
  role,
  provider: "fixture-provider",
  model: `fixture-${role}`,
});

describe("agent profile and team routes", () => {
  it("maps a concurrent unique-name race to the stable 409 contract", async () => {
    const conflict = Object.assign(new Error("synthetic concurrent insert"), { code: "23505" });
    const db: Db = {
      query: async (sql) => {
        if (sql.startsWith("SELECT id FROM agent_profiles")) return { rows: [] };
        if (sql.startsWith("INSERT INTO agent_profiles")) throw conflict;
        return { rows: [] };
      },
      withTransaction: async (fn) => fn(db),
    };
    await expect(new AgentTeamService(db).createProfile("owner-a", profile("Race")))
      .rejects.toMatchObject({ code: "NAME_IN_USE", status: 409 });
  });

  it("creates, updates, lists and deletes owner-scoped profiles and teams", async () => {
    const { app } = await routeApp();
    const developer = await app.inject({
      method: "POST",
      url: "/api/agent-profiles",
      headers: { "x-user": "owner-a" },
      payload: profile("Developer"),
    });
    const reviewer = await app.inject({
      method: "POST",
      url: "/api/agent-profiles",
      headers: { "x-user": "owner-a" },
      payload: profile("Reviewer", "reviewer"),
    });
    expect(developer.statusCode).toBe(201);
    expect(reviewer.statusCode).toBe(201);

    const developerId = developer.json().id as string;
    const reviewerId = reviewer.json().id as string;
    const created = await app.inject({
      method: "POST",
      url: "/api/teams",
      headers: { "x-user": "owner-a" },
      payload: { name: "Delivery team", profileIds: [developerId, reviewerId] },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      ownerId: "owner-a",
      name: "Delivery team",
      profiles: [
        { id: developerId, role: "developer" },
        { id: reviewerId, role: "reviewer" },
      ],
    });

    const teamId = created.json().id as string;
    const updatedProfile = await app.inject({
      method: "PUT",
      url: `/api/agent-profiles/${developerId}`,
      headers: { "x-user": "owner-a" },
      payload: { ...profile("Lead developer"), model: "fixture-developer-v2" },
    });
    expect(updatedProfile.statusCode).toBe(200);
    expect(updatedProfile.json()).toMatchObject({ name: "Lead developer", model: "fixture-developer-v2" });

    const listed = await app.inject({ method: "GET", url: "/api/teams", headers: { "x-user": "owner-a" } });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().teams).toHaveLength(1);
    expect(listed.json().teams[0].profiles[0].name).toBe("Lead developer");

    const inUse = await app.inject({
      method: "DELETE",
      url: `/api/agent-profiles/${developerId}`,
      headers: { "x-user": "owner-a" },
    });
    expect(inUse.statusCode).toBe(409);
    expect(inUse.json().code).toBe("PROFILE_IN_USE");

    const updatedTeam = await app.inject({
      method: "PUT",
      url: `/api/teams/${teamId}`,
      headers: { "x-user": "owner-a" },
      payload: { name: "Review only", profileIds: [reviewerId] },
    });
    expect(updatedTeam.statusCode).toBe(200);
    expect(updatedTeam.json()).toMatchObject({ name: "Review only", profiles: [{ id: reviewerId }] });

    expect((await app.inject({
      method: "DELETE",
      url: `/api/agent-profiles/${developerId}`,
      headers: { "x-user": "owner-a" },
    })).statusCode).toBe(204);
    expect((await app.inject({
      method: "DELETE",
      url: `/api/teams/${teamId}`,
      headers: { "x-user": "owner-a" },
    })).statusCode).toBe(204);
    expect((await app.inject({
      method: "DELETE",
      url: `/api/agent-profiles/${reviewerId}`,
      headers: { "x-user": "owner-a" },
    })).statusCode).toBe(204);
  });

  it("returns 404 for every cross-owner read, mutation and reference", async () => {
    const { app } = await routeApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/agent-profiles",
      headers: { "x-user": "owner-a" },
      payload: profile("Private profile"),
    });
    const profileId = created.json().id as string;
    const team = await app.inject({
      method: "POST",
      url: "/api/teams",
      headers: { "x-user": "owner-a" },
      payload: { name: "Private team", profileIds: [profileId] },
    });
    const teamId = team.json().id as string;

    for (const request of [
      { method: "GET", url: `/api/agent-profiles/${profileId}` },
      { method: "PUT", url: `/api/agent-profiles/${profileId}`, payload: profile("Stolen") },
      { method: "DELETE", url: `/api/agent-profiles/${profileId}` },
      { method: "GET", url: `/api/teams/${teamId}` },
      { method: "PUT", url: `/api/teams/${teamId}`, payload: { name: "Stolen", profileIds: [profileId] } },
      { method: "DELETE", url: `/api/teams/${teamId}` },
    ] as const) {
      const response = await app.inject({ ...request, headers: { "x-user": "owner-b" } });
      expect(response.statusCode).toBe(404);
    }

    const reference = await app.inject({
      method: "POST",
      url: "/api/teams",
      headers: { "x-user": "owner-b" },
      payload: { name: "Probe", profileIds: [profileId] },
    });
    expect(reference.statusCode).toBe(404);
    expect(reference.json()).toEqual({ error: "Agent profile not found", code: "PROFILE_NOT_FOUND" });
    expect((await app.inject({ method: "GET", url: "/api/teams", headers: { "x-user": "owner-b" } })).json()).toEqual({ teams: [] });
  });

  it("rejects malformed, duplicate and conflicting inputs without partial rows", async () => {
    const { app, db } = await routeApp();
    const invalid = await app.inject({
      method: "POST",
      url: "/api/agent-profiles",
      payload: { ...profile("Invalid"), role: "root" },
    });
    expect(invalid.statusCode).toBe(400);

    const created = await app.inject({ method: "POST", url: "/api/agent-profiles", payload: profile("Unique") });
    const duplicateName = await app.inject({ method: "POST", url: "/api/agent-profiles", payload: profile("Unique", "reviewer") });
    expect(duplicateName.statusCode).toBe(409);
    expect(duplicateName.json().code).toBe("NAME_IN_USE");

    const profileId = created.json().id as string;
    const duplicateMember = await app.inject({
      method: "POST",
      url: "/api/teams",
      payload: { name: "Invalid team", profileIds: [profileId, profileId] },
    });
    expect(duplicateMember.statusCode).toBe(400);
    expect(duplicateMember.json().code).toBe("INVALID_TEAM");
    expect(Number((await db.query("SELECT COUNT(*) AS total FROM agent_teams")).rows[0].total)).toBe(0);
  });
});

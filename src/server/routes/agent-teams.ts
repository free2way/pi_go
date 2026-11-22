import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { CurrentUser } from "../../shared/types.js";
import { AgentTeamError, type AgentTeamService } from "../agent-teams.js";

const profileRole = z.enum(["planner", "developer", "integrator", "reviewer", "custom"]);
const profileInput = z.object({
  name: z.string().trim().min(1).max(80),
  role: profileRole,
  provider: z.string().trim().min(1).max(80),
  model: z.string().trim().min(1).max(160),
}).strict();
const teamInput = z.object({
  name: z.string().trim().min(1).max(80),
  profileIds: z.array(z.string().trim().min(1).max(80)).min(1).max(32),
}).strict();

export interface AgentTeamRouteDependencies {
  currentUser: (request: FastifyRequest) => CurrentUser;
  teams: AgentTeamService;
}

function agentTeamError(reply: FastifyReply, error: unknown) {
  if (error instanceof AgentTeamError) {
    return reply.code(error.status).send({ error: error.message, code: error.code });
  }
  throw error;
}

/** Owner-scoped AgentProfile and Team CRUD. Cross-owner lookups are always 404. */
export function registerAgentTeamRoutes(app: FastifyInstance, deps: AgentTeamRouteDependencies) {
  app.get("/api/agent-profiles", async (request) => ({
    profiles: await deps.teams.listProfiles(deps.currentUser(request).id),
  }));

  app.post("/api/agent-profiles", async (request, reply) => {
    const parsed = profileInput.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid agent profile", code: "INVALID_AGENT_PROFILE", details: parsed.error.issues });
    try {
      return reply.code(201).send(await deps.teams.createProfile(deps.currentUser(request).id, parsed.data));
    } catch (error) {
      return agentTeamError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/agent-profiles/:id", async (request, reply) => {
    try {
      return await deps.teams.getProfile(deps.currentUser(request).id, request.params.id);
    } catch (error) {
      return agentTeamError(reply, error);
    }
  });

  app.put<{ Params: { id: string } }>("/api/agent-profiles/:id", async (request, reply) => {
    const parsed = profileInput.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid agent profile", code: "INVALID_AGENT_PROFILE", details: parsed.error.issues });
    try {
      return await deps.teams.updateProfile(deps.currentUser(request).id, request.params.id, parsed.data);
    } catch (error) {
      return agentTeamError(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/agent-profiles/:id", async (request, reply) => {
    try {
      await deps.teams.deleteProfile(deps.currentUser(request).id, request.params.id);
      return reply.code(204).send();
    } catch (error) {
      return agentTeamError(reply, error);
    }
  });

  app.get("/api/teams", async (request) => ({
    teams: await deps.teams.listTeams(deps.currentUser(request).id),
  }));

  app.post("/api/teams", async (request, reply) => {
    const parsed = teamInput.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid agent team", code: "INVALID_TEAM", details: parsed.error.issues });
    try {
      return reply.code(201).send(await deps.teams.createTeam(deps.currentUser(request).id, parsed.data));
    } catch (error) {
      return agentTeamError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/teams/:id", async (request, reply) => {
    try {
      return await deps.teams.getTeam(deps.currentUser(request).id, request.params.id);
    } catch (error) {
      return agentTeamError(reply, error);
    }
  });

  app.put<{ Params: { id: string } }>("/api/teams/:id", async (request, reply) => {
    const parsed = teamInput.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid agent team", code: "INVALID_TEAM", details: parsed.error.issues });
    try {
      return await deps.teams.updateTeam(deps.currentUser(request).id, request.params.id, parsed.data);
    } catch (error) {
      return agentTeamError(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/teams/:id", async (request, reply) => {
    try {
      await deps.teams.deleteTeam(deps.currentUser(request).id, request.params.id);
      return reply.code(204).send();
    } catch (error) {
      return agentTeamError(reply, error);
    }
  });
}

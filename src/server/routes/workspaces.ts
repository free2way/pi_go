import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { CurrentUser } from "../../shared/types.js";
import type { RateLimiter } from "../rate-limit.js";
import { serverDiagnosticMessage } from "../server-diagnostics.js";
import type { WorkerCall, WorkspaceService } from "../workspaces.js";

const workspaceRegisterSchema = z.object({ relativePath: z.string().trim().min(1).max(240) });
const workspaceCloneSchema = z.object({ url: z.string().trim().min(1).max(500), name: z.string().trim().min(1).max(80) });
const workspaceCreateSchema = z.object({ name: z.string().trim().min(1).max(80) });
const workspacePatchSchema = z.object({
  defaultChecks: z.array(z.string().trim().min(1).max(500)).max(8).optional(),
  defaultBranch: z.string().trim().min(1).max(200).optional(),
}).strict();
const workspaceScmSettingsSchema = z.object({
  provider: z.enum(["github", "gitlab", "generic"]),
  authMode: z.enum(["https_token", "server_ssh"]),
  username: z.string().trim().min(1).max(120).nullable().optional(),
  token: z.string().trim().min(8).max(2_000).nullable().optional(),
}).strict();
const workspacePushSchema = z.object({ confirm: z.literal(true) }).strict();

function workspacesDisabled(reply: FastifyReply) {
  return reply.code(503).send({ error: "Workspaces are disabled", code: "WORKSPACES_DISABLED" });
}

type WorkspaceRoutes = Pick<WorkspaceService,
  "list" | "register" | "clone" | "create" | "get" | "refresh" | "scmOverview" |
  "remoteStatus" | "saveScmSettings" | "deleteScmSettings" | "push" | "patch" | "unregister"
>;

export interface WorkspaceRouteDependencies {
  currentUser: (request: FastifyRequest) => CurrentUser;
  ownerKeysFor: (request: FastifyRequest) => string[];
  isAdmin: (userId: string) => Promise<boolean>;
  workspaces: WorkspaceRoutes;
  workerRequest: WorkerCall;
  realRunsEnabled: boolean;
  workspacesEnabled: boolean;
  runActions: Pick<RateLimiter, "check">;
  tooManyRequests: (reply: FastifyReply, retryAfterMs: number) => FastifyReply;
  workspaceErrorReply: (reply: FastifyReply, error: unknown) => FastifyReply;
}

export function registerWorkspaceRoutes(app: FastifyInstance, deps: WorkspaceRouteDependencies) {
  const {
    currentUser, ownerKeysFor, isAdmin, workspaces, workerRequest, realRunsEnabled,
    workspacesEnabled, runActions, tooManyRequests, workspaceErrorReply,
  } = deps;

  app.get("/api/projects", async (request, reply) => {
    // AUD-02: the legacy global project listing is owner scoped (admins see all).
    const admin = await isAdmin(currentUser(request).id);
    if (!realRunsEnabled) return reply.code(503).send({ error: "Real runs are disabled" });
    try {
      const projects = await workerRequest<Array<{ relativePath: string }>>("/projects");
      if (admin) return projects;
      const allowed = new Set((await workspaces.list(ownerKeysFor(request))).map((item) => item.rootPath));
      return projects.filter((project) => allowed.has(project.relativePath) || allowed.has(project.relativePath.replace(/^\/+/, "")));
    } catch (error) {
      return reply.code(503).send({ error: `Worker unavailable: ${serverDiagnosticMessage(error)}` });
    }
  });

  app.get("/api/workspaces", async (request, reply) => {
    if (!workspacesEnabled) return workspacesDisabled(reply);
    return { workspaces: await workspaces.list(ownerKeysFor(request)) };
  });

  app.post("/api/workspaces/register", async (request, reply) => {
    if (!workspacesEnabled) return workspacesDisabled(reply);
    const parsed = workspaceRegisterSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
    try {
      // AUD-02: only the owner (or an admin) may claim a physical repository path.
      const admin = await isAdmin(currentUser(request).id);
      return reply.code(201).send(await workspaces.register(currentUser(request).id, parsed.data.relativePath, { isAdmin: admin }));
    } catch (error) {
      return workspaceErrorReply(reply, error);
    }
  });

  app.post("/api/workspaces/clone", async (request, reply) => {
    if (!workspacesEnabled) return workspacesDisabled(reply);
    const parsed = workspaceCloneSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
    try {
      return reply.code(201).send(await workspaces.clone(currentUser(request).id, parsed.data.url, parsed.data.name));
    } catch (error) {
      return workspaceErrorReply(reply, error);
    }
  });

  // Creates the directory on the worker host (under its projects root) and then
  // registers it, so an operator never has to shell into the worker container.
  app.post("/api/workspaces/create", async (request, reply) => {
    if (!workspacesEnabled) return workspacesDisabled(reply);
    const parsed = workspaceCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
    try {
      return reply.code(201).send(await workspaces.create(currentUser(request).id, parsed.data.name));
    } catch (error) {
      return workspaceErrorReply(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/workspaces/:id", async (request, reply) => {
    if (!workspacesEnabled) return workspacesDisabled(reply);
    try {
      return await workspaces.get(ownerKeysFor(request), request.params.id, { isAdmin: await isAdmin(currentUser(request).id) });
    } catch (error) {
      return workspaceErrorReply(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/workspaces/:id/refresh", async (request, reply) => {
    if (!workspacesEnabled) return workspacesDisabled(reply);
    try {
      // B4: refreshing git metadata mutates stored state, so a read grant is refused.
      return await workspaces.refresh(ownerKeysFor(request), request.params.id, { isAdmin: await isAdmin(currentUser(request).id) });
    } catch (error) {
      return workspaceErrorReply(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/workspaces/:id/scm", async (request, reply) => {
    if (!workspacesEnabled) return workspacesDisabled(reply);
    try {
      return await workspaces.scmOverview(ownerKeysFor(request), request.params.id, { isAdmin: await isAdmin(currentUser(request).id) });
    } catch (error) {
      return workspaceErrorReply(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/workspaces/:id/scm/check", async (request, reply) => {
    if (!workspacesEnabled) return workspacesDisabled(reply);
    try {
      return await workspaces.remoteStatus(ownerKeysFor(request), request.params.id, { isAdmin: await isAdmin(currentUser(request).id) });
    } catch (error) {
      return workspaceErrorReply(reply, error);
    }
  });

  app.put<{ Params: { id: string } }>("/api/workspaces/:id/scm", async (request, reply) => {
    if (!workspacesEnabled) return workspacesDisabled(reply);
    const user = currentUser(request);
    if (!(await isAdmin(user.id))) return reply.code(403).send({ error: "仅管理员可以配置代码仓库凭据", code: "ADMIN_REQUIRED" });
    const parsed = workspaceScmSettingsSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
    try {
      return await workspaces.saveScmSettings(ownerKeysFor(request), request.params.id, parsed.data, { isAdmin: true });
    } catch (error) {
      return workspaceErrorReply(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/workspaces/:id/scm", async (request, reply) => {
    if (!workspacesEnabled) return workspacesDisabled(reply);
    const user = currentUser(request);
    if (!(await isAdmin(user.id))) return reply.code(403).send({ error: "仅管理员可以删除代码仓库凭据", code: "ADMIN_REQUIRED" });
    try {
      return await workspaces.deleteScmSettings(ownerKeysFor(request), request.params.id, { isAdmin: true });
    } catch (error) {
      return workspaceErrorReply(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/workspaces/:id/scm/push", async (request, reply) => {
    if (!workspacesEnabled) return workspacesDisabled(reply);
    const actionLimit = runActions.check(currentUser(request).id);
    if (!actionLimit.allowed) return tooManyRequests(reply, actionLimit.retryAfterMs);
    const parsed = workspacePushSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "推送需要 confirm=true", code: "SCM_PUSH_CONFIRM_REQUIRED", details: parsed.error.issues });
    const user = currentUser(request);
    if (!(await isAdmin(user.id))) return reply.code(403).send({ error: "仅管理员可以推送代码到远程仓库", code: "ADMIN_REQUIRED" });
    try {
      return await workspaces.push(ownerKeysFor(request), request.params.id, user.id, { isAdmin: true });
    } catch (error) {
      return workspaceErrorReply(reply, error);
    }
  });

  app.patch<{ Params: { id: string } }>("/api/workspaces/:id", async (request, reply) => {
    if (!workspacesEnabled) return workspacesDisabled(reply);
    const parsed = workspacePatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
    try {
      return await workspaces.patch(ownerKeysFor(request), request.params.id, parsed.data, { isAdmin: await isAdmin(currentUser(request).id) });
    } catch (error) {
      return workspaceErrorReply(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/workspaces/:id", async (request, reply) => {
    if (!workspacesEnabled) return workspacesDisabled(reply);
    try {
      // B4: only the owner, an admin or a write grant may unregister.
      await workspaces.unregister(ownerKeysFor(request), request.params.id, { isAdmin: await isAdmin(currentUser(request).id) });
      return reply.code(204).send();
    } catch (error) {
      return workspaceErrorReply(reply, error);
    }
  });
}

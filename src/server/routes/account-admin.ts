import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { CurrentUser } from "../../shared/types.js";
import { AccountError, AccountService, accountAdminGate } from "../accounts.js";
import type { RateLimiter } from "../rate-limit.js";
import type { ReleaseSettingsStore } from "../release-settings.js";

const accountPatchSchema = z.object({
  role: z.enum(["admin", "user"]).optional(),
  status: z.enum(["active", "disabled"]).optional(),
}).strict().refine((value) => value.role !== undefined || value.status !== undefined, { message: "至少需要提供 role 或 status" });

const accountGrantSchema = z.object({
  workspaceId: z.string().trim().min(1).max(120),
  permission: z.enum(["read", "write"]),
}).strict();

const secureUrlSchema = z.string().trim().url().max(2_048).refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password;
}, "必须是未包含用户名或密码的 HTTPS URL");

const releaseSettingsSchema = z.object({
  webhookUrl: secureUrlSchema,
  webhookToken: z.string().trim().min(12).max(1_024).optional(),
  publicOrigin: secureUrlSchema,
}).strict();

type AccountRoutes = Pick<AccountService, "list" | "listWorkspaces" | "get" | "update" | "setGrant" | "removeGrant">;
type ReleaseSettingsRoutes = Pick<ReleaseSettingsStore, "get" | "set" | "delete">;

export interface AccountAdminRouteDependencies {
  currentUser: (request: FastifyRequest) => CurrentUser;
  isAdmin: (userId: string) => Promise<boolean>;
  accounts: AccountRoutes;
  releaseSettings: ReleaseSettingsRoutes;
  releaseSettingsProjection: () => unknown;
  credentialWrites: Pick<RateLimiter, "check">;
}

function tooManyRequests(reply: FastifyReply, retryAfterMs: number) {
  reply.header("Retry-After", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
  return reply.code(429).send({ error: "请求过于频繁，请稍后再试", code: "RATE_LIMITED" });
}

function accountErrorReply(reply: FastifyReply, error: unknown) {
  if (error instanceof AccountError) return reply.code(error.status).send({ error: error.message, code: error.code });
  throw error;
}

/** Account administration and release callback settings share one admin gate. */
export function registerAccountAdminRoutes(app: FastifyInstance, deps: AccountAdminRouteDependencies) {
  const { accounts, credentialWrites, releaseSettings, releaseSettingsProjection } = deps;

  async function requireAccountAdmin(request: FastifyRequest, reply: FastifyReply) {
    const user = deps.currentUser(request);
    const gate = accountAdminGate(await deps.isAdmin(user.id));
    if (!gate.allowed) {
      reply.code(gate.status).send({ error: gate.message, code: gate.code });
      return undefined;
    }
    return user;
  }

  app.get("/api/admin/release-settings", async (request, reply) => {
    if (!(await requireAccountAdmin(request, reply))) return reply;
    return releaseSettingsProjection();
  });

  app.put("/api/admin/release-settings", async (request, reply) => {
    const actor = await requireAccountAdmin(request, reply);
    if (!actor) return reply;
    const limit = credentialWrites.check(`release-settings:${actor.id}`);
    if (!limit.allowed) return tooManyRequests(reply, limit.retryAfterMs);
    const parsed = releaseSettingsSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
    if (!parsed.data.webhookToken && !releaseSettings.get()?.webhookToken) {
      return reply.code(400).send({ error: "首次配置必须填写 Webhook Token", code: "RELEASE_TOKEN_REQUIRED" });
    }
    await releaseSettings.set(parsed.data);
    return releaseSettingsProjection();
  });

  app.delete("/api/admin/release-settings", async (request, reply) => {
    const actor = await requireAccountAdmin(request, reply);
    if (!actor) return reply;
    const limit = credentialWrites.check(`release-settings:${actor.id}`);
    if (!limit.allowed) return tooManyRequests(reply, limit.retryAfterMs);
    await releaseSettings.delete();
    return releaseSettingsProjection();
  });

  app.get("/api/accounts", async (request, reply) => {
    if (!(await requireAccountAdmin(request, reply))) return reply;
    return { accounts: await accounts.list() };
  });

  // Registered before `/api/accounts/:id` so the static segment wins the match.
  app.get("/api/accounts/workspaces", async (request, reply) => {
    if (!(await requireAccountAdmin(request, reply))) return reply;
    return { workspaces: await accounts.listWorkspaces() };
  });

  app.get<{ Params: { id: string } }>("/api/accounts/:id", async (request, reply) => {
    if (!(await requireAccountAdmin(request, reply))) return reply;
    const account = await accounts.get(request.params.id);
    if (!account) return reply.code(404).send({ error: "账户不存在", code: "ACCOUNT_NOT_FOUND" });
    return account;
  });

  app.patch<{ Params: { id: string } }>("/api/accounts/:id", async (request, reply) => {
    const actor = await requireAccountAdmin(request, reply);
    if (!actor) return reply;
    const parsed = accountPatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
    try {
      return await accounts.update(request.params.id, parsed.data, actor.id);
    } catch (error) {
      return accountErrorReply(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/accounts/:id/grants", async (request, reply) => {
    const actor = await requireAccountAdmin(request, reply);
    if (!actor) return reply;
    const parsed = accountGrantSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
    try {
      return await accounts.setGrant(request.params.id, parsed.data, actor.id);
    } catch (error) {
      return accountErrorReply(reply, error);
    }
  });

  app.delete<{ Params: { id: string; workspaceId: string } }>("/api/accounts/:id/grants/:workspaceId", async (request, reply) => {
    const actor = await requireAccountAdmin(request, reply);
    if (!actor) return reply;
    try {
      return await accounts.removeGrant(request.params.id, request.params.workspaceId);
    } catch (error) {
      return accountErrorReply(reply, error);
    }
  });
}

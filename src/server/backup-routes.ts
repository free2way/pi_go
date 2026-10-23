import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { BackupError, type BackupManager } from "./backups.js";

export function registerBackupRoutes(app: FastifyInstance, options: {
  manager: BackupManager;
  admin: (request: FastifyRequest) => Promise<string | undefined>;
}) {
  const confirm = z.object({ confirm: z.literal(true) }).strict();
  const gate = async (request: FastifyRequest) => options.admin(request);
  app.get("/api/admin/backups", async (request, reply) => {
    if (!(await gate(request))) return reply.code(403).send({ code: "ADMIN_REQUIRED", error: "ADMIN_REQUIRED" });
    try { return await options.manager.overview(); } catch (error) { return failure(reply, error); }
  });
  app.post("/api/admin/backups", async (request, reply) => {
    const actor = await gate(request);
    if (!actor) return reply.code(403).send({ code: "ADMIN_REQUIRED", error: "ADMIN_REQUIRED" });
    if (!confirm.safeParse(request.body).success) return reply.code(400).send({ code: "CONFIRM_REQUIRED", error: "CONFIRM_REQUIRED" });
    try { return reply.code(202).send(await options.manager.create(actor)); } catch (error) { return failure(reply, error); }
  });
  for (const action of ["delete", "restore"] as const) app.post<{ Params: { id: string } }>(`/api/admin/backups/:id/${action}`, async (request, reply) => {
    const actor = await gate(request);
    if (!actor) return reply.code(403).send({ code: "ADMIN_REQUIRED", error: "ADMIN_REQUIRED" });
    if (!confirm.safeParse(request.body).success) return reply.code(400).send({ code: "CONFIRM_REQUIRED", error: "CONFIRM_REQUIRED" });
    try { await options.manager.changeState(request.params.id, action === "delete", actor); return { ok: true }; }
    catch (error) { return failure(reply, error); }
  });
}

function failure(reply: import("fastify").FastifyReply, error: unknown) {
  const code = error instanceof BackupError ? error.code : "BACKUP_UNAVAILABLE";
  return reply.code(error instanceof BackupError ? error.status : 503).send({ code, error: code });
}

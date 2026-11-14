import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Locale } from "../../shared/i18n.js";
import type { PiAssistantAnswer } from "../../shared/pi-assistant.js";
import type { RequirementRefinement } from "../../shared/requirement-assistant.js";
import type { CurrentUser, ModelCatalogEntry, ModelSelection, ProviderAvailability } from "../../shared/types.js";
import { validateModelSelection } from "../model-catalog.js";
import type { RateLimiter } from "../rate-limit.js";
import { serverDiagnosticMessage } from "../server-diagnostics.js";
import { runStateSchema } from "./internal/run-schemas.js";

const requirementRefineSchema = z.object({
  draft: z.string().trim().min(10).max(10_000),
  title: z.string().trim().max(200).optional(),
  context: z.object({
    source: z.enum(["run", "story"]).optional(),
    projectName: z.string().trim().max(120).optional(),
    workspaceName: z.string().trim().max(120).optional(),
  }).strict().optional(),
  model: z.object({
    provider: z.string().trim().min(1).max(80),
    model: z.string().trim().min(1).max(120),
  }).strict().optional(),
}).strict();

const piAssistantAskSchema = z.object({
  message: z.string().trim().min(1).max(2_000),
  context: z.object({
    page: z.enum(["run", "agile", "workspaces", "models", "history", "system", "release-settings", "accounts", "backups"]),
    run: z.object({
      id: z.string().trim().min(1).max(80),
      title: z.string().trim().max(200),
      state: runStateSchema,
      round: z.number().int().min(0).max(1_000),
      maxRounds: z.number().int().min(1).max(1_000),
      repository: z.string().trim().max(240),
      summary: z.string().trim().max(1_000),
      developer: z.object({ provider: z.string().trim().max(80), model: z.string().trim().max(120) }).strict(),
      reviewer: z.object({ provider: z.string().trim().max(80), model: z.string().trim().max(120) }).strict(),
      checks: z.array(z.object({
        name: z.string().trim().max(160),
        status: z.enum(["pending", "running", "passed", "failed"]),
        exitCode: z.number().int().optional(),
      }).strict()).max(8),
      findings: z.array(z.object({
        severity: z.enum(["critical", "high", "medium", "low"]),
        title: z.string().trim().max(240),
        resolved: z.boolean(),
      }).strict()).max(12),
      mergeStatus: z.enum(["not_merged", "pending", "merged"]),
      release: z.object({
        status: z.string().trim().max(60),
        environment: z.string().trim().max(60).optional(),
      }).strict().optional(),
    }).strict().optional(),
  }).strict(),
  history: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string().trim().min(1).max(4_000),
  }).strict()).max(8).optional(),
  model: z.object({
    provider: z.string().trim().min(1).max(80),
    model: z.string().trim().min(1).max(120),
  }).strict().optional(),
}).strict();

type AssistantWorkerRequest = <T>(pathName: string, init?: RequestInit, timeoutMs?: number) => Promise<T>;

export interface AssistantRouteDependencies {
  currentUser: (request: FastifyRequest) => CurrentUser;
  requestLocale: (request: FastifyRequest) => Locale;
  vaultKeyFor: (request: FastifyRequest) => string;
  providerAvailability: (vaultKey: string) => ProviderAvailability[];
  getCredential: (vaultKey: string, provider: string) => string | undefined;
  modelCatalog: ModelCatalogEntry[];
  defaultDeveloper: ModelSelection;
  requirementRefinements: Pick<RateLimiter, "check">;
  piAssistantQuestions: Pick<RateLimiter, "check">;
  workerRequest: AssistantWorkerRequest;
}

function tooManyRequests(reply: FastifyReply, retryAfterMs: number) {
  reply.header("Retry-After", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
  return reply.code(429).send({ error: "请求过于频繁，请稍后再试", code: "RATE_LIMITED" });
}

/** Non-mutating requirement refinement and contextual Pi assistant routes. */
export function registerAssistantRoutes(app: FastifyInstance, deps: AssistantRouteDependencies) {
  app.post("/api/requirements/refine", async (request, reply) => {
    const user = deps.currentUser(request);
    const limit = deps.requirementRefinements.check(user.id);
    if (!limit.allowed) return tooManyRequests(reply, limit.retryAfterMs);
    const parsed = requirementRefineSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid requirement", code: "REQUIREMENT_INPUT_INVALID", details: parsed.error.issues });

    const selection = parsed.data.model ?? deps.defaultDeveloper;
    const vaultKey = deps.vaultKeyFor(request);
    const validation = validateModelSelection(deps.modelCatalog, "developer", selection, deps.providerAvailability(vaultKey));
    if (!validation.ok) {
      return reply.code(422).send({ error: validation.message, code: validation.code, role: "requirement" });
    }
    let apiKey = deps.getCredential(vaultKey, validation.entry.provider) ?? "";
    if (!apiKey) {
      return reply.code(403).send({ error: "所选需求模型缺少可用凭据", code: "PERSONAL_CREDENTIALS_REQUIRED" });
    }
    try {
      return await deps.workerRequest<RequirementRefinement>("/requirements/refine", {
        method: "POST",
        body: JSON.stringify({
          ...parsed.data,
          locale: deps.requestLocale(request),
          provider: validation.entry.provider,
          model: validation.entry.model,
          apiKey,
        }),
      }, Math.max(8_000, Number(process.env.PI_REQUIREMENT_ASSISTANT_HTTP_TIMEOUT_MS || 30_000)));
    } catch (error) {
      const failure = error as Error & { code?: string };
      app.log.warn({
        provider: validation.entry.provider,
        model: validation.entry.model,
        error: serverDiagnosticMessage(failure, { credentials: [apiKey], limit: 300 }),
      }, "requirement assistant failed");
      if (failure.code === "REQUIREMENT_ASSISTANT_BUSY") {
        return reply.code(429).send({ error: "需求助手当前繁忙，请稍后重试", code: failure.code });
      }
      return reply.code(502).send({ error: "需求助手暂时不可用，请稍后重试；原始内容仍保留在表单中", code: "REQUIREMENT_ASSISTANT_FAILED" });
    } finally {
      apiKey = "";
    }
  });

  app.post("/api/assistant/ask", async (request, reply) => {
    const user = deps.currentUser(request);
    const limit = deps.piAssistantQuestions.check(user.id);
    if (!limit.allowed) return tooManyRequests(reply, limit.retryAfterMs);
    const parsed = piAssistantAskSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid assistant question", code: "PI_ASSISTANT_INPUT_INVALID", details: parsed.error.issues });

    const selection = parsed.data.model ?? deps.defaultDeveloper;
    const vaultKey = deps.vaultKeyFor(request);
    const validation = validateModelSelection(deps.modelCatalog, "developer", selection, deps.providerAvailability(vaultKey));
    if (!validation.ok) {
      return reply.code(422).send({ error: validation.message, code: validation.code, role: "assistant" });
    }
    let apiKey = deps.getCredential(vaultKey, validation.entry.provider) ?? "";
    if (!apiKey) {
      return reply.code(403).send({ error: "所选助手模型缺少可用凭据", code: "PERSONAL_CREDENTIALS_REQUIRED" });
    }
    try {
      return await deps.workerRequest<PiAssistantAnswer>("/assistant/ask", {
        method: "POST",
        body: JSON.stringify({
          ...parsed.data,
          locale: deps.requestLocale(request),
          provider: validation.entry.provider,
          model: validation.entry.model,
          apiKey,
        }),
      }, Math.max(8_000, Number(process.env.PI_ASSISTANT_HTTP_TIMEOUT_MS || 35_000)));
    } catch (error) {
      const failure = error as Error & { code?: string };
      app.log.warn({
        provider: validation.entry.provider,
        model: validation.entry.model,
        page: parsed.data.context.page,
        error: serverDiagnosticMessage(failure, { credentials: [apiKey], limit: 300 }),
      }, "pi assistant failed");
      if (failure.code === "PI_ASSISTANT_BUSY") {
        return reply.code(429).send({ error: "Pi Assistant 当前繁忙，请稍后重试", code: failure.code });
      }
      return reply.code(502).send({ error: "Pi Assistant 暂时不可用，请稍后重试", code: "PI_ASSISTANT_FAILED" });
    } finally {
      apiKey = "";
    }
  });
}

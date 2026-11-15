import { RunEventStream } from "./event-stream.js";
import { artifactDiagnosticDownloadSafe } from "./artifact-api.js";
import { parseRunSearch, searchRuns } from "./run-search.js";
import { ROUNDS_SCHEMA_VERSION, readRunRounds } from "./run-rounds.js";
import { readDecisionBrief } from "./decision-brief.js";
import { readDecisionUsageSafe } from "./decision-usage.js";
import { replayPendingMerge } from "./merge-approval.js";
import { buildMergeRequestPayload, mergeRequestUnavailable, patchFileName } from "./run-patch.js";
import { serverDiagnosticMessage } from "./server-diagnostics.js";
import type { WebServices } from "./web-services.js";

export function registerRunReadRoutes(services: WebServices) {
  const {
    ARTIFACT_DOWNLOAD_MAX_BYTES, app, auth, db, mergeRequestConfig, ownerKeysFor,
    readArtifactCredentials, requestLocale, resolveRunPatch, runActions, store, tooManyRequests,
    workspaces,
  } = services;

  // 需求历史: `?query=` is a case-insensitive substring over title/task/human
  // notes and `?state=` filters by run state; both are optional so callers that
  // omit them get the unchanged owner-scoped, newest-first list. Filtering runs
  // over that owner-scoped list with no additional pagination (the list is
  // already bounded to one owner and rendered client-side).
  app.get<{ Querystring: { query?: string; state?: string } }>("/api/runs", async (request, reply) => {
    const parsed = parseRunSearch(request.query ?? {});
    if (!parsed.ok) return reply.code(400).send({ error: "Invalid request", details: [{ message: parsed.error }] });
    return searchRuns(store.listRuns(ownerKeysFor(request)), parsed.filter);
  });

  app.get<{ Params: { id: string } }>("/api/runs/:id", async (request, reply) => {
    let run = store.getRun(request.params.id, ownerKeysFor(request));
    if (!run) return reply.code(404).send({ error: "Run not found" });
    // B1: a run whose worker merge succeeded but whose record write failed carries
    // a `committed_unrecorded` marker; converge it on read so the database never
    // stays silent about an already-merged workspace.
    if (run.mergePending) {
      run = (await replayPendingMerge(store, run.id)) ?? run;
    }
    // AT-JEV-061/062: the decision plane's real provider usage lives in
    // `decision_evaluations`, not in the run document (the worker owns that
    // revision). Aggregate it at read time under its own `role: "decision"` entry
    // and NEVER let an audit-table problem break the run-detail response: a
    // storage failure degrades to the run without decision usage and a warn.
    return readDecisionUsageSafe(db, run, (error) => {
      const message = error instanceof Error ? serverDiagnosticMessage(`${error.name}: ${error.message}`, { limit: 300 }) : "unknown error";
      app.log.warn({ error: message }, "decision usage aggregation failed; returning run without decision usage");
    });
  });

  app.get<{ Params: { id: string }; Querystring: { after?: string; limit?: string } }>("/api/runs/:id/events", async (request, reply) => {
    if (!store.getRun(request.params.id, ownerKeysFor(request))) return reply.code(404).send({ error: "Run not found" });
    const limit = Math.min(Math.max(Number(request.query.limit || 500), 1), 1_000);
    return store.getEvents(request.params.id, Number(request.query.after || 0), limit);
  });

  /**
   * 拓扑轮次模型: read-only, owner-scoped per-round summary aggregated from the
   * run's full `run_events` + `run_findings`. The client topology uses it as the
   * source of truth for its round model so branches older than the buffered event
   * window still render. Additive: absent on older servers, where the client falls
   * back to its event-derived model.
   */
  app.get<{ Params: { id: string } }>("/api/runs/:id/rounds", async (request, reply) => {
    const run = store.getRun(request.params.id, ownerKeysFor(request));
    if (!run) return reply.code(404).send({ error: "Run not found" });
    return { schemaVersion: ROUNDS_SCHEMA_VERSION, rounds: await readRunRounds(db, run.id, run.round) };
  });

  /**
   * Decision Brief (docs/22): a read-only, owner-scoped answer to the only
   * question a parked run raises — accept the delivery or keep developing?
   * Assembled from existing tables/events only (stoppage, findings, checks, diff
   * headers, story AC/DoD); all judgement lives in the shared pure function, so
   * the model never participates. Same auth/ownership as the run-detail route.
   */
  app.get<{ Params: { id: string } }>("/api/runs/:id/decision-brief", async (request, reply) => {
    const run = store.getRun(request.params.id, ownerKeysFor(request));
    if (!run) return reply.code(404).send({ error: "Run not found" });
    return readDecisionBrief(db, run, requestLocale(request));
  });

  // GAP-04 / AT-UI-005: artifact listing and download, authenticated like every
  // other run route and owner-scoped via ownerKeysFor.
  app.get<{ Params: { id: string } }>("/api/runs/:id/artifacts", async (request, reply) => {
    if (!store.getRun(request.params.id, ownerKeysFor(request))) return reply.code(404).send({ error: "Run not found" });
    return { artifacts: await store.listArtifacts(request.params.id) };
  });

  app.get<{ Params: { id: string; artifactId: string } }>("/api/runs/:id/artifacts/:artifactId/download", async (request, reply) => {
    const run = store.getRun(request.params.id, ownerKeysFor(request));
    if (!run) return reply.code(404).send({ error: "Run not found" });
    const artifact = await store.getArtifact(request.params.id, request.params.artifactId);
    // A run with a diff but no stored body (legacy/demo) still downloads the preview.
    const content = artifact?.content ?? (request.params.artifactId === "diff" ? run.diff : undefined);
    if (content === undefined) return reply.code(404).send({ error: "Artifact not found" });
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > ARTIFACT_DOWNLOAD_MAX_BYTES) {
      return reply.code(413).send({ error: `制品过大（${bytes} 字节），超过下载上限 ${ARTIFACT_DOWNLOAD_MAX_BYTES} 字节`, code: "ARTIFACT_TOO_LARGE" });
    }
    const kind = artifact?.kind ?? "patch";
    // Do not silently alter a historical body or advertise its old SHA for new
    // bytes. Require regeneration instead; the stored record is left untouched.
    if (!await artifactDiagnosticDownloadSafe({ kind, content, diagnosticPolicyVersion: artifact?.diagnosticPolicyVersion, diagnosticPolicySha256: artifact?.diagnosticPolicySha256 }, run, process.env, readArtifactCredentials)) {
      return reply.code(409).send({ error: "Diagnostic artifact requires secure regeneration", code: "ARTIFACT_DIAGNOSTICS_UNSAFE" });
    }
    const contentType = kind === "patch" ? "text/x-patch; charset=utf-8" : "application/octet-stream";
    const extension = kind === "patch" ? "patch" : "txt";
    reply.header("Content-Type", contentType);
    reply.header("Content-Disposition", `attachment; filename="${run.id}-${request.params.artifactId}.${extension}"`);
    return reply.send(content);
  });

  /**
   * A1: download the run's full patch as a `.patch` file. Reuses the stored diff
   * artifact; when no artifact body exists, the worker regenerates it from the run
   * directory. Never returns an empty or silently-truncated patch.
   */
  app.get<{ Params: { id: string } }>("/api/runs/:id/patch", async (request, reply) => {
    const run = store.getRun(request.params.id, ownerKeysFor(request));
    if (!run) return reply.code(404).send({ error: "Run not found" });
    const resolved = await resolveRunPatch(run);
    if (!resolved.ok) return reply.code(resolved.status).send({ error: resolved.error, code: resolved.code });
    if (resolved.selection.bytes > ARTIFACT_DOWNLOAD_MAX_BYTES) {
      return reply.code(413).send({ error: `补丁过大（${resolved.selection.bytes} 字节），超过下载上限`, code: "PATCH_TOO_LARGE" });
    }
    reply.header("Content-Type", "text/x-patch; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="${patchFileName(run.id)}"`);
    return reply.send(resolved.selection.content);
  });

  /**
   * A1: open a merge request through the configured `PI_MERGE_REQUEST_*` webhook.
   * When the feature is not configured the route refuses clearly with 409
   * MERGE_REQUEST_NOT_CONFIGURED (it is never silently skipped).
   */
  app.post<{ Params: { id: string } }>("/api/runs/:id/merge-request", { bodyLimit: 1024 * 1024 }, async (request, reply) => {
    const actionLimit = runActions.check(auth.user(request).id);
    if (!actionLimit.allowed) return tooManyRequests(reply, actionLimit.retryAfterMs);
    const run = store.getRun(request.params.id, ownerKeysFor(request));
    if (!run) return reply.code(404).send({ error: "Run not found" });
    if (!mergeRequestConfig.configured) {
      const refusal = mergeRequestUnavailable(mergeRequestConfig);
      return reply.code(refusal.status).send({ error: refusal.message, code: refusal.code });
    }
    const resolved = await resolveRunPatch(run);
    if (!resolved.ok) return reply.code(resolved.status).send({ error: resolved.error, code: resolved.code });

    const workspaceDefault = run.workspaceId
      ? await workspaces.get(ownerKeysFor(request), run.workspaceId).then((workspace) => workspace.defaultBranch ?? undefined).catch(() => undefined)
      : undefined;
    const payload = buildMergeRequestPayload({
      run,
      patch: resolved.selection,
      targetBranch: mergeRequestConfig.targetBranch ?? workspaceDefault,
      project: mergeRequestConfig.project,
      requestedBy: auth.user(request).id,
    });
    try {
      const response = await fetch(mergeRequestConfig.url!, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(mergeRequestConfig.token ? { Authorization: `Bearer ${mergeRequestConfig.token}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20_000),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: unknown; url?: unknown; id?: unknown; number?: unknown };
      if (!response.ok) {
        return reply.code(502).send({ error: `合并请求创建失败：${serverDiagnosticMessage(body.error ?? response.status, { limit: 200 })}`, code: "MERGE_REQUEST_FAILED" });
      }
      const mergeRequest = {
        url: typeof body.url === "string" ? body.url : null,
        id: typeof body.id === "string" || typeof body.id === "number" ? String(body.id) : null,
        number: typeof body.number === "string" || typeof body.number === "number" ? String(body.number) : null,
      };
      await store.appendEvent({
        runId: run.id,
        round: run.round,
        source: "system",
        type: "run.merge_requested",
        message: "已创建合并请求",
        at: new Date().toISOString(),
        meta: { ...mergeRequest, patchSha256: resolved.selection.sha256, patchBytes: resolved.selection.bytes },
      });
      return { ok: true, mergeRequest };
    } catch (error) {
      return reply.code(502).send({ error: `合并请求创建失败：${serverDiagnosticMessage(error, { limit: 200 })}`, code: "MERGE_REQUEST_FAILED" });
    }
  });

  app.get<{ Params: { id: string }; Querystring: { after?: string } }>("/api/runs/:id/stream", async (request, reply) => {
    if (!store.getRun(request.params.id, ownerKeysFor(request))) return reply.code(404).send({ error: "Run not found" });
    const after = Number(request.headers["last-event-id"] || request.query.after || 0);
    reply.hijack();
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    // AUD-17 / AT-UI-006: subscribe first, replay to a watermark, dedupe by seq.
    // Backpressure policy: a per-connection queue cap closes the stream as
    // `overflow`; the browser EventSource reconnects with `Last-Event-ID` and the
    // next connection resumes from the watermark, so no event is silently lost.
    const stream = new RunEventStream({
      runId: request.params.id,
      cursor: Number.isFinite(after) ? Math.max(0, after) : 0,
      subscribe: (listener) => store.subscribe(request.params.id, listener),
      fetchPage: (cursor, limit) => store.getEvents(request.params.id, cursor, limit),
      send: (event) => reply.raw.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`),
      bufferedBytes: () => reply.raw.writableLength,
      heartbeat: () => reply.raw.write(": heartbeat\n\n"),
      close: (reason, detail) => {
        try {
          if (reason === "overflow") reply.raw.write(`event: pigo.overflow\ndata: ${JSON.stringify({ reason, detail })}\n\n`);
        } catch {
          // The socket is already gone; ending below is best effort.
        }
        reply.raw.end();
      },
      log: (message, detail) => app.log.warn({ ...detail, runId: request.params.id }, message),
    });
    const onDrain = () => stream.resume();
    reply.raw.on("drain", onDrain);
    request.raw.on("close", () => {
      reply.raw.off("drain", onDrain);
      stream.stop();
    });
    try {
      await stream.start();
    } catch (error) {
      app.log.error({ error: serverDiagnosticMessage(error), runId: request.params.id }, "event stream failed");
      stream.stop();
      reply.raw.end();
    }
  });

}

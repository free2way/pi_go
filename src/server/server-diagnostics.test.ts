import Fastify from "fastify";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { serverDiagnosticMessage, serverLoggerOptions } from "./server-diagnostics.js";

const secret = ["DUMMY", 'opaque/+" value'].join("_");
const privateRoot = "/private/synthetic/workspace";
const environment = { PI_INTERNAL_TOKEN: secret, PI_WORKSPACE_ROOT: privateRoot };
const fake = (label: string) => ["DUMMY", label].join("_");

describe("Web diagnostic projection", () => {
  it.each([0, 24, 100, 200, 300, 2_000])("redacts complete values before a %s character limit", (limit) => {
    const value = "x".repeat(Math.max(0, limit - 5)) + secret;
    const original = new Error(value);
    const safe = serverDiagnosticMessage(original, { environment, limit });
    expect(safe.length).toBeLessThanOrEqual(limit);
    expect(safe).not.toContain("DUMMY");
    expect(original.message).toBe(value);
  });

  it("removes plain, URL-encoded, JSON-escaped and explicit request credentials", () => {
    const personal = "DUMMY_personal";
    const authenticatedUrl = `https://${["fixture", fake("password")].join(":")}@${["example", "invalid"].join(".")}/db`;
    const value = [secret, encodeURIComponent(secret), JSON.stringify(secret), personal, "Bearer DUMMY_header", authenticatedUrl, "?api_key=DUMMY_query"].join(" ");
    expect(serverDiagnosticMessage(value, { environment, credentials: [personal] })).not.toContain("DUMMY");
  });

  it("removes configured private paths, never treating a filesystem root as a secret", () => {
    const env = { PI_WORKSPACE_ROOT: privateRoot, PI_VAULT_FILE: "C:\\private\\vault.json", PI_OTHER_ROOT: "/", PI_DRIVE_ROOT: "C:\\", LANG: "ordinary" };
    const value = `${privateRoot}/run ${encodeURIComponent(privateRoot)} C:\\private\\vault.json src/app.ts /healthz ordinary`;
    expect(serverDiagnosticMessage(value, { environment: env })).toBe("[redacted]/run [redacted] [redacted] src/app.ts /healthz ordinary");
  });

  it("keeps classification and handles non-Error failures and invalid limits", () => {
    expect(serverDiagnosticMessage("ECONNREFUSED Bearer DUMMY_header", { environment: {} })).toBe("ECONNREFUSED Bearer [redacted]");
    expect(serverDiagnosticMessage(undefined, { environment: {} })).toBe("undefined");
    expect(serverDiagnosticMessage("x".repeat(3_000), { limit: NaN, environment: {} })).toHaveLength(2_000);
    expect(serverDiagnosticMessage("safe", { limit: -1, environment: {} })).toBe("");
  });
});

describe("actual Fastify/Pino logging boundary", () => {
  it("redacts raw messages/errors while preserving the original Error and correlation fields", async () => {
    const logs: Record<string, unknown>[] = [];
    const app = Fastify({ logger: { ...serverLoggerOptions(environment), stream: { write: (line) => { logs.push(JSON.parse(line)); } } } });
    try {
      const original = new Error(`ECONNREFUSED ${secret} ${privateRoot}/runs`, { cause: new Error("DUMMY_cause") });
      original.stack = "DUMMY_stack";
      app.log.warn({ error: original.message, runId: "run_fixture", attempt: 2 }, "database observation failed");
      app.log.error(original, "database error");
      app.log.info(`diagnostic ${secret}`);
      app.log.info("diagnostic %s", secret);
      app.log.info({ error: { authorization: fake("auth"), apiKey: fake("key"), nested: [original], count: 2 } }, "structured error");
      const wire = JSON.stringify(logs);
      expect(wire).not.toContain("DUMMY");
      expect(wire).not.toContain(privateRoot);
      expect(wire).toContain("ECONNREFUSED");
      expect(logs[0]).toMatchObject({ runId: "run_fixture", attempt: 2, level: 40 });
      expect(original.message).toContain(secret);
      expect(original.stack).toBe("DUMMY_stack");
    } finally { await app.close(); }
  });

  it("logs route templates and status without recording URLs, headers, bodies or changing responses", async () => {
    const logs: Record<string, unknown>[] = [];
    const app = Fastify({ logger: { ...serverLoggerOptions(environment), stream: { write: (line) => { logs.push(JSON.parse(line)); } } } });
    const body = { patch: `+const token = ${JSON.stringify(fake("source"))};\n`, modelJson: { token: fake("protocol") } };
    try {
      app.post("/fixture/:id", async (request, reply) => {
        expect(request.headers.authorization).toBe("Bearer DUMMY_auth");
        expect(request.params).toEqual({ id: "DUMMY_path" });
        expect(request.query).toEqual({ api_key: fake("query") });
        reply.header("set-cookie", "session=DUMMY_response_cookie");
        return request.body;
      });
      const reply = await app.inject({ method: "POST", url: "/fixture/DUMMY_path?api_key=DUMMY_query", payload: body,
        headers: { authorization: "Bearer DUMMY_auth", cookie: "session=DUMMY_cookie", "cf-access-jwt-assertion": "DUMMY_jwt" } });
      expect(reply.statusCode).toBe(200);
      expect(reply.json()).toEqual(body);
      expect(reply.headers["set-cookie"]).toBe("session=DUMMY_response_cookie");
      const wire = JSON.stringify(logs);
      expect(wire).not.toContain("DUMMY");
      const incoming = logs.find((row) => row.msg === "incoming request");
      const completed = logs.find((row) => row.msg === "request completed");
      expect(incoming?.req).toEqual({ method: "POST", route: "/fixture/:id" });
      expect(completed?.res).toEqual({ statusCode: 200 });
      expect(incoming?.reqId).toBeTruthy();
      expect(completed?.reqId).toBe(incoming?.reqId);
      expect(completed?.responseTime).toEqual(expect.any(Number));
    } finally { await app.close(); }
  });

  it("does not fall back to an unmatched raw URL and keeps framework errors safe", async () => {
    const logs: Record<string, unknown>[] = [];
    const app = Fastify({ logger: { ...serverLoggerOptions(environment), stream: { write: (line) => { logs.push(JSON.parse(line)); } } } });
    try {
      app.get("/failure", () => { throw new Error(`ECONNREFUSED ${secret}`, { cause: new Error("DUMMY_cause") }); });
      expect((await app.inject({ url: "/unmatched/DUMMY_path?token=DUMMY_query" })).statusCode).toBe(404);
      expect((await app.inject({ url: "/failure" })).statusCode).toBe(500);
      const wire = JSON.stringify(logs);
      expect(wire).not.toContain("DUMMY");
      expect(wire).toContain("ECONNREFUSED");
      expect(logs.filter((row) => row.msg === "request completed").map((row) => (row.res as { statusCode: number }).statusCode)).toEqual([404, 500]);
    } finally { await app.close(); }
  });

  it("reads current environment values at serialization time for credential rotation", async () => {
    const mutable = { PI_INTERNAL_TOKEN: "DUMMY_before" };
    const logs: unknown[] = [];
    const app = Fastify({ logger: { ...serverLoggerOptions(mutable), stream: { write: (line) => { logs.push(JSON.parse(line)); } } } });
    try {
      app.log.warn({ error: mutable.PI_INTERNAL_TOKEN }, "before rotation");
      mutable.PI_INTERNAL_TOKEN = "DUMMY_after";
      app.log.warn({ error: mutable.PI_INTERNAL_TOKEN }, "after rotation");
      expect(JSON.stringify(logs)).not.toContain("DUMMY");
    } finally { await app.close(); }
  });

  it("wires the real Web logger and removes early truncation from system-status diagnostics", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).toContain("logger: serverLoggerOptions(),");
    const status = source.slice(source.indexOf('app.get("/api/system/status"'), source.indexOf("// Only the worker reports its own version"));
    expect(status.match(/error: serverDiagnosticMessage\(error, \{ limit: 200 \}\)/g)).toHaveLength(5);
    expect(status).not.toContain(".message.slice(");
  });
});

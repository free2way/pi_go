import type { FastifyInstance, FastifyServerOptions } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

type Route = { method: string; url: string; bodyLimit: number };
const routes = new Map<string, Route>();
const calls = new Map<string, number>();
let app: FastifyInstance;
let directory: string;
const tokens = { worker: randomBytes(24).toString("hex"), release: randomBytes(24).toString("hex"), metrics: randomBytes(24).toString("hex") };

vi.mock("fastify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fastify")>();
  return { ...actual, default: (options: FastifyServerOptions) => {
    app = actual.default({ ...options, logger: false });
    app.addHook("onRoute", (route) => {
      for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
        routes.set(method + " " + route.url, { method, url: route.url, bodyLimit: route.bodyLimit ?? app.initialConfig.bodyLimit! });
      }
      const handler = route.handler;
      route.handler = function (request, reply) {
        const key = request.method + " " + request.routeOptions.url;
        calls.set(key, (calls.get(key) ?? 0) + 1);
        return handler.call(this, request, reply);
      };
    });
    vi.spyOn(app, "listen").mockImplementation(async () => {
      await app.ready();
      return "fixture";
    });
    return app;
  } };
});
vi.mock("./db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db.js")>();
  const { DataType, newDb } = await import("pg-mem");
  const memory = newDb();
  memory.public.registerFunction({ name: "pg_advisory_xact_lock", args: [DataType.integer, DataType.integer],
    returns: DataType.integer, impure: true, implementation: () => 0 });
  const { Pool } = memory.adapters.createPg();
  return { ...actual, createPool: () => Object.assign(new Pool(), {
    totalCount: 0, idleCount: 0, waitingCount: 0,
  }) };
});

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "pigo-route-contract-"));
  for (const name of Object.keys(process.env).filter(name => name.startsWith("PI_"))) vi.stubEnv(name, undefined);
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("External fetch disabled in route fixture"); }));
  vi.stubEnv("PI_DATABASE_URL", "fixture");
  vi.stubEnv("PI_DATA_FILE", join(directory, "runs"));
  vi.stubEnv("PI_VAULT_FILE", join(directory, "vault"));
  vi.stubEnv("PI_RELEASE_SETTINGS_FILE", join(directory, "releases"));
  vi.stubEnv("PI_SCM_SETTINGS_FILE", join(directory, "scm"));
  vi.stubEnv("PI_VAULT_SECRET", randomBytes(32).toString("base64"));
  vi.stubEnv("PI_INTERNAL_TOKEN", tokens.worker);
  vi.stubEnv("PI_STAGING_DEPLOY_TOKEN", tokens.release);
  vi.stubEnv("PI_METRICS_TOKEN", tokens.metrics);
  vi.stubEnv("PI_AUTH_MODE", "cloudflare");
  vi.stubEnv("PI_CF_ACCESS_TEAM_DOMAIN", "example.invalid");
  vi.stubEnv("PI_CF_ACCESS_AUDIENCE", "fixture");
  vi.stubEnv("PI_PUBLIC_ORIGIN", "https://example.invalid");
  await import("./index.js");
});

afterAll(async () => {
  await app?.close();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  if (directory) await rm(directory, { recursive: true, force: true });
});

function invoke(route: Route, token?: string) {
  return app.inject({
    method: route.method as "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS",
    url: route.url.replace(/:[^/]+/g, "fixture-id"),
    ...(token === undefined ? {} : { headers: { authorization: "Bearer " + token } }),
    ...(["POST", "PUT", "PATCH"].includes(route.method) ? { payload: {} } : {}),
  });
}

function servicePolicy(url: string) {
  if (url === "/api/internal/metrics") return ["metrics"] as const;
  if (url.endsWith("/release-result") || url.endsWith("/rollback-result")) return ["worker", "release"] as const;
  return ["worker"] as const;
}

it("captures the registered route surface and checks each service credential", async () => {
  const snapshot = [];
  const authChecks = [];
  for (const [key, route] of [...routes].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const isApi = route.url.startsWith("/api/") && !route.url.includes("*");
    const before = calls.get(key) ?? 0;
    const response = isApi ? await invoke(route) : undefined;
    snapshot.push({ ...route, authRequired: response ? response.statusCode === 401 : false });
    if (!route.url.startsWith("/api/internal/")) continue;
    const policy: readonly (keyof typeof tokens)[] = servicePolicy(route.url);
    expect(response?.statusCode, key).toBe(401);
    const unauthorizedCalls = (calls.get(key) ?? 0) - before;
    expect(unauthorizedCalls, key).toBe(0);
    authChecks.push({ key, credential: "missing", status: response?.statusCode, handlerCalls: unauthorizedCalls });
    for (const [label, token] of Object.entries({ ...tokens, wrong: "z".repeat(tokens.worker.length), short: "z" })) {
      const count = calls.get(key) ?? 0;
      const result = await invoke(route, token);
      const handlerCalls = (calls.get(key) ?? 0) - count;
      const allowed = policy.some(name => name === label);
      expect(result.statusCode === 401, key + " " + label).toBe(!allowed);
      if (!allowed) expect(handlerCalls, key + " " + label).toBe(0);
      if (allowed) {
        expect(handlerCalls, key + " " + label).toBe(1);
        expect(result.statusCode, key + " " + label).toBeLessThan(500);
        if (label === "metrics") expect(result.statusCode, key).toBe(200);
      }
      authChecks.push({ key, credential: label, status: result.statusCode, handlerCalls });
    }
  }
  expect(snapshot).toHaveLength(157);
  expect(authChecks).toHaveLength(114);
  // Registered method, path, effective body limit and anonymous auth outcome on the baseline.
  expect(createHash("sha256").update(JSON.stringify(snapshot)).digest("hex")).toBe("f5f389993989a070785c1dd640d6a55d643d3753553cb177fad17916d90ffeda");
  if (process.env.PIGO_ROUTE_SNAPSHOT) {
    await writeFile(process.env.PIGO_ROUTE_SNAPSHOT, JSON.stringify({ routes: snapshot, authChecks }, null, 2) + "\n");
  }
}, 15_000);

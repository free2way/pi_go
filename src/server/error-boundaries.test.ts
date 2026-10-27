import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { AlertManager, createAlertSink } from "./alerts.js";
import { requestErrorReply, isStorageFailure } from "./request-errors.js";
import { serverDiagnosticMessage, serverLoggerOptions } from "./server-diagnostics.js";
import { diagnosticSecrets, redactDiagnosticText } from "../shared/diagnostics.js";
import { WorkspaceError } from "./workspaces.js";

// Exercise the actual entry-point callbacks without starting its database,
// timers or listener. Fastify, Pino and alert serialization remain real.
const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const tree = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
const printer = ts.createPrinter();
let errorHandler: ts.Node | undefined;
ts.forEachChild(tree, (node) => {
  if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && node.expression.expression.getText(tree) === "app.setErrorHandler") {
    errorHandler = node.expression.arguments[0];
  }
});
const classifier = tree.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "classifyWorkspaceError");
function compile<T>(node: ts.Node | undefined, context: Record<string, unknown>): T {
  if (!node) throw new Error("Expected application error boundary is missing");
  const expression = `(${printer.printNode(ts.EmitHint.Unspecified, node, tree)})`;
  return runInNewContext(ts.transpileModule(expression, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText, context) as T;
}

type ErrorHandler = (error: FastifyError, request: FastifyRequest, reply: FastifyReply) => unknown;
type Classifier = (error: unknown) => { status: number; body: Record<string, unknown> };
const privateRoot = "/private/synthetic/workspace";
const dataFile = `${privateRoot}/runs.json`;
const secret = ["DUMMY", "opaque-platform-value"].join("_");
const environment = { PI_WORKSPACE_ROOT: privateRoot, PI_DATA_FILE: dataFile, PI_INTERNAL_TOKEN: secret };
const cases = [
  { name: "global-storage", status: 503, code: "STORAGE_UNAVAILABLE", alerts: 1 },
  { name: "global-client", status: 422, code: undefined, alerts: 0 },
  { name: "workspace-typed", status: 400, code: "WORKSPACE_OPERATION_FAILED", alerts: 0 },
  { name: "workspace-storage", status: 503, code: "STORAGE_UNAVAILABLE", alerts: 1 },
  { name: "workspace-generic", status: 503, code: undefined, alerts: 0 },
  { name: "global-storage-truncated", status: 503, code: "STORAGE_UNAVAILABLE", alerts: 1 },
  { name: "workspace-storage-truncated", status: 503, code: "STORAGE_UNAVAILABLE", alerts: 1 },
  { name: "global-storage-encoded", status: 503, code: "STORAGE_UNAVAILABLE", alerts: 1 },
  { name: "workspace-typed-encoded", status: 400, code: "WORKSPACE_OPERATION_FAILED", alerts: 0 },
];

describe("application error HTTP, alert and log boundaries", () => {
  it.each(cases)("hides configured paths and credentials in $name", async (scenario) => {
    const logs: unknown[] = [], notifications: unknown[] = [];
    const app = Fastify({ logger: { ...serverLoggerOptions(environment), stream: { write: (line) => { logs.push(JSON.parse(line)); } } } });
    const alerts = new AlertManager(createAlertSink({
      environment,
      log: (level, payload, message) => app.log[level](payload, message),
      webhookUrl: "https://example.invalid/fixture",
      fetchImpl: async (_url, init) => { notifications.push(JSON.parse(String(init?.body))); return new Response("{}"); },
    }));
    const context = {
      app, alerts, WorkspaceError, isStorageFailure, redactDiagnosticText,
      diagnosticSecrets: () => diagnosticSecrets(environment),
      requestErrorReply: (error: unknown) => requestErrorReply(error, environment),
      serverDiagnosticMessage: (error: unknown, options: Parameters<typeof serverDiagnosticMessage>[1] = {}) => serverDiagnosticMessage(error, { ...options, environment }),
    };
    const path = scenario.name.endsWith("encoded") ? encodeURIComponent(dataFile) : dataFile;
    const diagnostic = scenario.name.endsWith("truncated")
      ? `ENOSPC ${"x".repeat(185)}${dataFile} ${secret}`
      : `${scenario.name.includes("storage") ? "ENOSPC" : "controlled failure"} ${path} ${secret}`;
    const error = scenario.name.startsWith("workspace-typed")
      ? new WorkspaceError("WORKSPACE_OPERATION_FAILED", diagnostic, 400)
      : Object.assign(new Error(diagnostic), scenario.name === "global-client" ? { statusCode: 422 } : {});
    try {
      app.setErrorHandler(compile<ErrorHandler>(errorHandler, context));
      if (scenario.name.startsWith("global")) app.get("/fixture", async () => { throw error; });
      else {
        const classify = compile<Classifier>(classifier, context);
        app.get("/fixture", async (_request, reply) => {
          const result = classify(error);
          return reply.code(result.status).send(result.body);
        });
      }
      const response = await app.inject("/fixture");
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(response.statusCode).toBe(scenario.status);
      expect(response.json().code).toBe(scenario.code);
      expect(notifications).toHaveLength(scenario.alerts);
      for (const output of [response.body, JSON.stringify(notifications), JSON.stringify(logs)]) {
        expect(output).not.toContain(privateRoot.slice(0, 8));
        expect(output).not.toContain(encodeURIComponent(privateRoot));
        expect(output).not.toContain(secret);
      }
      expect(response.json().error).toContain("[redact");
      expect(error.message).toBe(diagnostic);
    } finally { await app.close(); }
  });
});

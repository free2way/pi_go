import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import ts from "typescript";

export const ROUTE_CONTRACT_SNAPSHOT = "scripts/server-route-contract.snapshot.json";
const METHODS = new Set(["get", "post", "put", "patch", "delete"]);

function sourceFiles(root) {
  const found = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory)) {
      const absolute = path.join(directory, entry);
      if (statSync(absolute).isDirectory()) visit(absolute);
      else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) found.push(absolute);
    }
  };
  visit(path.join(root, "src/server"));
  return found.sort();
}

function normalizeExpression(value) {
  return value.replace(/\s+/g, " ").trim();
}

function routeUrl(argument, sourceFile) {
  if (ts.isStringLiteralLike(argument)) return argument.text;
  if (ts.isTemplateExpression(argument)) return normalizeExpression(argument.getText(sourceFile));
  if (ts.isIdentifier(argument) || ts.isPropertyAccessExpression(argument)) return argument.getText(sourceFile);
  return undefined;
}

function bodyLimit(call, sourceFile, constants) {
  const options = call.arguments[1];
  if (!options || !ts.isObjectLiteralExpression(options)) return null;
  const property = options.properties.find((entry) => ts.isPropertyAssignment(entry)
    && ((ts.isIdentifier(entry.name) && entry.name.text === "bodyLimit")
      || (ts.isStringLiteralLike(entry.name) && entry.name.text === "bodyLimit")));
  if (!property || !ts.isPropertyAssignment(property)) return null;
  const initializer = property.initializer;
  if (ts.isIdentifier(initializer) && constants.has(initializer.text)) return constants.get(initializer.text);
  return normalizeExpression(initializer.getText(sourceFile));
}

function authClass(file, url, callText) {
  const internal = url.startsWith("/api/internal/")
    || url === "DECISION_EVALUATE_PATH"
    || url === "DECISION_AUDIT_RETENTION_PATH";
  if (internal) {
    if (callText.includes("releaseCallbackAuthorized")) return "release-callback";
    if (file.endsWith("operational-metrics.ts")) return "metrics-or-internal";
    return "internal";
  }
  if (url === "/api/health" || url === "/api/auth/config") return "public";
  return "session";
}

export function scanRouteSources(sources) {
  const routes = [];
  for (const [file, source] of sources) {
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const constants = new Map();
    const collectConstants = (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        constants.set(node.name.text, normalizeExpression(node.initializer.getText(sourceFile)));
      }
      ts.forEachChild(node, collectConstants);
    };
    collectConstants(sourceFile);
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        const receiver = node.expression.expression.getText(sourceFile);
        const argument = node.arguments[0];
        if (METHODS.has(method) && (receiver === "app" || receiver === "internal") && argument) {
          const url = routeUrl(argument, sourceFile);
          if (url && (url.startsWith("/api/") || /^[A-Z][A-Z0-9_]*PATH$/.test(url))) {
            routes.push({
              method: method.toUpperCase(),
              url,
              bodyLimit: bodyLimit(node, sourceFile, constants),
              auth: authClass(file, url, node.getText(sourceFile)),
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return routes.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

export function scanWorkspace(root = process.cwd()) {
  return scanRouteSources(sourceFiles(root).map((file) => [path.relative(root, file), readFileSync(file, "utf8")]));
}

export function scanGitTree(treeish, root = process.cwd()) {
  const names = execFileSync("git", ["ls-tree", "-r", "--name-only", treeish, "src/server"], { cwd: root, encoding: "utf8" })
    .trim().split("\n")
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));
  return scanRouteSources(names.map((file) => [
    file,
    execFileSync("git", ["show", `${treeish}:${file}`], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }),
  ]));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const writeFrom = process.argv.indexOf("--write-from");
  const routes = writeFrom >= 0 ? scanGitTree(process.argv[writeFrom + 1]) : scanWorkspace();
  const body = `${JSON.stringify({ schemaVersion: 1, routes }, null, 2)}\n`;
  if (writeFrom >= 0) {
    writeFileSync(path.resolve(ROUTE_CONTRACT_SNAPSHOT), body, { mode: 0o644 });
    console.log(`wrote ${routes.length} route declarations from ${process.argv[writeFrom + 1]}`);
  } else {
    process.stdout.write(body);
  }
}

/**
 * P1 regression: the demo stack's workspace mount must be a SINGLE
 * `<host root>:/workspace` bind, identical in demo-web and demo-worker.
 *
 * The audit found the same host directory mounted both at `/workspace` and at
 * `/workspace/projects` (worker), plus a bare `/workspace/projects` mount in
 * web. Because the worker resolves repositories relative to
 * PI_WORKSPACE_ROOT=/workspace, the nested bind shadowed the real
 * `<root>/projects` directory: a stored `workspaces.canonical_path` of
 * `/workspace/projects/<repo>` then pointed at a different host directory
 * (or a directory the sandbox binds never saw), so existing repos looked
 * invalid and clones landed in the wrong place.
 *
 * Pure: reads deploy/docker/compose.demo.yaml as text (no Docker daemon) and
 * exercises the exported path logic on fixtures. Runs via `npm run test:scripts`
 * (vitest only collects `src/**`).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DEFAULT_COMPOSE_FILE,
  WORKSPACE_CONTAINER_ROOT,
  checkDemoCompose,
  ensureWorkspaceDirectories,
  resolveWorkspaceHostPath,
  workspaceLayout,
  workspaceRootMounts,
} from "./demo-env-lib.mjs";
import { listItems, serviceBlock } from "./compose-config-coverage.mjs";

const composeText = readFileSync(DEFAULT_COMPOSE_FILE, "utf8");
const lines = composeText.split("\n");
const HOST_ROOT = "/app/pi-agent/demo-workspace";
const SERVICES = ["demo-web", "demo-worker"];

/** Workspace-root mount targets declared by a service in the REAL compose file. */
function workspaceTargetsIn(serviceName) {
  return workspaceRootMounts({ volumes: listItems(serviceBlock(lines, serviceName), "volumes") }).map((mount) => mount.target);
}

/** Minimal well-formed resolved compose config, parameterised by workspace mounts. */
function composeFixture({ webWorkspaceTargets = [WORKSPACE_CONTAINER_ROOT], workerWorkspaceTargets = [WORKSPACE_CONTAINER_ROOT], workerEnv = {} } = {}) {
  const bind = (target) => ({ type: "bind", source: HOST_ROOT, target });
  return {
    services: {
      "demo-web": {
        environment: {
          NODE_ENV: "development",
          HOST: "0.0.0.0",
          PI_AUTH_MODE: "development",
          PI_DATABASE_URL: "postgresql://pigo:pw@postgres:5432/pigo_demo",
          PI_VAULT_FILE: "/app/data/credentials.v1.json",
          PI_INTERNAL_TOKEN: "token-abc",
          PI_WEB_VERSION: "demo-0.27.1",
        },
        volumes: [bind("/app/data"), ...webWorkspaceTargets.map(bind)],
        ports: [{ mode: "host", target: 3100, published: "3101", host_ip: "0.0.0.0" }],
      },
      "demo-worker": {
        environment: {
          PI_WEB_CALLBACK_URL: "http://demo-web:3100",
          PI_INTERNAL_TOKEN: "token-abc",
          PI_WORKER_VERSION: "demo-0.27.1",
          PI_SANDBOX_MODE: "auto",
          PI_WORKSPACE_ROOT: WORKSPACE_CONTAINER_ROOT,
          PI_HOST_WORKSPACE_ROOT: HOST_ROOT,
          ...workerEnv,
        },
        volumes: [...workerWorkspaceTargets.map(bind), { type: "bind", source: "/var/run/docker.sock", target: "/var/run/docker.sock" }],
        group_add: ["983"],
      },
    },
  };
}

test("compose.demo.yaml: each service mounts the workspace root exactly once, at /workspace", () => {
  for (const service of SERVICES) {
    assert.deepEqual(
      workspaceTargetsIn(service),
      [WORKSPACE_CONTAINER_ROOT],
      `${service} must declare exactly one workspace-root mount, at ${WORKSPACE_CONTAINER_ROOT}`,
    );
  }
});

test("compose.demo.yaml: nothing is mounted under /workspace (no shadowing bind)", () => {
  for (const service of SERVICES) {
    const nested = workspaceTargetsIn(service).filter((target) => target !== WORKSPACE_CONTAINER_ROOT);
    assert.deepEqual(nested, [], `${service} must not mount a subdirectory of ${WORKSPACE_CONTAINER_ROOT}`);
  }
  assert.ok(
    !lines.some((line) => /:\/workspace\/projects(?:\s|$)/.test(line)),
    "the nested :/workspace/projects bind must not reappear in compose.demo.yaml",
  );
  assert.ok(
    composeText.includes("PI_HOST_WORKSPACE_ROOT"),
    "the worker must still publish PI_HOST_WORKSPACE_ROOT for the sandbox binds",
  );
  assert.ok(
    /PI_WORKSPACE_ROOT: \/workspace\b/.test(composeText),
    "the worker's PI_WORKSPACE_ROOT must stay /workspace (the mount target)",
  );
});

test("workspaceRootMounts: reads short syntax without being fooled by ${VAR:?message}", () => {
  const mounts = workspaceRootMounts({
    volumes: [
      "${PIGO_DEMO_WORKSPACE_ROOT:?Set PIGO_DEMO_WORKSPACE_ROOT in deploy/docker/demo.env}:/workspace",
      "${PIGO_DEMO_MODELS_FILE:?Set PIGO_DEMO_MODELS_FILE}:/home/node/.pi/agent/models.json:ro",
      "/var/run/docker.sock:/var/run/docker.sock",
    ],
  });
  assert.deepEqual(mounts, [{ source: "${PIGO_DEMO_WORKSPACE_ROOT:?Set PIGO_DEMO_WORKSPACE_ROOT in deploy/docker/demo.env}", target: "/workspace" }]);
});

test("path regression: a canonical_path maps to <root>/projects/<repo> in BOTH web and worker", () => {
  const canonical = `${WORKSPACE_CONTAINER_ROOT}/projects/pi_go`;
  const web = { volumes: [{ type: "bind", source: HOST_ROOT, target: WORKSPACE_CONTAINER_ROOT }] };
  const worker = {
    volumes: [
      { type: "bind", source: HOST_ROOT, target: WORKSPACE_CONTAINER_ROOT },
      { type: "bind", source: "/var/run/docker.sock", target: "/var/run/docker.sock" },
    ],
  };

  assert.equal(resolveWorkspaceHostPath(canonical, web), `${HOST_ROOT}/projects/pi_go`);
  assert.equal(resolveWorkspaceHostPath(canonical, worker), `${HOST_ROOT}/projects/pi_go`);
  assert.equal(
    resolveWorkspaceHostPath(canonical, web),
    resolveWorkspaceHostPath(canonical, worker),
    "web and worker must resolve the same canonical_path to the same host directory",
  );
  // The documented layout: <root>/projects/<repo>.
  assert.equal(resolveWorkspaceHostPath(canonical, worker), workspaceLayout(HOST_ROOT).projects + "/pi_go");
});

test("path regression: the OLD nested mount redirected the repo to <root>/<repo>", () => {
  const canonical = `${WORKSPACE_CONTAINER_ROOT}/projects/pi_go`;
  const nestedWorker = {
    volumes: [
      { type: "bind", source: HOST_ROOT, target: WORKSPACE_CONTAINER_ROOT },
      { type: "bind", source: HOST_ROOT, target: `${WORKSPACE_CONTAINER_ROOT}/projects` },
    ],
  };

  // Longest-target match wins: the nested bind makes /workspace/projects = <root>,
  // so canonical_path /workspace/projects/<repo> resolves to <root>/<repo>.
  assert.equal(resolveWorkspaceHostPath(canonical, nestedWorker), `${HOST_ROOT}/pi_go`);
  assert.notEqual(resolveWorkspaceHostPath(canonical, nestedWorker), `${HOST_ROOT}/projects/pi_go`);
});

test("checkDemoCompose: refuses a nested /workspace/projects bind", () => {
  const config = composeFixture({ workerWorkspaceTargets: [WORKSPACE_CONTAINER_ROOT, `${WORKSPACE_CONTAINER_ROOT}/projects`] });
  const { ok, problems } = checkDemoCompose(config);
  assert.equal(ok, false);
  assert.ok(problems.some((problem) => /inside \/workspace/.test(problem)), problems.join("\n"));
});

test("checkDemoCompose: refuses a web service missing the /workspace mount", () => {
  const config = composeFixture({ webWorkspaceTargets: [`${WORKSPACE_CONTAINER_ROOT}/projects`] });
  const { ok, problems } = checkDemoCompose(config);
  assert.equal(ok, false);
  const joined = problems.join("\n");
  assert.match(joined, /demo-web must mount the workspace root exactly once/);
  assert.match(joined, /inside \/workspace/);
});

test("checkDemoCompose: refuses a worker whose PI_HOST_WORKSPACE_ROOT disagrees with the mount source", () => {
  const config = composeFixture({ workerEnv: { PI_HOST_WORKSPACE_ROOT: "/somewhere/else" } });
  const { ok, problems } = checkDemoCompose(config);
  assert.equal(ok, false);
  assert.ok(problems.some((problem) => /PI_HOST_WORKSPACE_ROOT/.test(problem)), problems.join("\n"));
});

test("checkDemoCompose: refuses a worker whose PI_WORKSPACE_ROOT is not the mount target", () => {
  const config = composeFixture({ workerEnv: { PI_WORKSPACE_ROOT: "/srv" } });
  const { ok, problems } = checkDemoCompose(config);
  assert.equal(ok, false);
  assert.ok(problems.some((problem) => /PI_WORKSPACE_ROOT is "\/srv"/.test(problem)), problems.join("\n"));
});

test("checkDemoCompose: refuses web and worker mounting different host directories at /workspace", () => {
  const config = composeFixture();
  config.services["demo-web"].volumes = [
    { type: "bind", source: "/app/pi-agent/demo-data", target: "/app/data" },
    { type: "bind", source: "/app/pi-agent/other-workspace", target: WORKSPACE_CONTAINER_ROOT },
  ];
  const { ok, problems } = checkDemoCompose(config);
  assert.equal(ok, false);
  assert.ok(problems.some((problem) => /different host directories/.test(problem)), problems.join("\n"));
});

test("checkDemoCompose: accepts the single-mount layout", () => {
  const { ok, problems } = checkDemoCompose(composeFixture());
  assert.deepEqual(problems, []);
  assert.equal(ok, true);
});

test("workspaceLayout + ensureWorkspaceDirectories: creates <root>/projects and <root>/runs", () => {
  const layout = workspaceLayout(HOST_ROOT);
  assert.equal(layout.projects, `${HOST_ROOT}/projects`);
  assert.equal(layout.runs, `${HOST_ROOT}/runs`);

  const created = [];
  const result = ensureWorkspaceDirectories(layout, { mkdir: (dir, options) => created.push([dir, options]) });
  assert.equal(result.ok, true);
  assert.deepEqual(created.map(([dir]) => dir), [layout.projects, layout.runs]);
  assert.ok(created.every(([, options]) => options?.recursive === true));
});

test("ensureWorkspaceDirectories: reports a failure instead of throwing", () => {
  const result = ensureWorkspaceDirectories(workspaceLayout(HOST_ROOT), {
    mkdir: (dir) => {
      if (String(dir).endsWith("/projects")) {
        const error = new Error("permission denied");
        error.code = "EACCES";
        throw error;
      }
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /EACCES/);
});

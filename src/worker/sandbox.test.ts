import { describe, expect, it } from "vitest";
import {
  buildContainerSpec,
  createShutdownHandler,
  hostPathFor,
  parseSandboxAllowDegraded,
  resolveSandboxMode,
  SandboxContainerRegistry,
  SandboxUnavailableError,
  sandboxStateDirectory,
  type SandboxContainerHandle,
} from "./sandbox.js";

const base = {
  image: "local/pigo-sandbox:0.1.0",
  worktree: "/workspace/runs/owner/run_1",
  hostWorktreePath: "/host/workspace/runs/owner/run_1",
  hostRepositoryPath: "/host/workspace/projects/fixture-rel",
  repositoryPath: "/workspace/projects/fixture-rel",
  hostModelsFile: "/host/pi-models.json",
  modelsFile: "/home/node/.pi/agent/models.json",
  stateDir: "/home/node/.pi",
  stateMount: "bind" as const,
  hostStateDir: "/host/workspace/runs/owner/run_1/.pi-state",
  env: { DEEPSEEK_API_KEY: "role-key" },
  argv: ["pi", "--mode", "json"],
  network: "none" as const,
};

describe("buildContainerSpec", () => {
  it("mounts only the run worktree, its repository metadata and the model definition (AT-SEC-007)", () => {
    const spec = buildContainerSpec(base);
    expect(spec.HostConfig.Binds).toEqual([
      "/host/workspace/runs/owner/run_1:/workspace/runs/owner/run_1:rw",
      "/host/workspace/projects/fixture-rel/.git:/workspace/projects/fixture-rel/.git:rw",
      "/host/pi-models.json:/home/node/.pi/agent/models.json:ro",
      "/host/workspace/runs/owner/run_1/.pi-state:/home/node/.pi:rw",
    ]);
    // No other projects, no workspace root, no docker socket.
    expect(spec.HostConfig.Binds.some((bind) => bind.includes(":/workspace:rw"))).toBe(false);
    expect(spec.HostConfig.Binds.some((bind) => bind.includes("docker.sock"))).toBe(false);
    expect(spec.WorkingDir).toBe("/workspace/runs/owner/run_1");
  });

  it("mounts allowlisted plugins read-only and nothing when unconfigured (GAP-02)", () => {
    const withoutPlugins = buildContainerSpec(base);
    expect(withoutPlugins.HostConfig.Binds.some((bind) => bind.includes("/opt/pigo/plugins"))).toBe(false);

    const spec = buildContainerSpec({
      ...base,
      pluginMounts: [{ hostPath: "/opt/pigo/review.ts", containerPath: "/opt/pigo/plugins/0-review.ts" }],
    });
    expect(spec.HostConfig.Binds).toContain("/opt/pigo/review.ts:/opt/pigo/plugins/0-review.ts:ro");
  });

  it("mounts the reviewer snapshot read-only and hides repository metadata (GAP-03 / AT-SEC-009)", () => {
    const spec = buildContainerSpec({ ...base, readOnly: true });
    expect(spec.HostConfig.Binds).toContain("/host/workspace/runs/owner/run_1:/workspace/runs/owner/run_1:ro");
    expect(spec.HostConfig.Binds.some((bind) => bind.includes("/.git:"))).toBe(false);
    expect(spec.HostConfig.Binds.some((bind) => bind.includes(":rw") && bind.includes("runs/owner/run_1:"))).toBe(false);
  });

  it("applies the container security baseline (SEC-005)", () => {
    const spec = buildContainerSpec(base);
    expect(spec.User).toBe("node");
    expect(spec.HostConfig.NetworkMode).toBe("none");
    expect(spec.HostConfig.ReadonlyRootfs).toBe(true);
    expect(spec.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(spec.HostConfig.SecurityOpt).toEqual(["no-new-privileges:true"]);
    expect(spec.HostConfig.PidsLimit).toBe(256);
    expect(spec.HostConfig.Memory).toBe(2 * 1024 * 1024 * 1024);
    expect(spec.Labels["pigo.sandbox"]).toBe("1");
  });

  it("passes only the supplied environment (SEC-003/010)", () => {
    const spec = buildContainerSpec({ ...base, env: { DEEPSEEK_API_KEY: "role-key", PATH: "/usr/bin" } });
    expect(spec.Env).toEqual(["DEEPSEEK_API_KEY=role-key", "PATH=/usr/bin"]);
    expect(spec.Env.join(" ")).not.toContain("PI_INTERNAL_TOKEN");
  });

  it("grants network only when explicitly requested for agent calls (SEC-006)", () => {
    expect(buildContainerSpec({ ...base, network: "bridge" }).HostConfig.NetworkMode).toBe("bridge");
    expect(buildContainerSpec(base).HostConfig.NetworkMode).toBe("none");
  });
});

describe("hostPathFor", () => {
  it("maps container paths onto host paths", () => {
    expect(hostPathFor("/workspace/runs/o/r1", "/workspace", "/host/workspace")).toBe("/host/workspace/runs/o/r1");
  });

  it("rejects paths outside the container root", () => {
    expect(() => hostPathFor("/etc/passwd", "/workspace", "/host/workspace")).toThrow(/escapes/);
  });
});

describe("sandboxStateDirectory", () => {
  it("keeps explicit sub-agent state outside its code worktree", () => {
    const worktree = "/workspace/runs/run-1/subagents/api";
    expect(sandboxStateDirectory(worktree, "/workspace/runs/run-1.state/subagents/api"))
      .toBe("/workspace/runs/run-1.state/subagents/api");
    expect(() => sandboxStateDirectory(worktree, `${worktree}/.pi`)).toThrow(/outside worktree/);
  });
});

describe("resolveSandboxMode (P1 fail-closed)", () => {
  it("auto mode uses the container sandbox when the socket answers", async () => {
    expect(await resolveSandboxMode("auto", async () => true)).toEqual({ mode: "container" });
  });

  it("auto mode is unavailable (not process) when the socket is missing", async () => {
    const result = await resolveSandboxMode("auto", async () => { throw new Error("ENOENT"); });
    expect(result.mode).toBe("unavailable");
    expect(result.degraded).toBeUndefined();
    expect(result.reason).toContain("ENOENT");
  });

  it("explicit container mode is fail-closed too when the socket is unusable", async () => {
    const forced = await resolveSandboxMode("container", async () => { throw new Error("EACCES"); });
    expect(forced.mode).toBe("unavailable");
    expect(forced.reason).toContain("EACCES");
  });

  it("keeps an explicit PI_SANDBOX_MODE=process explicit and unflagged", async () => {
    const result = await resolveSandboxMode("process", async () => true);
    expect(result.mode).toBe("process");
    expect(result.degraded).toBeUndefined();
    expect(result.reason).toContain("PI_SANDBOX_MODE=process");
  });

  it("only the explicit degraded opt-in allows the in-process fallback, and it is flagged", async () => {
    const result = await resolveSandboxMode("auto", async () => { throw new Error("ENOENT"); }, { allowDegraded: true });
    expect(result.mode).toBe("process");
    expect(result.degraded).toBe(true);
    expect(result.reason).toContain("ENOENT");
  });
});

describe("parseSandboxAllowDegraded (P1 strict opt-in)", () => {
  it("accepts only the exact literal 1", () => {
    expect(parseSandboxAllowDegraded("1")).toBe(true);
    for (const value of [undefined, "", "0", "true", "TRUE", "yes", "on", " 1", "1 ", "01", "11", "2"]) {
      expect(parseSandboxAllowDegraded(value)).toBe(false);
    }
  });
});

describe("SandboxUnavailableError", () => {
  it("carries the actionable Chinese fail-closed message and the reason", () => {
    const error = new SandboxUnavailableError("docker socket unavailable: ENOENT");
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("SANDBOX_UNAVAILABLE");
    expect(error.message).toContain("fail-closed");
    expect(error.message).toContain("PI_SANDBOX_ALLOW_DEGRADED=1");
    expect(error.message).toContain("ENOENT");
  });
});

type FakeExit = "SIGTERM" | "SIGKILL" | "never";
type FakeRemoval = "ok" | "fail" | "never" | "absent";

/**
 * A sandbox container stub: `wait()` only settles when its exit signal arrives.
 * `journal` records the ordered teardown calls so tests can assert that removal
 * happens *after* the container stopped (or was force-killed).
 */
function fakeSandbox(
  id: string,
  exitsOn: FakeExit = "SIGTERM",
  onStop?: (signal: "SIGTERM" | "SIGKILL") => void,
  removal: FakeRemoval = "ok",
) {
  const signals: Array<"SIGTERM" | "SIGKILL"> = [];
  const journal: string[] = [];
  let removals = 0;
  let release: () => void = () => undefined;
  const exited = new Promise<void>((resolve) => { release = resolve; });
  const handle: SandboxContainerHandle = {
    id,
    stop: async (signal) => {
      signals.push(signal);
      journal.push(`stop:${signal}`);
      onStop?.(signal);
      if (exitsOn === signal) release();
    },
    wait: () => exited,
  };
  if (removal !== "absent") {
    handle.remove = () => {
      removals += 1;
      journal.push("remove");
      if (removal === "fail") return Promise.reject(new Error(`cannot remove ${id}`));
      if (removal === "never") return new Promise(() => undefined);
      return Promise.resolve();
    };
  }
  return { handle, signals, journal, get removals() { return removals; } };
}

describe("SandboxContainerRegistry (P1 shutdown)", () => {
  it("tracks containers until they are forgotten", () => {
    const registry = new SandboxContainerRegistry();
    const forget = registry.add(fakeSandbox("c1").handle);
    expect(registry.running()).toEqual(["c1"]);
    expect(registry.size).toBe(1);
    forget();
    expect(registry.size).toBe(0);
  });

  it("stops with SIGTERM, force-kills only what survives, and removes both", async () => {
    const polite = fakeSandbox("c1", "SIGTERM");
    const stubborn = fakeSandbox("c2", "SIGKILL");
    const registry = new SandboxContainerRegistry();
    registry.add(polite.handle);
    registry.add(stubborn.handle);

    const result = await registry.stopAll({ graceMs: 30, forceKillGraceMs: 30 });

    expect(result.stopped).toEqual(["c1"]);
    expect(result.forced).toEqual(["c2"]);
    expect(result.unconfirmed).toEqual([]);
    expect(polite.signals).toEqual(["SIGTERM"]);
    expect(stubborn.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(result.removed?.slice().sort()).toEqual(["c1", "c2"]);
    expect(result.removalFailed).toEqual([]);
    expect(registry.size).toBe(0);
  });

  it("removes a container only after it stopped or was force-killed (AUD follow-up)", async () => {
    const polite = fakeSandbox("c1", "SIGTERM");
    const stubborn = fakeSandbox("c2", "SIGKILL");
    const registry = new SandboxContainerRegistry();
    registry.add(polite.handle);
    registry.add(stubborn.handle);

    const result = await registry.stopAll({ graceMs: 30, forceKillGraceMs: 30 });

    expect(polite.journal).toEqual(["stop:SIGTERM", "remove"]);
    expect(stubborn.journal).toEqual(["stop:SIGTERM", "stop:SIGKILL", "remove"]);
    expect(polite.removals).toBe(1);
    expect(stubborn.removals).toBe(1);
    expect(result.removed?.slice().sort()).toEqual(["c1", "c2"]);
  });

  it("reports a failed or hanging removal and still completes teardown (never throws/hangs)", async () => {
    const failing = fakeSandbox("c1", "SIGTERM", undefined, "fail");
    const hanging = fakeSandbox("c2", "SIGTERM", undefined, "never");
    const registry = new SandboxContainerRegistry();
    registry.add(failing.handle);
    registry.add(hanging.handle);

    const started = Date.now();
    const result = await registry.stopAll({ graceMs: 30, forceKillGraceMs: 30, removalTimeoutMs: 20 });

    expect(result.stopped.slice().sort()).toEqual(["c1", "c2"]);
    expect(result.removed).toEqual([]);
    expect(result.removalFailed?.map((failure) => failure.id).sort()).toEqual(["c1", "c2"]);
    expect(result.removalFailed?.find((failure) => failure.id === "c1")?.error).toContain("cannot remove c1");
    expect(result.removalFailed?.find((failure) => failure.id === "c2")?.error).toContain("20ms");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(registry.size).toBe(0);
  });

  it("skips (without failing) handles that predate the removal hook", async () => {
    const legacy = fakeSandbox("c1", "SIGTERM", undefined, "absent");
    const registry = new SandboxContainerRegistry();
    registry.add(legacy.handle);

    const result = await registry.stopAll({ graceMs: 30, forceKillGraceMs: 30 });

    expect(result.stopped).toEqual(["c1"]);
    expect(result.removed).toEqual([]);
    expect(result.removalFailed).toEqual([]);
    expect(registry.size).toBe(0);
  });

  it("is idempotent: concurrent and repeated stopAll calls run one teardown (one removal)", async () => {
    const sandbox = fakeSandbox("c1", "SIGTERM");
    const registry = new SandboxContainerRegistry();
    registry.add(sandbox.handle);

    const [first, second] = await Promise.all([
      registry.stopAll({ graceMs: 30 }),
      registry.stopAll({ graceMs: 30 }),
    ]);
    const third = await registry.stopAll({ graceMs: 30 });

    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(sandbox.signals).toEqual(["SIGTERM"]);
    expect(sandbox.removals).toBe(1);
    expect(first.removed).toEqual(["c1"]);
  });

  it("gives up on a stuck sandbox within the bounded timeout and still removes it", async () => {
    const stuck = fakeSandbox("stuck", "never");
    const registry = new SandboxContainerRegistry();
    registry.add(stuck.handle);

    const started = Date.now();
    const result = await registry.stopAll({ graceMs: 20, forceKillGraceMs: 20 });

    expect(result.forced).toEqual(["stuck"]);
    expect(result.unconfirmed).toEqual(["stuck"]);
    expect(stuck.signals).toEqual(["SIGTERM", "SIGKILL"]);
    // A stuck container is still handed to `remove` (a forced remove kills it).
    expect(result.removed).toEqual(["stuck"]);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("force-kills and removes a sandbox that starts while teardown is still running", async () => {
    const registry = new SandboxContainerRegistry();
    const late = fakeSandbox("late", "SIGKILL");
    const first = fakeSandbox("c1", "SIGTERM", (signal) => {
      // A still-active job starts another sandbox during the grace wait.
      if (signal === "SIGTERM") registry.add(late.handle);
    });
    registry.add(first.handle);

    const result = await registry.stopAll({ graceMs: 30, forceKillGraceMs: 30 });

    expect(result.stopped).toEqual(["c1"]);
    expect(result.forced).toEqual(["late"]);
    expect(late.signals).toEqual(["SIGKILL"]);
    expect(late.journal).toEqual(["stop:SIGKILL", "remove"]);
    expect(result.removed?.slice().sort()).toEqual(["c1", "late"]);
    expect(registry.size).toBe(0);
  });

  it("resolves immediately with an empty result when nothing is running", async () => {
    expect(await new SandboxContainerRegistry().stopAll())
      .toEqual({ stopped: [], forced: [], unconfirmed: [], removed: [], removalFailed: [] });
  });
});

describe("createShutdownHandler (P1 worker exit)", () => {
  function deps(overrides: Partial<Parameters<typeof createShutdownHandler>[0]> = {}) {
    const order: string[] = [];
    const exitCodes: number[] = [];
    const logs: string[] = [];
    const shutdown = createShutdownHandler({
      stopClaiming: () => { order.push("stopClaiming"); },
      stopSandboxes: async () => {
        order.push("stopSandboxes");
        return { stopped: ["c1"], forced: [], unconfirmed: [], removed: ["c1"], removalFailed: [] };
      },
      releaseLocks: () => { order.push("releaseLocks"); },
      exit: (code) => { order.push(`exit:${code}`); exitCodes.push(code); },
      log: (message) => { logs.push(message); },
      ...overrides,
    });
    return { shutdown, order, exitCodes, logs };
  }

  it("stops claiming, reclaims sandboxes, releases locks, then exits (SIGTERM=143)", async () => {
    const { shutdown, order } = deps();
    await shutdown("SIGTERM");
    expect(order).toEqual(["stopClaiming", "stopSandboxes", "releaseLocks", "exit:143"]);
  });

  it("uses exit code 130 for SIGINT", async () => {
    const { shutdown, exitCodes } = deps();
    await shutdown("SIGINT");
    expect(exitCodes).toEqual([130]);
  });

  it("reports removals (and removal failures) in the shutdown log", async () => {
    const { shutdown, logs } = deps({
      stopSandboxes: async () => ({
        stopped: ["c1"],
        forced: [],
        unconfirmed: [],
        removed: ["c1"],
        removalFailed: [{ id: "c2", error: "docker API unavailable" }],
      }),
    });
    await shutdown("SIGTERM");
    expect(logs.join("\n")).toContain("已移除 1 个");
    expect(logs.join("\n")).toContain("移除失败 1 个");
  });

  it("ignores repeated signals while a teardown is in flight", async () => {
    const order: string[] = [];
    const exitCodes: number[] = [];
    const logs: string[] = [];
    let stopCalls = 0;
    let finishStop: ((value: { stopped: string[]; forced: string[]; unconfirmed: string[] }) => void) | undefined;
    const shutdown = createShutdownHandler({
      stopClaiming: () => { order.push("stopClaiming"); },
      stopSandboxes: () => {
        stopCalls += 1;
        return new Promise((resolve) => { finishStop = resolve; });
      },
      releaseLocks: () => { order.push("releaseLocks"); },
      exit: (code) => { exitCodes.push(code); },
      log: (message) => { logs.push(message); },
    });

    const first = shutdown("SIGTERM");
    const second = shutdown("SIGTERM");
    expect(second).toBe(first);
    await Promise.resolve();
    expect(stopCalls).toBe(1);
    expect(exitCodes).toEqual([]);

    finishStop?.({ stopped: [], forced: [], unconfirmed: [] });
    await first;
    expect(stopCalls).toBe(1);
    expect(exitCodes).toEqual([143]);
    expect(logs.join("\n")).toContain("忽略重复的 SIGTERM");
  });

  it("still exits (bounded) when the sandbox stop never resolves", async () => {
    const { shutdown, exitCodes, logs } = deps({
      stopSandboxes: () => new Promise(() => undefined),
      timeoutMs: 20,
    });
    await shutdown("SIGTERM");
    expect(exitCodes).toEqual([143]);
    expect(logs.join("\n")).toContain("20ms");
  });

  it("releases locks and exits even when the sandbox stop throws", async () => {
    const { shutdown, order, exitCodes, logs } = deps({
      stopSandboxes: async () => { throw new Error("docker down"); },
    });
    await shutdown("SIGTERM");
    expect(order).toEqual(["stopClaiming", "releaseLocks", "exit:143"]);
    expect(exitCodes).toEqual([143]);
    expect(logs.join("\n")).toContain("docker down");
  });
});

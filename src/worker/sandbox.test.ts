import { describe, expect, it } from "vitest";
import {
  awaitSandboxExit,
  buildContainerSpec,
  createShutdownHandler,
  DEFAULT_SANDBOX_FORCE_KILL_GRACE_MS,
  DEFAULT_SANDBOX_REMOVAL_TIMEOUT_MS,
  DEFAULT_SANDBOX_STOP_GRACE_MS,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  hostPathFor,
  isContainerGoneError,
  MAX_SANDBOX_TEARDOWN_PASSES,
  parseSandboxAllowDegraded,
  resolveSandboxMode,
  SANDBOX_TEARDOWN_MARGIN_MS,
  SandboxClosingError,
  SandboxContainerRegistry,
  sandboxTeardownBudgetMs,
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
type FakeRemoval = "ok" | "fail" | "never" | "absent" | "gone";
type FakeWaitFailure = "gone" | "other";

/** The Docker error a force-remove races into a pending wait/remove. */
function goneError(id: string, path = "wait"): Error {
  return new Error(`Docker API POST /containers/${id}/${path} failed: 404 {"message":"No such container: ${id}"}`);
}

/**
 * A sandbox container stub: `wait()` only settles when its exit signal arrives.
 * `journal` records the ordered teardown calls so tests can assert that removal
 * happens *after* the container stopped (or was force-killed).
 *
 * `waitFailure` models the wait-vs-remove race: once SIGKILL was sent the wait
 * rejects the way Docker answers a wait on a container that was force-removed.
 */
function fakeSandbox(
  id: string,
  exitsOn: FakeExit = "SIGTERM",
  onStop?: (signal: "SIGTERM" | "SIGKILL") => void,
  removal: FakeRemoval = "ok",
  waitFailure?: FakeWaitFailure,
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
    wait: () => {
      if (waitFailure === "gone" && signals.includes("SIGKILL")) return Promise.reject(goneError(id));
      if (waitFailure === "other") return Promise.reject(new Error(`docker unavailable for ${id}`));
      return exited;
    },
  };
  if (removal !== "absent") {
    handle.remove = () => {
      removals += 1;
      journal.push("remove");
      if (removal === "fail") return Promise.reject(new Error(`cannot remove ${id}`));
      if (removal === "gone") return Promise.reject(goneError(id, "remove"));
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
    expect(result.unconfirmedReasons?.find((failure) => failure.id === "stuck")?.error).toContain("20ms");
    expect(stuck.signals).toEqual(["SIGTERM", "SIGKILL"]);
    // A stuck container is still handed to `remove` (a forced remove kills it).
    expect(result.removed).toEqual(["stuck"]);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("sweeps a sandbox registered during the second pass (never misses a live one)", async () => {
    const registry = new SandboxContainerRegistry();
    const newest = fakeSandbox("newest", "SIGKILL");
    const late = fakeSandbox("late", "SIGKILL", (signal) => {
      // Registered while pass 2 force-kills: a fixed two-pass teardown never
      // swept this handle and it stayed tracked (and alive) forever.
      if (signal === "SIGKILL") registry.add(newest.handle);
    });
    const first = fakeSandbox("first", "SIGTERM", (signal) => {
      // Pass-1 late arrival, the case the second pass was originally added for.
      if (signal === "SIGTERM") registry.add(late.handle);
    });
    registry.add(first.handle);

    const result = await registry.stopAll({ graceMs: 30, forceKillGraceMs: 30 });

    expect(result.stopped).toEqual(["first"]);
    expect(result.forced.slice().sort()).toEqual(["late", "newest"]);
    expect(result.removed?.slice().sort()).toEqual(["first", "late", "newest"]);
    expect(newest.signals).toEqual(["SIGKILL"]);
    expect(newest.removals).toBe(1);
    expect(registry.size).toBe(0);
    expect(registry.closing).toBe(true);
  });

  it("refuses a registration after teardown finished and still tears the refused container down", async () => {
    const registry = new SandboxContainerRegistry();
    await registry.stopAll({ graceMs: 30, forceKillGraceMs: 30 });

    const late = fakeSandbox("late", "SIGKILL");
    const other = fakeSandbox("other", "SIGKILL");
    expect(() => registry.add(late.handle)).toThrow(SandboxClosingError);
    expect(() => registry.add(other.handle)).toThrow(/拒绝登记/);

    // Refusing must not orphan the container: it is not tracked, and its
    // forced teardown is kicked off best effort (on a microtask).
    expect(registry.size).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(late.signals).toEqual(["SIGKILL"]);
    expect(other.signals).toEqual(["SIGKILL"]);
    expect(late.removals).toBe(1);
    expect(other.removals).toBe(1);
  });

  it("terminates at the pass cap without closing while a sandbox is still tracked", async () => {
    // A pathological producer that registers a new sandbox every time one is
    // force-killed: teardown must stop after MAX_SANDBOX_TEARDOWN_PASSES, refuse
    // (and tear down) the newcomer, and leave nothing tracked.
    const registry = new SandboxContainerRegistry();
    const chain: Array<ReturnType<typeof fakeSandbox>> = [];
    const link = (index: number): SandboxContainerHandle => {
      if (index > MAX_SANDBOX_TEARDOWN_PASSES + 1) return fakeSandbox(`end-${index}`, "SIGKILL").handle;
      const node = fakeSandbox(`c${index}`, "SIGKILL", (signal) => {
        if (signal === "SIGKILL") registry.add(link(index + 1));
      });
      chain.push(node);
      return node.handle;
    };
    registry.add(link(0));

    const result = await registry.stopAll({ graceMs: 5, forceKillGraceMs: 5, removalTimeoutMs: 5 });

    expect(chain.length).toBeGreaterThan(MAX_SANDBOX_TEARDOWN_PASSES);
    expect(registry.size).toBe(0);
    expect(registry.closing).toBe(true);
    // The sandbox created after the cap was refused, but still torn down.
    const refused = chain[chain.length - 1];
    expect(refused.signals).toEqual(["SIGKILL"]);
    expect(refused.removals).toBe(1);
    expect(result.removed).toContain(`c${MAX_SANDBOX_TEARDOWN_PASSES}`);
  });

  it("treats a wait that ends because the container was concurrently removed as confirmed-removed", async () => {
    // Survives SIGTERM; while its SIGKILL wait is pending the teardown force-
    // removes the container, so Docker answers the wait with 404 "No such
    // container" instead of an exit code. That is a confirmed-removed outcome,
    // never an unexplained unconfirmed one.
    const raced = fakeSandbox("raced", "never", undefined, "ok", "gone");
    const registry = new SandboxContainerRegistry();
    registry.add(raced.handle);

    const result = await registry.stopAll({ graceMs: 20, forceKillGraceMs: 20, removalTimeoutMs: 20 });

    expect(raced.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(result.forced).toEqual(["raced"]);
    expect(result.unconfirmed).toEqual([]);
    expect(result.unconfirmedReasons).toEqual([]);
    expect(result.removed).toEqual(["raced"]);
    expect(result.removalFailed).toEqual([]);
    // Already gone: no second removal is attempted.
    expect(raced.removals).toBe(0);
    expect(registry.size).toBe(0);
  });

  it("treats a removal that finds the container already gone as removed, not failed", async () => {
    const raced = fakeSandbox("c1", "SIGTERM", undefined, "gone");
    const registry = new SandboxContainerRegistry();
    registry.add(raced.handle);

    const result = await registry.stopAll({ graceMs: 30, forceKillGraceMs: 30 });

    expect(result.stopped).toEqual(["c1"]);
    expect(result.removed).toEqual(["c1"]);
    expect(result.removalFailed).toEqual([]);
  });

  it("reports an unconfirmed container with the reason its wait failed", async () => {
    const broken = fakeSandbox("c1", "never", undefined, "ok", "other");
    const registry = new SandboxContainerRegistry();
    registry.add(broken.handle);

    const result = await registry.stopAll({ graceMs: 20, forceKillGraceMs: 20, removalTimeoutMs: 20 });

    expect(result.forced).toEqual(["c1"]);
    expect(result.unconfirmed).toEqual(["c1"]);
    expect(result.unconfirmedReasons).toEqual([{ id: "c1", error: "docker unavailable for c1" }]);
    expect(result.removed).toEqual(["c1"]);
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
      .toEqual({ stopped: [], forced: [], unconfirmed: [], removed: [], removalFailed: [], unconfirmedReasons: [] });
  });
});

describe("sandbox shutdown budget (AUD: teardown had no slack)", () => {
  it("covers two full teardown passes plus a margin", () => {
    const phases = DEFAULT_SANDBOX_STOP_GRACE_MS + DEFAULT_SANDBOX_FORCE_KILL_GRACE_MS + DEFAULT_SANDBOX_REMOVAL_TIMEOUT_MS;
    // Regression guard: the default used to equal exactly one phase sum (20s), so
    // a fully stuck teardown was cut off before its removal pass and containers
    // lingered on the host.
    expect(DEFAULT_SHUTDOWN_TIMEOUT_MS).toBeGreaterThan(phases);
    expect(DEFAULT_SHUTDOWN_TIMEOUT_MS).toBe(sandboxTeardownBudgetMs());
    expect(DEFAULT_SHUTDOWN_TIMEOUT_MS).toBe(2 * phases + SANDBOX_TEARDOWN_MARGIN_MS);
    expect(sandboxTeardownBudgetMs({ graceMs: 1_000, forceKillGraceMs: 2_000, removalTimeoutMs: 3_000 }))
      .toBe(2 * 6_000 + SANDBOX_TEARDOWN_MARGIN_MS);
    expect(sandboxTeardownBudgetMs({ removalTimeoutMs: 0 }))
      .toBe(2 * (DEFAULT_SANDBOX_STOP_GRACE_MS + DEFAULT_SANDBOX_FORCE_KILL_GRACE_MS) + SANDBOX_TEARDOWN_MARGIN_MS);
    expect(MAX_SANDBOX_TEARDOWN_PASSES).toBeGreaterThanOrEqual(2);
  });
});

describe("awaitSandboxExit / isContainerGoneError (AUD: wait-vs-remove race)", () => {
  it("resolves a normal exit with its value", async () => {
    expect(await awaitSandboxExit(async () => ({ StatusCode: 0 })))
      .toEqual({ outcome: "exited", value: { StatusCode: 0 } });
  });

  it("resolves a wait that lost the container to a concurrent removal as removed", async () => {
    const outcome = await awaitSandboxExit(async () => { throw goneError("c1"); });
    expect(outcome.outcome).toBe("removed");
    if (outcome.outcome !== "removed") throw new Error("expected removed");
    expect(outcome.error).toContain("No such container");
  });

  it("still reports an unrelated wait failure as failed", async () => {
    expect(await awaitSandboxExit(async () => { throw new Error("socket hang up"); }))
      .toEqual({ outcome: "failed", error: "socket hang up" });
  });

  it("recognises only 404 / no-such-container as gone", () => {
    expect(isContainerGoneError(goneError("c1"))).toBe(true);
    expect(isContainerGoneError(goneError("c1", "remove"))).toBe(true);
    expect(isContainerGoneError(new Error("Docker API POST /containers/c1/kill failed: 409 container c1 is not running"))).toBe(false);
    expect(isContainerGoneError(new Error("socket hang up"))).toBe(false);
  });
});

describe("createShutdownHandler (P1 worker exit)", () => {
  function deps(overrides: Partial<Parameters<typeof createShutdownHandler>[0]> = {}) {
    const order: string[] = [];
    const exitCodes: number[] = [];
    const logs: string[] = [];
    // Wrapped so an override still records the "stopSandboxes" step in `order`.
    const { stopSandboxes, ...rest } = overrides;
    const shutdown = createShutdownHandler({
      stopClaiming: () => { order.push("stopClaiming"); },
      stopSandboxes: async () => {
        order.push("stopSandboxes");
        return stopSandboxes
          ? await stopSandboxes()
          : { stopped: ["c1"], forced: [], unconfirmed: [], removed: ["c1"], removalFailed: [] };
      },
      releaseLocks: () => { order.push("releaseLocks"); },
      exit: (code) => { order.push(`exit:${code}`); exitCodes.push(code); },
      log: (message) => { logs.push(message); },
      ...rest,
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

  it("still releases locks and exits (bounded) when the sandbox stop never resolves", async () => {
    const { shutdown, order, exitCodes, logs } = deps({
      stopSandboxes: () => new Promise(() => undefined),
      timeoutMs: 20,
    });
    await shutdown("SIGTERM");
    // The sandbox phases exhausting the budget must not skip lock release or exit.
    expect(order).toEqual(["stopClaiming", "stopSandboxes", "releaseLocks", "exit:143"]);
    expect(exitCodes).toEqual([143]);
    expect(logs.join("\n")).toContain("20ms");
  });

  it("runs the removal pass for a stuck sandbox inside the default shutdown bound", async () => {
    const stuck = fakeSandbox("stuck", "never");
    const registry = new SandboxContainerRegistry();
    registry.add(stuck.handle);
    const { shutdown, order, logs } = deps({
      stopSandboxes: () => registry.stopAll({ graceMs: 20, forceKillGraceMs: 20, removalTimeoutMs: 20 }),
    });
    await shutdown("SIGTERM");
    // The bound must not cut the teardown off before its removal pass: the stuck
    // container is still handed to `remove`.
    expect(stuck.removals).toBe(1);
    expect(logs.join("\n")).toContain("已移除 1 个");
    expect(order).toEqual(["stopClaiming", "stopSandboxes", "releaseLocks", "exit:143"]);
  });

  it("still releases locks and exits even when releasing locks throws", async () => {
    const { shutdown, order, exitCodes, logs } = deps({
      releaseLocks: () => { order.push("releaseLocks"); throw new Error("lock store down"); },
    });
    await shutdown("SIGTERM");
    expect(order).toEqual(["stopClaiming", "stopSandboxes", "releaseLocks", "exit:143"]);
    expect(exitCodes).toEqual([143]);
    expect(logs.join("\n")).toContain("lock store down");
  });

  it("releases locks and exits even when the sandbox stop throws", async () => {
    const { shutdown, order, exitCodes, logs } = deps({
      stopSandboxes: async () => { throw new Error("docker down"); },
    });
    await shutdown("SIGTERM");
    expect(order).toEqual(["stopClaiming", "stopSandboxes", "releaseLocks", "exit:143"]);
    expect(exitCodes).toEqual([143]);
    expect(logs.join("\n")).toContain("docker down");
  });
});

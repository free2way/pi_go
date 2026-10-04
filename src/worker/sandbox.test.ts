import { describe, expect, it } from "vitest";
import { buildContainerSpec, hostPathFor, resolveSandboxMode } from "./sandbox.js";

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

describe("resolveSandboxMode", () => {
  it("auto mode uses the container sandbox when the socket answers", async () => {
    expect(await resolveSandboxMode("auto", async () => true)).toEqual({ mode: "container" });
  });

  it("auto mode falls back to in-process execution when the socket is missing", async () => {
    const result = await resolveSandboxMode("auto", async () => { throw new Error("ENOENT"); });
    expect(result.mode).toBe("process");
    expect(result.reason).toContain("ENOENT");
  });

  it("respects an explicit mode and reports an unusable socket instead of degrading", async () => {
    expect((await resolveSandboxMode("process", async () => true)).mode).toBe("process");
    const forced = await resolveSandboxMode("container", async () => { throw new Error("EACCES"); });
    expect(forced.mode).toBe("container");
    expect(forced.reason).toContain("EACCES");
  });
});

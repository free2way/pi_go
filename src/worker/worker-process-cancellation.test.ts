import { beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  docker: { createContainer: vi.fn(), startContainer: vi.fn(), killContainer: vi.fn(), removeContainer: vi.fn(),
    waitContainer: vi.fn(), logsFollow: vi.fn() }, forget: vi.fn(), add: vi.fn(),
}));
vi.mock("./worker-runtime.js", () => ({
  docker: fixture.docker, sandboxContainers: { add: fixture.add }, sandboxExtraEnv: [], sandboxExtraBinds: [],
  imageForSandbox: "fixture-sandbox", sandboxUser: "node", workspaceRoot: "/workspace", hostWorkspaceRoot: "/workspace", maxOutput: 48000,
}));
vi.mock("./sandbox.js", async original => ({
  ...await original<typeof import("./sandbox.js")>(),
  withSandboxStateDirectory: async (_input: unknown, execute: (state: string) => Promise<unknown>) => execute("/workspace/runs/fixture.state"),
}));
import { runInSandbox } from "./worker-process.js";

beforeEach(() => {
  vi.resetAllMocks();
  fixture.docker.createContainer.mockResolvedValue("fixture-id");
  fixture.docker.startContainer.mockResolvedValue(undefined);
  fixture.docker.killContainer.mockResolvedValue(undefined);
  fixture.docker.removeContainer.mockResolvedValue(undefined);
  fixture.docker.waitContainer.mockResolvedValue({ StatusCode: 0 });
  fixture.docker.logsFollow.mockResolvedValue(undefined);
  fixture.add.mockReturnValue(fixture.forget);
});
const execute = (controller: AbortController) => runInSandbox({ argv: ["node", "-e", "0"], worktree: "/workspace/runs/fixture",
  env: {}, network: "none", timeoutMs: 0, signal: controller.signal, label: "checks" });

it("does not create a sandbox after cancellation was already requested", async () => {
  const controller = new AbortController(); controller.abort();
  await expect(execute(controller)).rejects.toThrow("cancelled");
  expect(fixture.docker.createContainer).not.toHaveBeenCalled();
});
it("removes a sandbox cancelled during creation without starting its command", async () => {
  const controller = new AbortController();
  fixture.docker.createContainer.mockImplementationOnce(async () => { controller.abort(); return "fixture-id"; });
  await expect(execute(controller)).rejects.toThrow("cancelled");
  expect(fixture.docker.startContainer).not.toHaveBeenCalled();
  expect(fixture.docker.removeContainer).toHaveBeenCalledWith("fixture-id");
  expect(fixture.forget).toHaveBeenCalledOnce();
});
it("force-removes when cancellation races a start and its first kill fails", async () => {
  const controller = new AbortController();
  fixture.docker.killContainer.mockRejectedValueOnce(new Error("container not running yet"));
  fixture.docker.startContainer.mockImplementationOnce(async () => { controller.abort(); });
  await expect(execute(controller)).rejects.toThrow("cancelled");
  expect(fixture.docker.killContainer).toHaveBeenCalledWith("fixture-id");
  expect(fixture.docker.removeContainer).toHaveBeenCalledWith("fixture-id");
  expect(fixture.docker.waitContainer).not.toHaveBeenCalled();
  expect(fixture.forget).toHaveBeenCalledOnce();
});

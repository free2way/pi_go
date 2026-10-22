import { afterEach, describe, expect, it } from "vitest";
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { migrateLegacySubAgentState, subAgentStateDirectory, subAgentStateRoot } from "./subagent-state.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "subagent-state-test-"));
  roots.push(root);
  const worktree = path.join(root, "run-fixture");
  const developer = `${worktree}.state`;
  const legacy = path.join(developer, "subagents");
  const target = subAgentStateRoot(worktree);
  await mkdir(worktree);
  return { root, worktree, developer, legacy, target };
}

describe("sub-agent state boundary", () => {
  it("places each child outside both source and Developer state mounts", () => {
    const worktree = path.resolve("/workspace/runs/run-fixture");
    const child = subAgentStateDirectory(worktree, "task-a");
    expect(child).toBe(`${worktree}.subagent-state/task-a`);
    expect(path.relative(worktree, child)).toMatch(/^\.\./);
    expect(path.relative(`${worktree}.state`, child)).toMatch(/^\.\./);
    expect(child).not.toBe(subAgentStateDirectory(worktree, "task-b"));
  });

  it.each(["", "..", "../task", "task/child", "task\\child", "A", "a".repeat(33)])("rejects unsafe task id %s", (id) => {
    expect(() => subAgentStateDirectory("/workspace/runs/run-fixture", id)).toThrow("Invalid sub-agent state id");
  });

  it("does nothing for a fresh run", async () => {
    const { worktree, target } = await fixture();
    expect(await migrateLegacySubAgentState(worktree)).toBe(false);
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("moves complete legacy sessions without exposing them through Developer state", async () => {
    const { worktree, developer, legacy, target } = await fixture();
    await mkdir(path.join(developer, "agent"), { recursive: true });
    await writeFile(path.join(developer, "agent", "auth.json"), "DUMMY_MAIN_STATE");
    for (const id of ["task-a", "task-b"]) {
      await mkdir(path.join(legacy, id, "agent", "sessions"), { recursive: true });
      await writeFile(path.join(legacy, id, "agent", "auth.json"), "DUMMY_CHILD_STATE");
      await writeFile(path.join(legacy, id, "agent", "sessions", "session.jsonl"), "DUMMY_SESSION");
    }
    expect(await migrateLegacySubAgentState(worktree)).toBe(true);
    for (const id of ["task-a", "task-b"]) {
      const state = subAgentStateDirectory(worktree, id);
      expect(await readFile(path.join(state, "agent", "auth.json"), "utf8")).toBe("DUMMY_CHILD_STATE");
      expect(await readFile(path.join(state, "agent", "sessions", "session.jsonl"), "utf8")).toBe("DUMMY_SESSION");
    }
    await expect(stat(legacy)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(developer, "agent", "auth.json"), "utf8")).toBe("DUMMY_MAIN_STATE");
    expect(await migrateLegacySubAgentState(worktree)).toBe(false);
    expect((await stat(target)).isDirectory()).toBe(true);
  });

  it("refuses to merge or overwrite conflicting trees", async () => {
    const { worktree, legacy, target } = await fixture();
    await mkdir(legacy, { recursive: true });
    await mkdir(target);
    await writeFile(path.join(legacy, "keep"), "legacy");
    await writeFile(path.join(target, "keep"), "isolated");
    await expect(migrateLegacySubAgentState(worktree)).rejects.toThrow(/manual review/);
    expect(await readFile(path.join(legacy, "keep"), "utf8")).toBe("legacy");
    expect(await readFile(path.join(target, "keep"), "utf8")).toBe("isolated");
  });

  it.each(["developer", "legacy", "target"] as const)("rejects a symlink at the %s root without following it", async (kind) => {
    const f = await fixture();
    const outside = path.join(f.root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "keep"), "unchanged");
    if (kind === "legacy") await mkdir(f.developer);
    await symlink(outside, f[kind]);
    await expect(migrateLegacySubAgentState(f.worktree)).rejects.toThrow(/state|directory/);
    expect(await readFile(path.join(outside, "keep"), "utf8")).toBe("unchanged");
  });

  it("rejects nested symlinks and leaves the legacy tree intact", async () => {
    const { worktree, legacy, target, root } = await fixture();
    await mkdir(path.join(legacy, "task-a", "agent"), { recursive: true });
    const outside = path.join(root, "outside");
    await writeFile(outside, "DUMMY_EXTERNAL");
    await symlink(outside, path.join(legacy, "task-a", "agent", "auth.json"));
    await expect(migrateLegacySubAgentState(worktree)).rejects.toThrow(/manual review/);
    expect(await readFile(outside, "utf8")).toBe("DUMMY_EXTERNAL");
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects cross-state hard links without moving either copy", async () => {
    const { worktree, legacy, developer, target } = await fixture();
    await mkdir(path.join(legacy, "task-a"), { recursive: true });
    const original = path.join(developer, "keep");
    await writeFile(original, "DUMMY_SHARED");
    await link(original, path.join(legacy, "task-a", "auth.json"));
    await expect(migrateLegacySubAgentState(worktree)).rejects.toThrow(/manual review/);
    expect(await readFile(original, "utf8")).toBe("DUMMY_SHARED");
    expect(await readFile(path.join(legacy, "task-a", "auth.json"), "utf8")).toBe("DUMMY_SHARED");
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

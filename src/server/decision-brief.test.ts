import { describe, expect, it } from "vitest";
import { findingFingerprint } from "../shared/finding-fingerprint.js";
import type { CheckResult, Finding, Run, RunEvent } from "../shared/types.js";
import { newId } from "./db.js";
import { collectDecisionBriefInput, readDecisionBrief } from "./decision-brief.js";
import { baseRealRun } from "./real-run.js";
import { PostgresRunStore } from "./run-store-pg.js";
import { createTestDb } from "./test-db.js";

const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();

function makeRun(overrides: Partial<Run> = {}): Run {
  const run = baseRealRun(
    {
      title: "决策摘要测试",
      task: "为决策摘要构造测试数据。",
      repository: "/srv/workspace/pi_go",
      workspaceId: "ws_1",
      mode: "real",
      checks: ["npm test"],
    },
    "owner_1",
  );
  return { ...run, state: "needs_human", round: 2, maxRounds: 3, ...overrides };
}

function check(overrides: Partial<CheckResult> = {}): CheckResult {
  return { id: "check-1", name: "单元测试", command: "npm test", status: "passed", durationMs: 1200, exitCode: 0, ...overrides };
}

function finding(overrides: Partial<Finding> = {}): Finding {
  const base: Finding = {
    id: "f1",
    severity: "high",
    file: "src/server/credential-vault.ts",
    line: 42,
    title: "凭据隔离缺失",
    evidence: "日志中出现了完整 API Key，未做脱敏处理",
    requiredChange: "写入日志前必须脱敏",
    resolved: false,
    consecutiveRounds: 1,
  };
  return { ...base, ...overrides };
}

const diff = [
  "diff --git a/src/server/credential-vault.ts b/src/server/credential-vault.ts",
  "--- a/src/server/credential-vault.ts",
  "+++ b/src/server/credential-vault.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
].join("\n");

async function event(store: PostgresRunStore, run: Run, overrides: Partial<Omit<RunEvent, "seq">> & { type: string; message: string }): Promise<void> {
  await store.appendEvent({ runId: run.id, round: run.round, source: "system", at: at(1), ...overrides });
}

/** Links a story with AC/DoD to the run so the aggregation reads real rows. */
async function linkStory(
  db: Awaited<ReturnType<typeof createTestDb>>,
  run: Run,
  input: { acceptanceCriteria: string[]; definitionOfDone?: string[] },
): Promise<void> {
  const projectId = newId("proj");
  const storyId = newId("story");
  await db.query(
    "INSERT INTO agile_projects (id, owner_id, name, project_key, description, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [projectId, "owner_1", "项目", projectId.slice(-6), "", at(0), at(0)],
  );
  await db.query(
    `INSERT INTO agile_stories (id, project_id, owner_id, title, description, acceptance_criteria_json, priority, definition_of_done_json, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [storyId, projectId, "owner_1", "故事", "", JSON.stringify(input.acceptanceCriteria), "should", JSON.stringify(input.definitionOfDone ?? []), "in_progress", at(0), at(0)],
  );
  await db.query("INSERT INTO story_runs (story_id, run_id, created_at) VALUES ($1, $2, $3)", [storyId, run.id, at(0)]);
}

describe("decision brief aggregation (docs/22 §6)", () => {
  it("builds a needs_human-by-max-rounds brief with a persisting blocker", async () => {
    const db = await createTestDb();
    const store = new PostgresRunStore(db);
    const run = makeRun({
      checks: [check()],
      diff,
      findings: [
        finding({ consecutiveRounds: 2, firstSeenRound: 1, lastSeenRound: 2, fingerprint: findingFingerprint({ file: "src/server/credential-vault.ts", title: "凭据隔离缺失" }) }),
      ],
    });
    await store.createRun(run, { runId: run.id, round: 1, source: "system", type: "run.created", message: "created", at: at(0) });
    await event(store, run, { type: "run.needs_human", message: "达到最大审核轮次", meta: { findings: [finding()], diff: "xxx", durationMs: 9 } });
    await linkStory(db, run, { acceptanceCriteria: ["修改 src/server/credential-vault.ts 实现凭据隔离：API Key 不得写入日志"] });

    const brief = await readDecisionBrief(db, run);

    expect(brief.stopReason.code).toBe("max_review_rounds");
    expect(brief.stopReason.message).toBe("达到最大审核轮次");
    expect(brief.stopReason.meta).toEqual({ durationMs: 9 });
    expect(brief.gates.map((gate) => gate.id)).toEqual(["checks", "blocking", "scope", "acceptance"]);
    expect(brief.gates.find((gate) => gate.id === "checks")?.status).toBe("green");
    const blocking = brief.gates.find((gate) => gate.id === "blocking");
    expect(blocking?.status).toBe("red");
    expect(blocking?.findings?.[0]?.key).toBe("src/server/credential-vault.ts|凭据隔离缺失");
    expect(brief.remaining).toHaveLength(1);
    expect(brief.remaining[0]).toMatchObject({ severity: "high", streak: 2, ac: "AC#1", evidenceOk: true });
    expect(brief.recommendation.action).toBe("continue");
    expect(brief.recommendation.note).toContain("src/server/credential-vault.ts|凭据隔离缺失");
    expect(brief.recommendation.note).toContain("不要改动其它文件");
  });

  it("surfaces a review.not_converging stop with its guard meta", async () => {
    const db = await createTestDb();
    const store = new PostgresRunStore(db);
    const run = makeRun({
      checks: [check()],
      diff,
      findings: [finding({ consecutiveRounds: 3, fingerprint: findingFingerprint({ file: "src/server/credential-vault.ts", title: "凭据隔离缺失" }) })],
    });
    await store.createRun(run, { runId: run.id, round: 1, source: "system", type: "run.created", message: "created", at: at(0) });
    await event(store, run, {
      type: "review.not_converging",
      message: "审核未收敛",
      meta: { stallRule: "unresolved-blocking", persistingBlockingKeys: ["src/server/credential-vault.ts|凭据隔离缺失"], findings: [finding()] },
    });
    await linkStory(db, run, { acceptanceCriteria: ["修改 src/server/credential-vault.ts 实现凭据隔离：API Key 不得写入日志"] });

    const brief = await readDecisionBrief(db, run);

    expect(brief.stopReason.code).toBe("review_not_converging");
    expect(brief.stopReason.meta.stallRule).toBe("unresolved-blocking");
    expect(brief.stopReason.meta.persistingBlockingKeys).toEqual(["src/server/credential-vault.ts|凭据隔离缺失"]);
    expect(brief.remaining[0].streak).toBe(3);
    expect(brief.recommendation.action).toBe("continue");
    expect(brief.recommendation.note).toContain("方向可能不对");
  });

  it("accepts a fully green run and lists the recorded remainder", async () => {
    const db = await createTestDb();
    const store = new PostgresRunStore(db);
    const run = makeRun({
      checks: [check()],
      diff,
      findings: [finding({ severity: "low", resolved: false, consecutiveRounds: 0, fingerprint: findingFingerprint({ file: "src/server/credential-vault.ts", title: "日志措辞可优化" }) })],
    });
    await store.createRun(run, { runId: run.id, round: 1, source: "system", type: "run.created", message: "created", at: at(0) });
    await event(store, run, { type: "run.needs_human", message: "达到最大审核轮次" });
    await linkStory(db, run, { acceptanceCriteria: ["修改 src/server/credential-vault.ts 实现凭据隔离"], definitionOfDone: ["npm test 通过"] });

    const brief = await readDecisionBrief(db, run);

    expect(brief.gates.map((gate) => gate.status)).toEqual(["green", "green", "green", "green"]);
    expect(brief.remaining[0].severity).toBe("low");
    expect(brief.recommendation.action).toBe("accept");
    expect(brief.recommendation.note).toContain("low 1 条");
  });

  it("degrades missing fields to unknown instead of crashing", async () => {
    const db = await createTestDb();
    const store = new PostgresRunStore(db);
    // No checks, no diff, no findings, no story → nothing to judge.
    const run = makeRun({ checks: [], diff: "", findings: [] });
    await store.createRun(run, { runId: run.id, round: 1, source: "system", type: "run.created", message: "created", at: at(0) });

    const input = await collectDecisionBriefInput(db, run);
    expect(input.findings).toEqual([]);
    expect(input.checks).toEqual([]);

    const brief = await readDecisionBrief(db, run);
    expect(brief.stopReason.code).toBe("unknown");
    expect(brief.gates.find((gate) => gate.id === "checks")?.status).toBe("unknown");
    expect(brief.gates.find((gate) => gate.id === "scope")?.status).toBe("unknown");
    expect(brief.gates.find((gate) => gate.id === "acceptance")?.status).toBe("green");
    expect(brief.remaining).toEqual([]);
    expect(brief.recommendation.action).toBe("continue");
  });

  it("falls back to the run document when the findings projection is missing", async () => {
    const db = await createTestDb();
    const store = new PostgresRunStore(db);
    const run = makeRun({
      checks: [check()],
      diff,
      findings: [
        finding({
          id: "legacy-1",
          severity: "critical",
          file: "src/server/db.ts",
          title: "事务未回滚",
          evidence: "异常分支直接 return，没有 ROLLBACK，连接泄漏",
          consecutiveRounds: 1,
        }),
      ],
    });
    await store.createRun(run, { runId: run.id, round: 1, source: "system", type: "run.created", message: "created", at: at(0) });
    // Simulate a legacy run whose normalized projection predates the finding.
    await db.query("DELETE FROM run_findings WHERE run_id = $1", [run.id]);

    const brief = await readDecisionBrief(db, run);
    expect(brief.gates.find((gate) => gate.id === "blocking")?.status).toBe("red");
    expect(brief.remaining[0]).toMatchObject({ severity: "critical", key: "src/server/db.ts|事务未回滚" });
    expect(brief.remaining[0].evidenceOk).toBe(true);
  });
});

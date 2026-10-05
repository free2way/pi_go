# 17 · 发布回顾导出与恢复停机顺序（Sprint 4 核心 + kill-recovery 平台待办）

本批次为加法：不改变既有敏捷 CRUD、Run 执行内核与状态机语义。

## 1. 发布汇总与回顾 `GET /api/agile/releases/:id/summary` · `/retrospective`

只读、按 owner 隔离（`ownerKeysFor(request)`）。发布不可见（不存在或非本人）返回 `404 RELEASE_NOT_FOUND`，与既有发布路由一致；空发布返回显式 0，不抛错。数据来源为发布 `story_ids_json` 中**属于调用者**的故事、其关联运行（`story_runs` → `runs`）与两种审核事件（`review.changes_requested` / `review.not_converging`），整形全部由 `src/shared/agile-metrics.ts` 的纯函数完成。

### 1.1 summary

| 字段 | 含义 |
| --- | --- |
| `stories[]` | 每个故事的派生状态（`deriveStoryStatus`，回退存储状态）、运行数、`latest`（runId/state/round/maxRounds/updatedAt）、`acceptance`（有验收快照时）、`cost`/`inputTokens`/`outputTokens`/`modelCalls`、`findings`、`changesRequested`、`notConverging`、`blockedReason`（阻塞原因） |
| `totals` | `stories` / `done` / `inProgress`（开发/审核/待验收）/ `blocked` / `notStarted`（待办/就绪）/ `runs` |
| `usage` | 关联运行成本/Token/调用合计（复用 `UsageTotals`） |
| `modelCombinations[]` | 开发/审核模型对，按模型对聚合 `runs` 与 `stories` |
| `merges[]` | `run.merge` 记录（commit/strategy/targetBranch/mergedAt/mergedBy） |
| `deployments[]` | `run.release` 合并后发布记录（status/environment/commit/kind/时间/url 等），全部防御式读取 |

### 1.2 retrospective

复用 `shapeMetrics` 的 `cycleTime`（中位/P90）、`rework`、`reviewFindings`、`costPerCompletedStory`、`usage`；另增：

- `notConvergingRuns`：发出 `review.not_converging` 的**去重运行数**；
- `reviewTrend[]`：按首个关联运行时间排序的每故事发现趋势（total/resolved/changesRequested/notConverging）；
- `blockedStories[]`：阻塞故事 + 原因 + 最近运行状态。

## 2. UI（敏捷视图，加法）

「发布回顾」面板：发布选择器、汇总表（总数/用量/周期返工/审核）、故事结果表、模型组合表、合并与部署表、审核趋势表、阻塞故事表，以及「导出回顾 (JSON)」下载按钮与「复制」按钮。导出载荷由纯函数 `releaseExportJson` / `releaseExportFilename`（`src/client/agile-view.ts`）生成：`{ schemaVersion: 1, exportedAt, summary, retrospective }`，文件名为文件系统安全的 `release-<version>-<name>-retrospective.json`。

## 3. 平台待办：worker 恢复停机顺序（R3-001 / R3-FINAL-ROUND-AMBIGUOUS）

`src/worker/run-recovery.ts` 新增纯策略 `planRecovery`（与 `NEW-04` 的 `recoveryUpdateState` / `recoveryResumePhase` 并存）：

1. **停机条件优先于工作目录（R3-001）**：回收（reclaim）一个已启动任务时，先评估终态停机条件——已达最大轮次、硬预算（Token/成本/模型调用）已耗尽、时长窗口已过期——命中即用既有事件类型与文案停机（`run.needs_human` / `run.budget_exhausted` / `run.deadline_exceeded`），不再进入依赖工作目录的恢复/准备流程。工作目录真正需要时的失败仍为 fail-closed。
2. **末轮歧义（R3-FINAL-ROUND-AMBIGUOUS）**：恢复规划显式携带 `round`/`maxRounds`；`round >= maxRounds`（且 `maxRounds >= 1`）时以既有最大轮次文案停机，不再重新进入循环。`round`/`maxRounds` 缺失或 `maxRounds <= 0` 时继续执行（向后兼容）。
3. 显式人工动作（`resume` / `retryReview`）与全新派发不受该守卫影响：它们自带入口状态，resume 仍获得新的时长窗口。

`executeJob` 在 `recovering` 为真时、`resolveProject` 之前调用该策略；未命中任何条件时才进入工作目录恢复。回归保护：`NEW-04` 阶段保持、收敛/预算/截止守卫的既有测试全部保持通过。

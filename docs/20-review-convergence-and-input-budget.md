# 20 · 审核收敛修复：稳定指纹、阻断批次守门与审核输入预算

本批次针对生产事件 `run_e7c565d6335a4bc7`（2 点故事，6 轮未收敛，$0.24，单轮审核
234–692s）修复三件事，全部为**加法**，不改变 Run 状态机与既有终态守卫。

## 1. 跨轮稳定指纹 `findingFingerprint`

### 1.1 问题

同一缺陷（`解除阻塞后没有恢复之前状态`）在第 2–6 轮被记为不同 id
（`story-unblock-state-not-restored` / `F1` / `STORY-BLOCK-001`）。身份此前依赖模型
给出的 id，于是：

- 重复严重问题阈值（AT-REVIEW-010，3 轮）永不触发；
- 收敛守卫只统计「每轮新增」critical/high，把同一缺陷当成新问题；
- 运行烧掉 6 轮仍未收敛。

### 1.2 方案

纯函数 `findingFingerprint(finding)`（`src/shared/finding-fingerprint.ts`，worker 与
server 共用；`src/worker/review-findings.ts` 仅做薄 re-export）：

- `file`：小写、去前导 `./`、`\`→`/`；空/缺失 → 占位符 `<no-file>`。
- `title`：小写、折叠空白、去列表前缀（`- `、`1. `、`- [ ] `）、去尾部标点/句号。
- 组合为 `<normalized file>|<normalized title>`。模型 id 仅用于展示。

`mergeFindings` 改成**优先按指纹合并**（id 仅作兜底），因此换 id / 改写标题的重复会
累加到同一条 finding 的 `consecutiveRounds`，而不是新增一行。旧版哈希指纹在读取时
按内容重算（legacy 行不会产生重复）。

### 1.3 持久化

- 迁移 13 `finding-stable-key`：`ALTER TABLE run_findings ADD COLUMN stable_key TEXT`
  - `CREATE INDEX idx_run_findings_stable ON run_findings(run_id, stable_key)`。
- `run_findings` upsert 写入/更新 `stable_key`（值取自 finding 的稳定键）。
- 旧行回填：pg-mem（测试）不支持 `trim`/`regexp_replace`，故忠实 SQL 归一不可移植；
  改为迁移后运行 JS 回填 `backfillFindingStableKeys(db)`（仅更新 `stable_key IS NULL`，
  幂等）。读取侧对 NULL 一律「读时计算」。

## 2. 收敛守卫：连续 N 轮同一批阻断问题未减少即停

在既有「新增严重问题未下降（连续 2 轮）」规则之外，`src/worker/review-convergence.ts`
新增第二条规则：

- 每轮统计**本轮上报的未解决阻断（critical/high）**数量与稳定键（`lastSeenRound`
  加当前连续窗口重建），构成 `unresolvedBlocking` / `blockingKeys`。
- 若尾部连续 `PI_REVIEW_STALL_ROUNDS` 轮（默认 3，最小 2，严格解析）该数量**未下降**，
  则判定未收敛，在开启下一轮返修前转 `needs_human`，事件 `review.not_converging`。
- 事件 meta 附带 `stallRule`、`unresolvedStalledRounds`、`persistingBlockingKeys`、
  `currentUnresolvedBlocking` 与逐轮 `perRound`；中文摘要形如
  `审核未收敛：同一批阻断问题连续 3 轮未减少（当前 1 个未解决阻断问题：file|title）`。
- 既有 NEW-count 规则、重复严重问题阈值、预算/时限/轮次上限守卫均不变；
  `PI_REVIEW_CONVERGENCE_GUARD=off` 仍整体关闭。

重建局限：运行文档只保留首见/末见轮与当前连续长度，中间被打断的旧连续段无法完全重建；
但守卫只判定**尾部**连续段，当前连续窗口是精确的。

## 3. 审核输入瘦身

`src/worker/review-input.ts` 在组装 reviewer prompt 时对 diff 施加确定性预算：

- **排除**（清单中标注原因）：`package-lock.json` / `yarn.lock` / `pnpm-lock.yaml` /
  `*.lock` / `npm-shrinkwrap.json`（lockfile）、`dist/**`、`build/**`（build-output）、
  `node_modules/**`（dependency）、二进制文件（binary）。任务显式针对时除外（写进 prompt）。
- **单文件上限** `PI_REVIEW_FILE_DIFF_BYTES`（默认 40 000）：保留前 N 个 hunk，追加
  `... [trimmed: +A/-B lines, K hunks omitted]`。
- **总上限** `PI_REVIEW_TOTAL_DIFF_BYTES`（默认 200 000）：按文件体积从大到小取（同大小
  按路径稳定排序），仍按原始顺序输出；被挤出的文件标注 `total-budget`。
- **绝不静默丢弃**：只要发生排除/裁剪，末尾追加 `[PiGO review input manifest]`（完整
  文件清单 + 每文件 +/- 统计 + 原因）与 `[review input trimmed] original X -> Y bytes
  (limits: ...)`。小 diff 未裁剪时**逐字节原样透传**。

reviewer prompt 同时声明：输入可能被预算裁剪、锁文件/构建产物默认排除、并应将与任务
无关的越界改动（如 docs/lockfile）作为 finding 上报。

## 4. 配置

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `PI_REVIEW_CONVERGENCE_GUARD` | `on` | `off` 关闭全部收敛守卫 |
| `PI_REVIEW_STALL_ROUNDS` | `3` | 同一批阻断问题连续未减少轮数；整数 ≥ 2，否则回落 3 |
| `PI_REVIEW_FILE_DIFF_BYTES` | `40000` | 单文件 diff 上限；严格正整数 |
| `PI_REVIEW_TOTAL_DIFF_BYTES` | `200000` | reviewer diff 总上限；严格正整数 |

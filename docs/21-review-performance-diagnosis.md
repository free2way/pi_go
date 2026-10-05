# 21 · Reviewer 性能故障复盘与 v0.26.2 优化

## 1. 结论

本次慢任务的主瓶颈是 **Reviewer 的 Pi/模型执行与晚期失败后的整次重播**，不是确定性检查、
diff 预处理或只读快照。

生产对比任务 `run_747fa0f5baa141d9`（“阻塞原因展示（v0.26.1 对比演示）”）的只读事件证据：

| 指标 | 观测 |
| --- | --- |
| 总耗时 | 41m 37s |
| 最终可见用量 | 396.6k tokens，$0.257（失败 attempt 的 provider 用量未知，可能低估） |
| R2 Reviewer | 468.1s |
| R3 Reviewer | 862.5s，2 次 provider 调用 |
| R3 首次失败 | 运行约 401s 后 `Upstream response stream was interrupted`，随后从零重试 |
| 检查 / 快照 | 检查约 0.3s；快照约 1s 内，不是主瓶颈 |
| R1 异常 diff | Sub-agent `.state` 被当成源码，diff 约 598KB，造成一次额外返修 |

代码审查同时确认：Reviewer 未显式传 `thinking`，`runPi` 会回落到 `high`；Reviewer 每轮为
独立会话，当前 pinned Pi CLI 又没有 RPC/daemon，所以 provider 重试会启动新的 CLI/容器并
重新探索仓库。独立审核本身保留，但不再允许数分钟后的失败被无条件整次重播。

## 2. 已落地优化

### 2.1 Reviewer effort 与 diff-first 策略

- 新增 `PI_REVIEWER_THINKING=low|medium|high`，严格解析，默认 `medium`。
- Reviewer prompt 改为 diff-first：优先变更文件、直接依赖和相关测试，禁止无证据的全库盘点；
  软限制为 12 次定向工具调用。
- `review.input_prepared` 记录原始/输出 diff 字节、prompt 字节、文件数、裁剪数与 thinking。
- `session.metrics` 补充 provider、model、thinking 与 promptBytes。

### 2.2 晚期失败不再从零重播

- 新增 `PI_REVIEW_RETRY_MAX_ELAPSED_SECONDS`，默认 120 秒；`0` 可关闭守卫。
- 只有 Reviewer 且失败 attempt 超过阈值时停止自动重试并转人工；快速瞬态失败、Developer
  与 Sub-agent 仍使用原有指数退避策略。
- 每次失败均写 `provider.attempt_failed`，包含 attempt、durationMs、kind、willRetry、role、
  provider、model、thinking 与 promptBytes。失败调用不再是时序黑洞。

### 2.3 协议错误不再完整重审

- 本地解析器可从解释文字中提取第一个平衡的 JSON 对象（正确处理字符串内花括号和转义）。
- 仍不合法时，第二次模型调用只携带上次响应与 schema，使用 `low` thinking，并明确禁止重新
  扫描仓库；不再重复发送整个 diff 或重新执行一次代码审核。

### 2.4 Sub-agent 运行态移出代码树

- Sub-agent Pi state 改放到 `<run>.state/subagents/<task-id>`，不再使用主工作树内部的
  `subagents/<task-id>.state`。
- 删除 Sub-agent worktree 时同步清理旧版遗留 `.state`，防止升级中的在途任务继续污染 diff。

### 2.5 部署配置闭环

Compose 现在真实转发以下变量，并由 `test:config` 强制覆盖：

- `PI_REVIEWER_THINKING`
- `PI_REVIEW_RETRY_MAX_ELAPSED_SECONDS`
- `PI_REVIEW_CONVERGENCE_GUARD`
- `PI_REVIEW_STALL_ROUNDS`
- `PI_REVIEW_FILE_DIFF_BYTES`
- `PI_REVIEW_TOTAL_DIFF_BYTES`

v0.26.0 虽已在代码与 `.env.example` 增加后四项，但标准 Compose 未转发，生产调参实际无效；
本次一并修正。

## 3. 验收结果

| 检查 | 结果 |
| --- | --- |
| Reviewer / retry / protocol / sandbox 定向测试 | 30/30 通过 |
| 全量单元测试 | 844/844 通过（90 files） |
| TypeScript | 通过 |
| ESLint | 通过 |
| Compose 结构与配置覆盖 | 通过（58 critical env entries） |
| 生产构建 | 通过 |
| 脚本测试 | 36/36 通过 |
| Secret scan | 通过 |

未在本机执行真实 PostgreSQL 并发门禁和浏览器 E2E，因为没有设置对应的数据库 URL 与
`PI_E2E_BASE_URL`；这两项应在部署后的验收环境补跑。

## 4. 部署后性能验收

使用同一仓库、同一 Reviewer 模型、相近规模任务做至少 5 次对照：

1. `review.input_prepared` 中确认 `thinking=medium`，并记录 promptBytes。
2. 统计 `review.started → session.metrics/review.*` 的 p50、p95。
3. 确认任何 `provider.attempt_failed` 都带 durationMs；超过 120s 的 Reviewer failure
   `willRetry=false`，不会出现第二次全量调用。
4. 确认 diff 与制品中不存在 `subagents/*.state`。
5. 对比 v0.26.1 基线：单轮 Reviewer 468–862s；目标 p50 < 180s、p95 < 420s，且同一轮因
   晚期流中断产生的重复调用数为 0。

若 p50 仍高于目标，下一步优先比较更快 Reviewer 模型或将总 diff 预算从 200KB 调至
80KB；不要通过并发启动第二个 Reviewer 解决，它会增加费用并可能加重 provider 限流。

# 22 · Decision Brief（人工介入决策摘要）— 下一批实现规格

## 1. 背景与目标

运行进入 `needs_human`（达到最大审核轮次、持续阻断未减少、预算/时限守卫、检查失败等）时，
信息是齐全的（findings / 检查 / diff / 轮次 / 费用），但**没有一个聚合视图回答唯一的问题**：

> 现在这版开发，**可以接受交付**，还是**需要继续开发**？

本规格给出一个 **Decision Brief** 卡片：在运行详情页顶部一眼给出**为什么停下**、**四条硬门槛的红绿灯**、
**剩余问题按验收标准的映射与返修次数**，以及**建议动作（可一键执行）**。

## 2. 展示位置

- 运行详情页（`src/client/App.tsx` 运行面板）顶部；`needs_human`/`failed`/终态时显示；其它状态折叠为"决策摘要"锚点。
- 视觉遵循现有活动/日志字号体系（与 agent1/审核/diff 面板一致）。

## 3. 数据来源（全部已存在，无需新采集）

| 数据 | 来源 |
| --- | --- |
| 停止原因 | `run_events` 中 `run.needs_human` / `review.not_converging` / `guard.*` 的 `meta_json`（含 `stallRule`、`persistingBlockingKeys` 等） |
| 剩余问题 | `run_findings`（`severity`、`resolved`、`stable_key`、`consecutive_rounds` 即 streak、`file`、`line`、`evidence`、`requiredChange`） |
| 检查 | `run_checks`（`status`、名称、输出摘要） |
| 范围 | 第 N 轮 `diff.artifact_persisted`（diff 文件清单/字节数）+ 故事的范围约束检查结果 |
| 验收 | `agile_stories.acceptance_criteria` / `definition_of_done`（JSON） |
| 轮次与成本 | `runs.document_json`（round / estimatedCost）+ `session.metrics` |

## 4. 四条硬门槛（任一"红" → 建议继续开发）

1. **检查**：`run_checks` 全绿？否则红。
2. **阻断问题**：无未解决 `critical`；且无**与本故事 AC/DoD 相关**的未解决 `high`。
   - AC 相关性判定（纯函数，保守）：finding 的 `file`/`title`/`evidence` 与本故事 AC/DoD 文案的
     关键词/路径集合有交集（大小写、中英文标点归一化后）。
3. **范围**：diff 文件全部落在允许路径内；不含生成物/脏文件（`.state`、`dist`、锁文件等）。
4. **验收覆盖**：每条 AC/DoD 至少能对应到一个已实现的变更（diff 文件）或一条测试（diff 中的测试文件/检查）。

> 判定逻辑必须实现为**共享纯函数**（`src/shared/decision-brief.ts`），服务端返回结构化结果，
> 前端只渲染 + 一键动作；**不得**让模型参与判定。

## 5. 建议动作映射（前端按钮复用现有接口）

| 情况 | 建议动作 |
| --- | --- |
| 四条硬门槛全绿 | **接受交付**（列出将记录的剩余项：medium/low、误报） |
| 有红且存在 `streak ≥ 2` 的同一指纹 | **继续开发 + 建议备注草稿**（指名 `stable_key`、只改该点、不动其它文件） |
| 有红但均为 `streak = 1` | **继续开发**（按红项生成逐条备注） |
| 检查失败 | 继续开发（备注指向失败检查与命令） |
| 同批阻断连续 ≥3 轮不减 | 提示"大概率方向不对"：建议**人工明确修法**或接受并记为技术债 |

备注草稿规则：一次一条、含 `file|title` 指纹、含"不要改动其它文件"的边界。

## 6. API（草案）

`GET /api/runs/:id/decision-brief` →

```json
{
  "stopReason": { "code": "max_review_rounds", "message": "…", "meta": {} },
  "gates": [
    { "id": "checks", "status": "green|red|unknown", "detail": "…" },
    { "id": "blocking", "status": "…", "detail": "…", "findings": [] },
    { "id": "scope", "status": "…", "detail": "…" },
    { "id": "acceptance", "status": "…", "detail": "…" }
  ],
  "remaining": [{ "severity": "medium", "key": "src/…|…", "streak": 2, "ac": "AC#3", "evidenceOk": true }],
  "recommendation": { "action": "continue|accept", "note": "…" }
}
```
（鉴权与既有运行详情一致。）

## 7. 测试要求

- 共享纯函数：四条门槛的绿/红/未知三态；AC 相关性匹配（保守不误判）；误报识别（evidence 对不上）；`streak` 映射到建议动作；停止原因映射。
- 服务端：聚合取数正确（含 `needs_human`/早停两种事件形态、缺失字段时返回 `unknown` 而非崩溃）。
- 前端：全绿/含红/`unknown` 三种渲染 + 按钮动作调用（不新增接口时复用现有 accept/continue）。

## 8. 验收标准

1. `needs_human` 运行打开详情，**3 秒内**能回答"通过还是继续"（卡片首屏可见，无需滚动查阅日志）；
2. 卡片结论与既有数据**一致**：红项都能点到对应 finding/检查/diff；
3. "继续开发"按钮可带**草稿备注**一键提交；
4. 模型不参与判定（纯函数可单测）；
5. 不新增轮询/采集开销（全部读既有表）。

## 9. 非目标

- 不做自动接受/自动继续（**始终由人点击**）；
- 不重写审核提示词，不改收敛守卫阈值；
- 不引入新的持久化表（除非为缓存，且可省略）。

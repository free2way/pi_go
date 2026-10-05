# 16 · 敏捷度量与模型组合模板（Sprint 4）

本批次在既有敏捷规划层之上新增两块能力，均为加法：不改变 Run 执行内核与既有路由语义。

## 1. 度量 `GET /api/agile/metrics`

只读、按 owner 隔离（`ownerKeysFor(request)`），可选 `?projectId=&sprintId=` 收窄范围，返回**每个冲刺**的指标与**项目汇总**：

```jsonc
{
  "generatedAt": "…",
  "sprints": [ { "sprintId", "projectId", "name", "status", ...metrics } ],
  "projects": [ { "projectId", "name", "key", ...metrics } ]
}
```

每个 `metrics` 含：

| 字段 | 含义 |
| --- | --- |
| `stories` | `total` / `completed`（= `done`）/ `byStatus`（七种状态的显式计数，无数据为 0） |
| `cycleTime` | 每个完成故事的周期（首个关联运行 `createdAt` → 该运行 `acceptance.acceptedAt` 或 `updatedAt`），`samples` / `medianSeconds` / `p90Seconds` / `items` |
| `rework` | 完成故事中「至少一次 `review.changes_requested`」的比例（`rate`，无完成故事为 0） |
| `usage` | 关联运行用量合计：`cost` / `inputTokens` / `outputTokens` / `cacheReadTokens` / `modelCalls` / `runs` |
| `costPerCompletedStory` | `usage.cost / completed`，无完成故事为 0 |
| `reviewFindings` | `total` / `resolved` 发现与 `review.not_converging` 事件数（按冲刺汇总） |
| `runOutcomes` | 终态运行分布：`completed` / `needs_human` / `cancelled` / `failed` |
| `storyInsights` | 每个故事的运行数、成本、发现、`changesRequested`、`notConverging` |

**实现分层**：SQL 只取有界行（owner 的故事、其关联运行、两种审核事件类型），其余全部由纯函数 `shapeMetrics` 计算（`src/shared/agile-metrics.ts`）。`median` / `p90` 为确定性实现（`p90` 取最近秩 `ceil(0.9·n)`）。空/稀疏数据返回显式 0，不抛错。

## 2. 模型组合模板 `/api/templates`

轻量、owner 隔离：`POST /api/templates` / `GET /api/templates` / `DELETE /api/templates/:id`。

- 存储 `{ name, developerModel, reviewerModel, budget?, maxParallel? }`，迁移 `11-model-templates`（`model_templates`，`UNIQUE (owner_id, name)`）；不种子数据。
- 同 owner 同名返回 `409 TEMPLATE_NAME_TAKEN`；不同 owner 可复用同名。
- `applyModelTemplate`（`src/shared/agile.ts`）把模板整形为表单填充载荷：未设置的 `budget` / `maxParallel` 不出现，避免覆盖操作者已填的值（只填充，不提交）。

## 3. UI

- 敏捷视图新增「度量」面板（`src/client/AgilePage.tsx`）：冲刺选择器（默认项目汇总）→ 指标卡 + 紧凑表格；中文文案，字号沿用 `--panel-*` 面板排版变量。
- 新建故事表单新增「模板」选择器，一键填入开发/审核模型、预算与最大并行；并补齐模型/预算字段。
- 创建运行对话框新增「模板」选择器，按 provider+model 匹配并填入开发/审核模型。

## 4. 管理员门禁（安全相邻）

`IdentityService.isAdmin` 现在要求 `role === "admin"` **且** `status !== "disabled"`，因此停用管理员会在下一个请求即失去管理员权限（已签发的会话不会保留管理员能力）；缺失/其他状态按活跃处理以兼容历史数据。

## 5. 测试

- `src/shared/agile-metrics.test.ts`：`median` / `p90` 边界与确定性、空范围显式 0、状态推导、周期/返工/用量/发现/运行结果整形、稀疏运行文档不抛错、范围外运行被忽略。
- `src/server/agile-metrics.test.ts`（pg-mem）：空 owner、按冲刺聚合 + 项目汇总、owner 隔离与 `projectId`/`sprintId` 过滤。
- `src/server/identity.test.ts`：活跃管理员 / 停用管理员 / 缺失状态 / 普通用户。
- `src/shared/agile.test.ts`：`reviewing → in_review` 与优先级、`applyModelTemplate` 整形。
- `src/server/agile.test.ts` / `src/client/agile-view.test.ts`：`reviewing` 回写与看板「审核中」分组。
- `src/server/agile-schemas.test.ts`：模板 zod 校验；`src/server/agile.test.ts`：同名冲突与 owner 隔离。

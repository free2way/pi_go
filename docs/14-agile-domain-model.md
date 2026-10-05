# 14 · 敏捷领域模型（Sprint 3 · batch 1）

本批次在既有 Run 之上增加一层**规划领域**：项目 / 用户故事 / 冲刺 / 发布。Run 仍是唯一的执行单元，编排器（orchestrator）与 worker 不做任何改造；故事只是通过 `story_runs` 关联到一次或多次运行，并把最新运行的执行状态回写为故事状态。

## 1. 领域模型

| 实体 | 表 | 关键字段 |
| --- | --- | --- |
| 项目 Project | `agile_projects` | `owner_id`、`name`、`project_key`（同一 owner 内唯一）、`description` |
| 用户故事 Story | `agile_stories` | `project_id`、`title`、`description`、`acceptance_criteria_json`(text[])、`priority`、`estimate`、`definition_of_done_json`(text[])、`developer_model_json`、`reviewer_model_json`、`budget_json`、`max_parallel`、`sprint_id`(null=待办)、`workspace_id`、`status` |
| 冲刺 Sprint | `agile_sprints` | `project_id`、`name`、`goal`、`start_date`、`end_date`、`status`(planned/active/closed) |
| 发布 Release | `agile_releases` | `project_id`、`name`、`version`、`notes`、`status`、`story_ids_json` |
| 故事-运行关联 | `story_runs` | `(story_id, run_id)` 主键 + `created_at`（一条故事可关联多次运行：修复 / 重试） |

迁移以增量方式追加在 `src/server/db.ts`（`id: 9`，`agile-projects-stories-sprints-releases-story-runs`），不改动既有表。故事归属项目；删除项目会级联删除其故事/冲刺/发布与关联行（运行本身保留）。

### 规模取值（已定案）

- **priority：MoSCoW**（`must` / `should` / `could` / `wont`，中文标签 必须 / 应该 / 可以 / 本次不做）。选择 MoSCoW 而非 P0–P3：它表达的是「本次是否承诺交付」的范围语义，与验收标准的写法一致。
- **estimate：斐波那契故事点**（`1 / 2 / 3 / 5 / 8 / 13`，可空 = 未估算）。选择点值而非 T 恤尺码：点值可在冲刺内求和（看板列头展示合计点数），UI 仍保留人类可读标签。
- 存储上沿用本项目既有约定：数组/对象以 `*_json` TEXT 列保存，避免依赖 `text[]` 与 `jsonb` 驱动差异；接口层还原为强类型。

## 2. 故事状态与回写规则

故事状态：`backlog / ready / in_progress / in_review / awaiting_acceptance / done / blocked`。

回写是一个**纯函数** `deriveStoryStatus(run)`（`src/shared/agile.ts`），从**最新关联运行**推导：

| 最新运行 | 故事状态 |
| --- | --- |
| `queued` / `preparing` / `developing` / `checking` / `reviewing` | `in_progress` |
| `needs_human` | `blocked`（原因取 `run.summary`） |
| `completed`（无验收快照） | `awaiting_acceptance` |
| `completed` 且 `run.acceptance` 存在 | `done` |
| `failed` / `cancelled` | `blocked`（原因取 `run.summary`） |
| 无关联运行 | 不改写（保留人工设置的 `backlog` / `ready` / `in_review`） |

优先级细节：`needs_human` / `failed` / `cancelled` **优先于** `acceptance`。重新打开（reopen）的运行会保留旧的验收快照但状态回到 `needs_human`，此时应判为 `blocked` 而不是 `done`。

`in_review` 是人工可设置的状态：按需求地把「正在审核」的运行映射为 `in_progress`，所以看板的「审核中」列只会由人工显式设置填充。

**回写触发点**（均为服务器端持久化副作用，纯函数逻辑可单测）：
- `GET /api/stories/:id` 读取时（`AgileService.getStory` → `reconcileStory`）；
- 运行变更路径：`POST /api/internal/runs/:id/update`（worker 回传）、取消、接受（approve）、重新打开（reopen），统一走 `reconcileStoryForRun`（`src/server/index.ts`）。

## 3. API

所有路由与既有工作区路由一致地按 owner 隔离（`ownerKeysFor(request)`，管理员可读跨 owner 的单条记录）；请求体全部由 zod 校验（`src/server/agile-schemas.ts`）。

> 注意：`GET /api/projects` 早已是「Worker 全局项目列表」的遗留路由，因此新的**按 owner 隔离**的项目 CRUD 挂在 `/api/agile/projects` 下，避免语义冲突。故事/冲刺/发布使用独立命名空间。

| 方法 & 路径 | 说明 |
| --- | --- |
| `GET/POST /api/agile/projects` | 列出 / 创建项目 |
| `GET/PATCH/DELETE /api/agile/projects/:id` | 读取 / 更新 / 级联删除项目 |
| `GET /api/stories?projectId=&sprintId=&status=` | 故事列表（可按项目/冲刺/状态过滤，`sprintId` 为空即待办） |
| `POST /api/stories` | 创建故事（接受标准 / 优先级 / 估算 / 完成定义 / 模型 / 预算 / 并行 / 工作区 / 冲刺） |
| `GET /api/stories/:id` | **故事详情**：故事字段 + 关联运行（state / round / findings resolved÷total / checks passed÷failed / cost）；读取前先回写状态 |
| `PATCH/DELETE /api/stories/:id` | 更新 / 删除故事 |
| `POST /api/stories/:id/runs` | **提交为运行**（见下） |
| `GET/POST /api/sprints`，`PATCH/DELETE /api/sprints/:id` | 冲刺 CRUD；删除冲刺时其故事回到待办 |
| `GET/POST /api/releases`，`PATCH/DELETE /api/releases/:id` | 发布 CRUD（含 `storyIds`） |

### 提交故事为运行

`POST /api/stories/:id/runs`：

1. 校验故事状态为 `ready`，否则 `409 STORY_NOT_READY`；
2. 组装运行文本（纯函数 `buildStoryRunInput`）：`task` = 描述 + `## 验收标准` 编号列表 + `## 完成定义` 列表；`acceptanceCriteria` 单独携带；
3. `checks` 默认取所选工作区已注册的默认检查命令（可由请求体的 `checks` 覆盖）；`workspaceId` 取故事字段，可由请求体覆盖；
4. 模型 / 预算 / 并行度取故事上的值（未设置时沿用全局默认）；
5. 真实模式（默认）复用与 `POST /api/runs` 完全相同的执行内核 `startRealRun`（工作区预检、模型/凭据预检、磁盘检查、幂等、入队）；也可用 `mode: "demo"` 提交演示运行；
6. 通过 `story_runs` 关联运行，并把故事置为 `in_progress`；若派发失败，运行仍会被关联并回写为 `blocked`。

请求体：`{ mode?: "real"|"demo", workspaceId?, checks?, idempotencyKey? }`（默认 `mode: "real"`）。

## 4. UI

侧边栏新增「敏捷」视图（`src/client/AgilePage.tsx`）：项目选择与新建、**Sprint 看板**（六列：待办 / 开发中 / 审核中 / 待验收 / 完成 / 阻塞，列头显示条目数与估算点数合计）、故事列表与新建表单、故事详情（验收标准 / 完成定义 / 关联运行表 + 「提交为运行」按钮）。本批次不做拖拽。看板列映射为纯函数 `groupStoriesByColumn`（`src/client/agile-view.ts`）。

## 5. 测试

- `src/shared/agile.test.ts`：状态推导全分支（含 reopened 优先级）、任务文本组装、payload builder、看板映射、latestLinkedRun、运行摘要。
- `src/server/agile.test.ts`（pg-mem）：项目/故事/冲刺/发布 CRUD 与 owner 隔离、级联删除、冲刺删除回退待办、运行关联与 `in_progress → awaiting_acceptance → done → blocked` 回写、`reconcileRun`。
- `src/server/agile-schemas.test.ts`：zod 校验（非法优先级/估算/状态、未知字段拒绝、null 清空、提交默认值）。
- `src/client/agile-view.test.ts`：看板分组与列内点数、文本行拆分、标签。

## 6. 未纳入本批次 / 已知边界

- `maxParallel` 作为故事与运行上的元数据保存，未改变编排器自身的并发策略（本批次不改造 orchestrator）。
- `in_review` 无自动推导来源（见上），需要人工设置。
- 发布（Release）仅做规划记录与故事关联，不触发部署；真正发布仍走既有的 `POST /api/runs/:id/publish` 流程。

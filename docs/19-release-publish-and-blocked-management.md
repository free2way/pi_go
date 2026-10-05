# 19 · 发布动作与看板阻塞管理（Sprint 5）

本批次在既有敏捷规划层上新增两块能力，均为**加法**：不改变 Run 执行内核，不改动
`src/worker`，既有敏捷 CRUD 语义不变。

## 1. 发布动作 `POST /api/agile/releases/:id/publish`

按 owner 隔离（管理员可越权读取，与既有发布路由一致）。请求体：

```jsonc
{ "confirm": true, "note": "本次发布说明（可选）" }
```

### 1.1 发布前校验

1. 发布必须关联 ≥ 1 个**属于调用者**的故事，否则 `409 RELEASE_EMPTY`。
2. 关联故事中任一为 `blocked`（手动或运行派生）即 `409 RELEASE_BLOCKED`，响应体携带
   `blocked: [{ storyId, title, reason, runState }]`，UI 据此在确认对话框中列出阻塞项。
3. 缺少 `confirm: true` 时为**只读预检**：返回 `{ published: false, release, stories }`，
   不写入任何状态，供 UI 渲染确认对话框。
4. 已发布（`status === "released"`）的版本重复发布 → `409 RELEASE_RELEASED`。已发布版本
   同时是**终态**：`PATCH /api/releases/:id` 对其返回 `409 RELEASE_RELEASED`。

### 1.2 发布副作用（confirm 后）

- `agile_releases.status = 'released'`，写入 `released_at` / `released_by`。
- 写入一条 `agile_release_audit` 审计行（`action = release.published`，含 actor、note、
  status 与部署结果 JSON）。
- 若配置了 `PI_POST_MERGE_DEPLOY_HOOK`，复用与运行发布**同一**传输层
  `executeRelease`（`src/server/release-execution.ts`）触发部署钩子；payload 由
  `buildReleaseDeployPayload` 生成。结果经 `shapeReleaseDeployOutcome` 归一为
  `not_configured | unsupported | ok | failed` 并写回 `agile_releases.deploy_json`。
  Webhook 类型在缺少 `PI_POST_MERGE_DEPLOY_TOKEN` 时返回 `409 RELEASE_AUTH_NOT_CONFIGURED`。
- **配置了却失败不会被静默跳过**：`failed` 会如实落在发布记录与审计行上。

### 1.3 汇总/回顾

`GET /api/agile/releases/:id/summary` 与 `/retrospective` 新增 `releasedAt`、`releasedBy`、
`deploy`（`{ status, detail, at }`）。客户端「发布回顾」显示「发布状态」行。

## 2. 看板阻塞管理

### 2.1 字段（migration 12）

`agile_stories` 新增（全部可空、加法）：

| 字段 | 含义 |
| --- | --- |
| `blocked_reason` | **手动**阻塞原因 |
| `blocked_at` / `blocked_by` | 手动阻塞时间 / 操作者 |
| `status_before_block` | 手动阻塞前的状态，解除时用于还原 |

`agile_releases` 新增 `released_at` / `released_by` / `deploy_json`；并新建
`agile_release_audit` 表。

### 2.2 路由

- `POST /api/stories/:id/block` `{ reason }`（必填）：标记手动阻塞。
- `POST /api/stories/:id/unblock`：解除手动阻塞；若关联运行仍处于
  `needs_human`/failed/cancelled，返回 `409 BLOCKED_BY_RUN`（消息含 run id），
  必须先处理该运行。已 `done` 的故事不允许手动阻塞（`409 STORY_DONE`）。

### 2.3 纯函数优先级 `deriveStoryStatus(run, manual)`

`src/shared/agile.ts` 的 `deriveStoryStatus` 增加可选 `manual: { blockedReason }`：

1. 运行派生 `blocked`（needs_human/failed/cancelled）→ 用**运行的自带原因**，手动原因不覆盖。
2. 已验收（done）→ `done`，手动阻塞不能把已交付故事改回阻塞。
3. 有手动阻塞 → `blocked` + 手动原因，覆盖派生的
   `in_progress` / `in_review` / `awaiting_acceptance`。
4. 其余按运行状态派生；无运行且无手动阻塞 → `undefined`（保留人工规划状态）。

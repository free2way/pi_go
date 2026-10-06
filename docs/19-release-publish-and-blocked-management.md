# 19 · 发布动作与看板阻塞管理（Sprint 5）

本批次在既有敏捷规划层上新增两块能力，均为**加法**：不改变 Run 执行内核，不改动
`src/worker`，既有敏捷 CRUD 语义不变。

## 1. 发布动作 `POST /api/agile/releases/:id/publish`

**仅管理员**（`release.requireAdmin: true`，见 `config/workflow.example.yaml`）可执行发布，
与 `POST /api/runs/:id/publish` 使用同一管理员判定与错误码：非管理员（**即使是发布/项目的
owner**）一律 `403 ADMIN_REQUIRED`，所有者身份不构成例外。请求体：

```jsonc
{ "confirm": true, "retry": false, "note": "本次发布说明（可选）" }
```

### 1.1 发布前校验

1. 发布必须关联 ≥ 1 个**属于调用者**的故事，否则 `409 RELEASE_EMPTY`。
2. 关联故事中任一为 `blocked`（手动或运行派生）即 `409 RELEASE_BLOCKED`，响应体携带
   `blocked: [{ storyId, title, reason, runState }]`，UI 据此在确认对话框中列出阻塞项。
3. 缺少 `confirm: true` 时为**只读预检**：返回
   `{ published: false, release, stories, deploy }`，不写入任何状态，供 UI 渲染确认对话框。
4. 已发布且部署已终态（`deploy` 为 `ok` / `not_configured` / `unsupported`，或从未记录部署）
   的版本重复发布 → `409 RELEASE_RELEASED`。**部署失败或回调超时不在此列**：它们是可重试的，
   见 1.3。已发布版本仍是**编辑终态**：`PATCH /api/releases/:id` 对其返回 `409 RELEASE_RELEASED`。

### 1.2 发布副作用（confirm 后）

- `agile_releases.status = 'released'`，写入 `released_at` / `released_by`。
- 写入一条 `agile_release_audit` 审计行（`action = release.published`，含 actor、note、
  status 与部署结果 JSON）。
- **幂等**：发布按 DB 级幂等键 `release-publish:<releaseId>#<attempt>`（对应配置中的
  `run+commit+environment` 在发布粒度上的落地，见 migration 14
  `agile_release_deploy_claims`）抢占。两个并发的 confirm 只有一个能抢到该 attempt 并真正
  触发部署，另一个返回 `409 RELEASE_IN_PROGRESS`（响应体含 `attempt` / `deliveryId`），
  **绝不会产生第二次部署**。「幂等记录 + 发布记录」在同一事务内写入，不存在"已抢占但未记录"
  的窗口。
- 若配置了 `PI_POST_MERGE_DEPLOY_HOOK`，复用与运行发布**同一**传输层
  `executeRelease`（`src/server/release-execution.ts`）触发部署钩子；payload 由
  `buildReleaseDeployPayload` 生成（含异步回调地址 `callbackUrl`）。结果经
  `shapeReleaseDeployOutcome` 归一为
  `not_configured | unsupported | pending | ok | failed` 并写回 `agile_releases.deploy_json`。
  Webhook 类型在缺少 `PI_POST_MERGE_DEPLOY_TOKEN` 时返回 `409 RELEASE_AUTH_NOT_CONFIGURED`，
  缺少 `PI_PUBLIC_ORIGIN`（无法接收回调）时返回 `409 RELEASE_CALLBACK_NOT_CONFIGURED`。
- **配置了却失败不会被静默跳过**：`failed` 会如实落在发布记录与审计行上。

### 1.3 异步部署（HTTP 202）与重试

- HTTP 202 只记为 **`pending`**（不再是 `ok`）：部署系统已受理，最终结果必须由回调
  `POST /api/internal/agile/releases/:id/release-result`（`{ deliveryId, attempt?, status,
  detail?, deploymentId?, url? }`，与运行回调同一鉴权）给出。回调把 `pending` 结算为
  `ok` / `failed` 并追加审计行（`release.deploy_succeeded` / `release.deploy_failed`）。
- **有界校验**：`pending` 超过 `RELEASE_DEPLOY_STALE_MS`（5 分钟，`src/shared/agile.ts`）仍未
  回调即为超时，被标记为 `failed` 并在 detail 记录超时原因（确认时即时结算，另有 60s 周期
  巡检）。`ok` 只有在同步 2xx 或回调报告成功后才出现——**不会出现提前的 `ok`**。
- **显式重试**：`failed`（含超时）状态必须带 `retry: true` 才能再次确认；重试使用新的
  `attempt` 但**复用同一 `deliveryId`**，由部署接收方按 delivery id 去重，因此不会重复副作用。
  `pending` 未超时时的重试返回 `409 RELEASE_IN_PROGRESS`；未超时的非重试确认返回
  `409 RELEASE_AWAITING_RESULT`。

### 1.4 汇总/回顾

`GET /api/agile/releases/:id/summary` 与 `/retrospective` 新增 `releasedAt`、`releasedBy`、
`deploy`（`{ status, detail, at, attempt?, deliveryId?, ... }`）。客户端「发布回顾」显示
「发布状态」行；发布列表在部署失败/超时后提供「重试部署」入口。

## 2. 看板阻塞管理

### 2.1 字段（migration 12）

`agile_stories` 新增（全部可空、加法）：

| 字段 | 含义 |
| --- | --- |
| `blocked_reason` | **手动**阻塞原因 |
| `blocked_at` / `blocked_by` | 手动阻塞时间 / 操作者 |
| `status_before_block` | 手动阻塞前的状态，解除时用于还原 |

`agile_releases` 新增 `released_at` / `released_by` / `deploy_json`；并新建
`agile_release_audit` 表。migration 14 另建 `agile_release_deploy_claims`
（发布部署幂等记录，`idempotency_key` 唯一），见 1.2。

### 2.2 路由

- `POST /api/stories/:id/block` `{ reason }`（必填）：标记手动阻塞。
- `POST /api/stories/:id/unblock`：解除手动阻塞；若关联运行仍处于
  `needs_human`，返回 `409 BLOCKED_BY_RUN`（消息含 run id）；**终态运行**（completed/failed/cancelled）**不再持有阻塞**，解除会成功并恢复阻塞前状态，
  必须先处理该运行。已 `done` 的故事不允许手动阻塞（`409 STORY_DONE`）。
- `POST /api/stories/:id/reopen`（v0.26.2）：显式重开。**仅有失败/取消末次运行的故事
  需要它**——若最新关联运行为 `failed` / `cancelled`，故事回到 `ready` 以便再次提交；
  成功时在最新运行上追加审计事件 `story.reopened`（meta 含 `storyId` / `actorId` /
  `previousStatus`）。
  - `409 BLOCKED_BY_RUN`（消息含 run id）：最新运行仍在执行（queued/preparing/
    developing/checking/reviewing），或处于 `needs_human`（运行派生 `blocked`）。
  - `409 BLOCKED_BY_MANUAL`：故事带**手动**阻塞（`blocked_reason`）；人工阻塞不会被
    静默重开，必须先 `unblock`。
  - `409 STORY_NOT_REOPENABLE`：最新运行已 `completed`（应走验收/退回，而不是重开）。
  - 重开不删除任何 `story_runs` 行，历史运行与事件完整保留。

### 2.3 纯函数优先级 `deriveStoryStatus(run, manual)`

`src/shared/agile.ts` 的 `deriveStoryStatus` 增加可选 `manual: { blockedReason }`：

1. 运行派生 `blocked`（**仅 `needs_human`**）→ 用**运行的自带原因**，手动原因不覆盖；终态运行（completed/failed/cancelled）**自动释放阻塞**并恢复阻塞前状态（含 `run.story_blocks_released` 事件）。
2. 已验收（done）→ `done`，手动阻塞不能把已交付故事改回阻塞。
3. 有手动阻塞 → `blocked` + 手动原因，覆盖派生的
   `in_progress` / `in_review` / `awaiting_acceptance`。
4. 其余按运行状态派生；**`failed` / `cancelled` 末次运行 → `ready`**（v0.26.2）：
   终态运行什么都没交付且永远不会自行推进，故事必须可重试；此前回落到
   `in_progress`，提交守卫只接受 `ready`，于是「失败一次」的故事再也无法提交
   （`409 STORY_NOT_READY` 死锁）。该派生即读取时的自愈，旧的卡住行在下次
   `GET /api/stories/:id` 即恢复 `ready`，无需显式 `reopen`；`reopen` 提供显式审计
   与上述三个 409 守卫。`needs_human` / 手动阻塞的语义不变，仍必须走人工路径。
5. 无运行且无手动阻塞 → `undefined`（保留人工规划状态）。

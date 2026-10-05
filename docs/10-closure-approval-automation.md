# 闭环与审批自动化（A 组 / B 组）

本文档记录 v0.21.9 之后新增的「导出/合并」「审批即合并」「部署面板」「重新打开」
「验收快照」「批量操作」能力，以及它们依赖的环境变量。所有能力默认关闭或保持
原有行为，未配置时都会给出明确错误，不会静默跳过。

## A1 导出补丁 / 创建合并请求

- `GET /api/runs/:id/patch`
  - 返回该任务完整补丁（`text/x-patch`，附件名 `<runId>.patch`）。
  - 优先使用已持久化的 diff 制品；制品没有正文时回退到 `run.diff`；仍为空时由
    Worker 在运行目录按执行时相同的方式（`git add -N .` + `git diff <baseSha>`）
    重新生成，并保存为制品供后续下载。
  - 运行目录缺失（已被清理）时返回 404，不会返回空补丁。
- `POST /api/runs/:id/merge-request`
  - 通过配置的 webhook 创建合并请求；未配置时返回 `409 MERGE_REQUEST_NOT_CONFIGURED`。
  - 环境变量（可选，`PI_MERGE_REQUEST_URL` 为启用开关）：
    - `PI_MERGE_REQUEST_URL` — 接收合并请求的 http(s) webhook（必填即为启用）。
    - `PI_MERGE_REQUEST_TOKEN` — 以 `Authorization: Bearer` 发送，绝不下发到浏览器。
    - `PI_MERGE_REQUEST_PROJECT` — 目标仓库路径/名称（可选）。
    - `PI_MERGE_REQUEST_TARGET_BRANCH` — 目标分支（可选，默认取工作区默认分支）。
  - webhook 收到 `{action:"open_merge_request", runId, title, sourceBranch,
    targetBranch, baseSha, requestedBy, patch:{artifactId,sha256,bytes,content}}`。
  - `GET /api/config/status` 新增只读字段 `mergeRequestConfigured`，前端据此显示按钮。

## A2 审批即合并（管理员）

`POST /api/runs/:id/approve` 的 `mode:"accept"` 新增可选字段
`mergeIntoWorkspace: true`：

- 仅管理员可用（复用现有 `identities.isAdmin`），非管理员返回
  `403 ADMIN_REQUIRED`，且不改动任何状态。
- 由 Worker 执行合并：工作区默认分支可快进则 `--ff-only`，否则生成合并提交；
  永不 force-push。
- 冲突时中止合并（`git merge --abort`）、返回
  `409 MERGE_CONFLICT`（含 `conflictingPaths`）并保持工作区不变；任务仍停在
  `needs_human`。
- 成功后写入 `run.merge = {commit, strategy, targetBranch, mergedAt, mergedBy}`，
  追加 `run.merged` 事件，并在响应中返回。
- 未传该字段时行为与之前完全一致。

## A2.1 显式代码发布

合并不再隐式触发部署。正常通过审核的 `completed` Run 由管理员执行两个独立动作：

1. `POST /api/runs/:id/merge`，body `{confirm:true,note?}`：把审核通过的任务分支
   合并到工作区默认分支；
2. `POST /api/runs/:id/publish`：body 为
   `{environment, confirm:true, retry?}`，显式确认目标环境后才调用发布钩子。

发布执行具有以下语义：

- 调用外部系统前先持久化 `run.release`，包括 commit、环境、操作者、attempt、
  `deliveryId` 和 `publishing` 状态；失败后必须显式 `retry:true`，并复用同一
  delivery ID；
- `https://…` webhook 需要 `PI_POST_MERGE_DEPLOY_TOKEN`，请求同时携带 Bearer、
  `X-PiGO-Delivery-Id` 和 HMAC-SHA256 `X-PiGO-Signature`；
- HTTP 202 只表示 `triggered`。部署系统完成后调用 payload 中的 `callbackUrl`，
  body 为 `{deliveryId,status:"succeeded"|"failed",detail?,deploymentId?,url?}`；
  回调使用同一个 token 的 `Authorization: Bearer ...`；
- 其他 2xx 或命令 exit 0 记为 `succeeded`，错误记为 `failed`；发布失败不会伪装
  成功，也不会重复执行合并；
- `cmd: <命令>` 仍作为运维自定义方式保留（60s 超时，仅保留 `PATH`，JSON 经
  stdin 输入）。
- 已进入合并或发布链路的 Run 视为不可变交付记录，不能再 `reopen` 修改；新的
  需求或修复应创建新 Run，避免旧发布记录错误关联到新代码。

## A3 部署面板

- `GET /api/deployments`（只读）返回：
  - `web.version`（`PI_WEB_VERSION` 优先，否则 `PI_VERSION`）、`worker.version`
    （`PI_WORKER_VERSION`）；未知为 `null`。
  - `rollbackTags`（`PI_ROLLBACK_TAGS`，逗号分隔）。
  - `records`：部署日志（`PI_DEPLOY_LOG`，默认 `/app/pi-agent/backups/deploy.log`）
    的最近记录，逐行容错解析（JSON 行或 `key=value` 文本；坏行跳过）；
    文件缺失返回空数组且 `log.available=false`，绝不报错。
- UI 在侧边栏显示紧凑面板，未知/不可用均明确标注。

## B1 重新打开已交付任务

- `POST /api/runs/:id/reopen`，body `{note?, confirm?}`。
- 仅 `completed` 可重新打开（状态机新增受控边 `completed -> needs_human`）；
  管理员可直接执行，所有者需 `confirm: true`。
- 记录事件 `run.reopened`（meta: `{reopenedBy, reason, note}`），备注写入
  `humanNotes`（新增 kind `reopen`），并写入 `reopenedAt/reopenedBy`。
- 运行分支与 worktree 保持原样，不触碰 Worker 文件系统。
- UI：已完成任务详情页显示「重新打开」，带二次确认。

## B2 验收快照

`mode:"accept"` 受理时计算并持久化 `run.acceptance`：

- 已解决 / 未解决意见（id + severity），diff 制品 id/sha256/bytes，
  检查通过/失败计数，模型调用与成本，受理人与备注。
- `run.approved` 事件 meta 同时携带快照，事件名保持向后兼容。
- UI：详情页「验收快照」面板，带「复制 JSON」按钮。

## B3 批量操作

- `POST /api/runs/batch`，body `{action: "continue"|"accept"|"cleanup", runIds[],
  note?, acknowledgeOpenFindings?}`；`runIds` 去重后最多 50 个，按所有者过滤。
- 逐个任务给出结果数组与汇总（`total/succeeded/failed/results`），部分失败逐条
  报告（含 code 与原因）。
- `accept` 与单任务一致：存在未解决意见时必须确认；`cleanup` 复用终态清理语义
  （数据库记录 + 尽力删除 Worker 运行目录）。
- UI：任务列表多选 + 批量操作栏（接受交付 / 继续开发 / 清理），均带确认。

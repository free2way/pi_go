# 11 · 系统状态仪表盘（SYS-01）

> 目标：把侧边栏里「点不动」的 `运行状态` 入口变成一个真正有用的只读系统状态页面。

## 1. 背景：那个「运行状态」是什么

`src/client/App.tsx` 的侧边栏此前渲染的是：

```tsx
<a href="#system"><Activity size={16} />运行状态</a>   // 旧代码
```

它指向侧边栏部署卡片上的 `id="system"`，但锚点在同一个滚动容器内、目标已在视口内，所以点击没有任何可见效果 —— 这就是操作员反馈的「点不动」的元素。

**处理方式**：把它改成 `<button>`，点击后打开新的「系统状态」页面；同时给侧边栏的部署卡片标题加了一个「系统状态 →」入口。没有删除该元素，因为它现在正是这个功能的入口。仪表盘本身也比删除更有用：它把版本、健康、队列、用量和异常集中在一处。

## 2. 服务端：`GET /api/system/status`

- 认证：与其它 `/api/*` 一致，需要已登录用户（全局 `preHandler`）。
- 只读；`Cache-Control: no-store` 由既有 `onSend` 钩子统一设置。
- 所有查询都有界；任何一段读取失败都返回显式的 `unavailable`，而不是让整个接口 500。
- **不返回**密钥、令牌、环境变量值或任何服务器文件路径。

### 响应结构（`schemaVersion: 1`，可增量演进）

```jsonc
{
  "schemaVersion": 1,
  "at": "2026-10-04T12:00:00.000Z",
  "versions": {
    "web": "0.22.0",           // PI_WEB_VERSION → PI_VERSION，未知为 null
    "worker": "0.22.0"         // Worker /health 的 version → PI_WORKER_VERSION，未知为 null
  },
  "infrastructure": {
    "database": { "status": "ok" | "unavailable" },          // 带超时的 SELECT 1
    "worker":   { "status": "ok" | "unreachable" | "unknown", // Worker /health（3s 超时）
                  "activeJobs": 2, "storage": "ok" | "low" | "critical" }
  },
  "queue": {                    // status=unavailable 表示无法查询
    "status": "ok" | "unavailable",
    "byState": { "queued": 0, "claimed": 0, "done": 0, "failed": 0, "cancelled": 0 },
    "total": 0, "active": 0,    // active = queued + claimed
    "oldestQueuedAt": null, "oldestQueuedAgeMs": null
  },
  "runs": {                     // 全部运行按状态聚合
    "status": "ok" | "unavailable",
    "byState": { /* 9 个 RunState，缺失补 0 */ },
    "total": 0,
    "active": { "queued": 0, "preparing": 0, "developing": 0, "checking": 0, "reviewing": 0, "total": 0 },
    "oldestQueuedAt": null, "oldestQueuedAgeMs": null
  },
  "usage": {                    // 当日（UTC）用量，best-effort 估算
    "status": "ok" | "unavailable",
    "date": "2026-10-04", "basis": "runs-updated-today",
    "scannedRuns": 0, "truncated": false,
    "modelCalls": 12,          // 无任何 run 暴露调用数时为 null（未知）
    "inputTokens": 0, "outputTokens": 0, "totalTokens": 0, "estimatedCost": 0
  },
  "failures": {                 // 最近 24h 异常（按事件类型前缀筛选）
    "status": "ok" | "unavailable",
    "windowHours": 24,
    "byCategory": { "storage": 0, "budget": 0, "provider": 0, "failure_artifact": 0, "other": 0 },
    "total": 0, "scanned": 0, "truncated": false,
    "recent": [ { "at": "…", "type": "run.storage_error", "category": "storage", "summary": "…" } ]
  },
  "deployments": {              // 复用 /api/deployments 数据（去掉 log.path）
    "web": { "version": null }, "worker": { "version": null },
    "rollbackTags": [], "records": [], "log": { "available": false }, "at": "…"
  }
}
```

### 字段语义与「未知 / 不可用」

| 值 | 含义 |
| --- | --- |
| `null` | 该值确实无法确定（如版本未配置、最老排队时间不可解析） |
| `status: "unavailable"` | 该段数据源不可读（队列/运行/用量/异常查询失败，或非 PostgreSQL 存储） |
| `infrastructure.database.status: "unavailable"` | 数据库探测（2s 超时）失败 |
| `infrastructure.worker.status: "unreachable"` | Worker `/health`（3s 超时）失败；`unknown` 保留给未来扩展 |
| `usage.modelCalls: null` | 窗口内没有任何 run 暴露调用次数 |
| `truncated: true` | 命中扫描上限（异常 500 条 / 当日 run 500 条），计数为下界 |

### 隐私边界

- 数据库错误只在服务端日志记录，接口只回 `unavailable`，不回错误文本（可能含主机信息）。
- 异常摘要经过 `sanitizeFailureSummary`：折叠空白、把 URL 与绝对路径替换为 `[url]` / `[path]`、截断到 160 字符。
- `deployments` 复用 `/api/deployments` 的版本、回滚标签、记录与可用性，但**删除 `log.path` 和读取错误**（专门接口仍保留这些字段）。
- 不外泄该响应的 schema 之外的任何信息；不返回 run id。

### 当日用量说明

存储层只有每个 run（及 role）的**累计**用量，没有按天分桶。因此 `usage` 是「当日有更新的 run」的累计值之和（`basis: "runs-updated-today"`），是**估算**而非精确账单；`scannedRuns` 与 `truncated` 明示口径与界限。

## 3. 代码结构

| 文件 | 作用 |
| --- | --- |
| `src/server/system-status.ts` | 纯函数聚合：`buildSystemStatus(input)`、`failureCategory`、`sanitizeFailureSummary`、`utcDay`/`utcDayStart`、`ageMs`。无副作用、不抛错。 |
| `src/server/index.ts` | `GET /api/system/status` 路由：有界 SQL + `pingDatabase(2s)` + Worker `/health(3s)` + `readDeploymentStatus()`，然后交给纯函数。`workerRequest` 新增可选超时参数；部署读取抽成 `readDeploymentStatus()` 复用。 |
| `src/worker/index.ts` | `/health` 新增 `version` 字段（来自 `PI_WORKER_VERSION`，未设置时为 `null`），供状态页读取。 |
| `src/client/SystemStatusPage.tsx` | 「系统状态」页面：15s 自动刷新 + 暂停/继续 + 手动刷新；5 张卡片。 |
| `src/client/system-status-view.ts` | 展示映射纯函数（`formatAge`/`formatCost`/`formatCompactNumber`/标签/行映射）。 |
| `src/client/api.ts` | `api.systemStatus()` 与 `SystemStatusResponse` 类型。 |
| `src/client/App.tsx` | 侧边栏入口改为按钮 + `view === "system"` 渲染 + 面包屑 + 部署卡片入口。 |

## 4. 测试

- `src/server/system-status.test.ts`（15 项）：未知/不可用状态、队列与运行计数、最老排队时长、当日用量（含 `usageRoles` 回退与 `modelCalls: null`）、异常分类/截断/摘要脱敏、畸形 `document_json` 不抛错。
- `src/client/system-status-view.test.ts`（7 项）：未知值渲染、单位、标签、分类/作业状态行映射。

## 5. 未验证项（需要真实环境）

纯函数与展示映射已由单测覆盖；以下只能在实际运行时确认，本仓库环境（无 Docker、无真实 Worker/PostgreSQL）未验证：

- 真实 PostgreSQL 上 `GROUP BY state` / `run_events` 的 `LIKE` 前缀查询性能与结果（pg-mem 与真实 PG 行为一致，但未在真实库上跑过）。
- 真实 Worker `/health` 返回的 `version`、`activeJobs`、`storage`。
- 真实部署日志（`PI_DEPLOY_LOG`）解析出的最近部署记录。

# 15 · 账户管理（角色 / 状态 / 工作区授权）

> 背景：实例所有者的账户仍是 `role: "user"`，而「接受交付 → 合并到工作区默认分支」是管理员专属操作（服务端 403 `ADMIN_REQUIRED`）。此前没有任何界面能查看或修改角色，所以所有者既看不懂 403，也无法自助提升。本页解决该缺口。

## 1. 服务端 API（仅管理员）

所有 `/api/accounts*` 路由都复用同一个判定：`accountAdminGate(await identities.isAdmin(userId))`。非管理员一律：

```json
{ "error": "仅管理员可以管理账户", "code": "ADMIN_REQUIRED" }
```

HTTP 403。写入 body 由 zod 校验（`.strict()`，未知字段拒绝）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/accounts` | `{ accounts: AccountSummary[] }`，仅返回 `id/email/role/status/createdAt/updatedAt/lastLoginAt/runsOwned/workspacesOwned`。不含身份 issuer/subject、凭据等敏感字段。 |
| GET | `/api/accounts/workspaces` | `{ workspaces: AccountWorkspaceOption[] }`，未解除注册的工作区目录，供授权编辑器选择。注册在 `:id` 之前，保证静态段优先匹配。 |
| GET | `/api/accounts/:id` | `AccountDetail` = 概要 + `grants[]`（`workspaceId/workspaceName/permission/grantedBy/createdAt`）。 |
| PATCH | `/api/accounts/:id` | `{ role?: "admin" \| "user", status?: "active" \| "disabled" }`，至少一个字段。 |
| POST | `/api/accounts/:id/grants` | `{ workspaceId, permission: "read" \| "write" }`，对 `workspace_grants` 做 upsert。 |
| DELETE | `/api/accounts/:id/grants/:workspaceId` | 删除该用户对该工作区的授权。 |

`runsOwned` / `workspacesOwned` 会同时统计内部 `id` 与迁移前的 `legacy_owner_id` 两个 owner key；`workspacesOwned` 不计已解除注册（`unregistered`）的工作区。

## 2. 护栏（`planAccountChange`，纯函数、单测覆盖）

| 场景 | 结果 |
| --- | --- |
| 未提供任何实际变化（值相同） | 400 `NO_CHANGES` |
| 修改**自己**的角色 | 409 `SELF_ROLE_CHANGE` |
| 降级或禁用**最后一个可用管理员**（`role=admin AND status=active` 计数 ≤ 1） | 409 `LAST_ADMIN` |
| 其它情况 | 允许，写入 `user_audit` |

「最后一个可用管理员」不会因为并发的两次请求而被绕过：计数在**同一事务内**于 `UPDATE` 之前读取。

## 3. 审计（`user_audit`，migration 10）

复用检查结论：仓库内没有可复用的审计表（告警只在内存），因此新增最小表：

```sql
CREATE TABLE user_audit (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  target_user_id TEXT NOT NULL,
  action TEXT NOT NULL,        -- account.role_changed | account.status_changed
  field TEXT NOT NULL,         -- role | status
  before_value TEXT,
  after_value TEXT,
  created_at TEXT NOT NULL
);
```

角色与状态同一次请求变更时写两行。更新账户行与审计插入在同一个 `db.withTransaction` 中，不会出现「改了但没审计」。

## 4. 客户端

- 新增「账户管理」页面（`src/client/AccountsPage.tsx`）。侧边栏入口**仅管理员可见**（`user?.isAdmin`）；非管理员直接导航时显示明确的「仅管理员可见」状态，而不是一个必然失败的请求。
- 用户表：邮箱 / 角色 / 状态 / 创建时间 / 最近登录 / 拥有任务 / 拥有工作区 / 操作。角色与状态用下拉框，变更前二次确认；自己那行角色锁定并给出原因，最后一个可用管理员的角色/状态一并锁定并给出原因（与服务器护栏一致）。
- 每行可展开工作区授权编辑器：选择工作区 + `read`/`write`，并列出/移除已有授权。
- 视觉沿用现有风格与 `--panel-*` 字体变量（`src/client/styles.css` 的 `.ac-*`）。

## 5. 运行详情的合并选项（UX 修复）

`mergeOptionState(user)`（`src/client/merge-option.ts`，纯函数）决定「审批通过后合并到工作区默认分支」复选框的状态：管理员可用；非管理员（以及 `/api/me` 尚未返回时）**禁用并展示原因**，绝不提交 `mergeIntoWorkspace`，因此不会再触发只有管理员才能成功的 403。`/api/me` 早已返回 `isAdmin`，无需改动。

## 6. 测试

- `src/server/accounts.test.ts`：护栏（自改角色、最后管理员、NO_CHANGES）、审计行 shaping、管理员/普通用户 gating、列表投影不含敏感字段、pg-mem 下的计数/授权增删改与审计落库。
- `src/client/merge-option.test.ts`：合并选项对 admin / 普通用户 / 身份未加载的 gating。

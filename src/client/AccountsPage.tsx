import {
  AlertTriangle,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  ShieldOff,
  Trash2,
  UserCog,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AccountDetail, AccountSummary, AccountWorkspaceOption, CurrentUser } from "../shared/types";
import { api } from "./api";

const roleLabels: Record<AccountSummary["role"], string> = { admin: "管理员", user: "普通用户" };
const statusLabels: Record<AccountSummary["status"], string> = { active: "已启用", disabled: "已禁用" };
const permissionLabels: Record<"read" | "write", string> = { read: "只读", write: "读写" };

const formatTime = (date: string | null | undefined) =>
  date
    ? new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(date))
    : "—";

/** Human explanation for the guardrail codes the server can return. */
export function describeAccountError(cause: unknown): string {
  const code = (cause as { code?: string }).code;
  switch (code) {
    case "ADMIN_REQUIRED":
      return "仅管理员可以管理账户。";
    case "SELF_ROLE_CHANGE":
      return "不能修改自己的角色：请让另一位管理员操作。";
    case "LAST_ADMIN":
      return "不能降级或禁用最后一个可用管理员：请先指派另一位管理员。";
    case "NO_CHANGES":
      return "没有需要变更的角色或状态。";
    case "ACCOUNT_NOT_FOUND":
      return "账户不存在，可能已被移除。";
    case "WORKSPACE_NOT_FOUND":
      return "工作区不存在，可能已解除注册。";
    default:
      return (cause as Error).message || "操作失败，请稍后重试。";
  }
}

/** The single active admin may not be demoted or disabled — mirrors the server's LAST_ADMIN guard. */
function isLockedLastAdmin(account: AccountSummary, accounts: AccountSummary[]): boolean {
  if (account.role !== "admin" || account.status !== "active") return false;
  return accounts.filter((item) => item.role === "admin" && item.status === "active").length <= 1;
}

export function AccountsPage({ user }: { user?: CurrentUser }) {
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [workspaces, setWorkspaces] = useState<AccountWorkspaceOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [pendingId, setPendingId] = useState("");
  const [expandedId, setExpandedId] = useState("");
  const [detail, setDetail] = useState<AccountDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [grantWorkspaceId, setGrantWorkspaceId] = useState("");
  const [grantPermission, setGrantPermission] = useState<"read" | "write">("read");
  const [grantBusy, setGrantBusy] = useState(false);
  const [actionError, setActionError] = useState("");

  const isAdmin = Boolean(user?.isAdmin);

  const load = useCallback(async () => {
    setLoadError("");
    try {
      const [accountResult, workspaceResult] = await Promise.all([api.accounts(), api.accountWorkspaces()]);
      setAccounts(accountResult.accounts);
      setWorkspaces(workspaceResult.workspaces);
    } catch (cause) {
      setLoadError(describeAccountError(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  // Only an admin may call the account routes at all; a direct navigation by a
  // non-admin gets the explicit 「仅管理员可见」 state below instead of a failed fetch.
  useEffect(() => {
    if (isAdmin) void load();
    else setLoading(false);
  }, [isAdmin, load]);

  const openGrants = useCallback(async (account: AccountSummary) => {
    if (expandedId === account.id) {
      setExpandedId("");
      setDetail(null);
      return;
    }
    setExpandedId(account.id);
    setDetail(null);
    setDetailLoading(true);
    setActionError("");
    try {
      setDetail(await api.account(account.id));
    } catch (cause) {
      setActionError(describeAccountError(cause));
    } finally {
      setDetailLoading(false);
    }
  }, [expandedId]);

  const patchAccount = async (account: AccountSummary, patch: { role?: "admin" | "user"; status?: "active" | "disabled" }) => {
    const changes: string[] = [];
    if (patch.role !== undefined && patch.role !== account.role) changes.push(`角色 ${roleLabels[account.role]} → ${roleLabels[patch.role]}`);
    if (patch.status !== undefined && patch.status !== account.status) changes.push(`状态 ${statusLabels[account.status]} → ${statusLabels[patch.status]}`);
    if (changes.length === 0) return;
    const extra = patch.status === "disabled" && account.id === user?.id ? "\n\n注意：这是你自己的账户，禁用后你将无法再登录。" : "";
    if (!window.confirm(`确认修改账户「${account.email}」？\n\n${changes.join("\n")}${extra}`)) return;
    setPendingId(account.id);
    setActionError("");
    try {
      const updated = await api.patchAccount(account.id, patch);
      setAccounts((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      if (detail?.id === updated.id) setDetail(updated);
    } catch (cause) {
      window.alert(`保存失败：${describeAccountError(cause)}`);
    } finally {
      setPendingId("");
    }
  };

  const addGrant = async (account: AccountSummary) => {
    if (!grantWorkspaceId) return;
    setGrantBusy(true);
    setActionError("");
    try {
      const updated = await api.addAccountGrant(account.id, { workspaceId: grantWorkspaceId, permission: grantPermission });
      setDetail(updated);
      setGrantWorkspaceId("");
      setGrantPermission("read");
    } catch (cause) {
      setActionError(describeAccountError(cause));
    } finally {
      setGrantBusy(false);
    }
  };

  const removeGrant = async (account: AccountSummary, workspaceId: string, workspaceName: string | null) => {
    if (!window.confirm(`移除该账户对「${workspaceName || workspaceId}」的工作区授权？`)) return;
    setGrantBusy(true);
    setActionError("");
    try {
      setDetail(await api.removeAccountGrant(account.id, workspaceId));
    } catch (cause) {
      setActionError(describeAccountError(cause));
    } finally {
      setGrantBusy(false);
    }
  };

  const availableWorkspaces = useMemo(() => {
    const granted = new Set((detail?.grants ?? []).map((grant) => grant.workspaceId));
    return workspaces.filter((workspace) => !granted.has(workspace.id));
  }, [detail, workspaces]);

  if (user && !isAdmin) {
    return (
      <div className="accounts-page">
        <section className="ac-heading">
          <div>
            <span className="eyebrow">ACCOUNT MANAGEMENT</span>
            <h1>账户管理</h1>
          </div>
        </section>
        <div className="ac-denied">
          <ShieldOff size={26} />
          <strong>仅管理员可见</strong>
          <span>账户管理（角色、状态与工作区授权）仅对管理员开放。如需访问，请联系任意管理员将你的角色调整为 admin。</span>
        </div>
      </div>
    );
  }

  return (
    <div className="accounts-page">
      <section className="ac-heading">
        <div>
          <span className="eyebrow">ACCOUNT MANAGEMENT</span>
          <h1>账户管理</h1>
          <p>管理本实例的用户角色与状态，并为用户分配工作区 read/write 授权。降级或禁用最后一个可用管理员、修改自己的角色都会被服务器拒绝；所有变更都会写入审计记录。</p>
        </div>
        <div className="ac-heading-actions">
          <button className="button secondary" type="button" disabled={loading} onClick={() => void load()}>
            {loading ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}刷新
          </button>
        </div>
      </section>

      {loadError && <div className="form-error">{loadError}</div>}
      {actionError && <div className="form-error">{actionError}</div>}

      {loading ? (
        <div className="ac-empty"><LoaderCircle className="spin" size={20} /><span>正在加载账户…</span></div>
      ) : accounts.length === 0 ? (
        <div className="ac-empty"><Users size={26} /><strong>还没有账户</strong><span>用户会在首次登录时自动创建。</span></div>
      ) : (
        <div className="ac-table-wrap panel">
          <table className="ac-table">
            <thead>
              <tr>
                <th>邮箱</th>
                <th>角色</th>
                <th>状态</th>
                <th>创建时间</th>
                <th>最近登录</th>
                <th>拥有任务</th>
                <th>拥有工作区</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => {
                const self = account.id === user?.id;
                const locked = isLockedLastAdmin(account, accounts);
                const selfRoleHint = self ? "不能修改自己的角色：请让另一位管理员操作" : undefined;
                const lastAdminHint = locked ? "最后一个可用管理员：不能降级或禁用" : undefined;
                return (
                  <tr key={account.id} className={expandedId === account.id ? "is-expanded" : ""}>
                    <td className="ac-email" title={account.id}>
                      {self && <ShieldCheck size={12} className="ac-self" />}
                      <span>{account.email}</span>
                    </td>
                    <td>
                      <select
                        className="ac-select"
                        value={account.role}
                        disabled={Boolean(pendingId) || self || locked}
                        title={selfRoleHint ?? lastAdminHint}
                        onChange={(event) => void patchAccount(account, { role: event.target.value === "admin" ? "admin" : "user" })}
                      >
                        <option value="user">普通用户</option>
                        <option value="admin">管理员</option>
                      </select>
                    </td>
                    <td>
                      <span className={`ac-badge ac-status-${account.status}`}>{statusLabels[account.status]}</span>
                      <select
                        className="ac-select"
                        value={account.status}
                        disabled={Boolean(pendingId) || locked}
                        title={lastAdminHint}
                        onChange={(event) => void patchAccount(account, { status: event.target.value === "disabled" ? "disabled" : "active" })}
                      >
                        <option value="active">已启用</option>
                        <option value="disabled">已禁用</option>
                      </select>
                    </td>
                    <td className="ac-time">{formatTime(account.createdAt)}</td>
                    <td className="ac-time">{formatTime(account.lastLoginAt)}</td>
                    <td className="ac-num">{account.runsOwned}</td>
                    <td className="ac-num">{account.workspacesOwned}</td>
                    <td className="ac-actions">
                      {pendingId === account.id && <LoaderCircle className="spin" size={13} />}
                      <button type="button" onClick={() => void openGrants(account)}>
                        <UserCog size={13} />{expandedId === account.id ? "收起授权" : "工作区授权"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {expandedId && (
            <div className="ac-grants">
              {detailLoading ? (
                <div className="ac-grants-loading"><LoaderCircle className="spin" size={16} /><span>正在加载授权…</span></div>
              ) : detail && detail.id === expandedId ? (
                <>
                  <div className="ac-grants-head">
                    <strong>{detail.email} 的工作区授权</strong>
                    <span>read 只能浏览/启动任务，write 才能修改工作区元数据。</span>
                  </div>
                  {detail.grants.length === 0 ? (
                    <div className="ac-grants-empty">该账户暂无工作区授权。</div>
                  ) : (
                    <ul className="ac-grant-list">
                      {detail.grants.map((grant) => (
                        <li key={grant.workspaceId}>
                          <span className="ac-grant-name">{grant.workspaceName || grant.workspaceId}</span>
                          <code>{grant.workspaceId}</code>
                          <span className={`ac-badge ac-perm-${grant.permission}`}>{permissionLabels[grant.permission]}</span>
                          <button type="button" className="danger" disabled={grantBusy} onClick={() => void removeGrant(detail, grant.workspaceId, grant.workspaceName)}>
                            <Trash2 size={12} />移除
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="ac-grant-add">
                    <select value={grantWorkspaceId} disabled={grantBusy || availableWorkspaces.length === 0} onChange={(event) => setGrantWorkspaceId(event.target.value)}>
                      <option value="">{availableWorkspaces.length === 0 ? "没有可授权的工作区" : "选择工作区…"}</option>
                      {availableWorkspaces.map((workspace) => (
                        <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
                      ))}
                    </select>
                    <select value={grantPermission} disabled={grantBusy} onChange={(event) => setGrantPermission(event.target.value === "write" ? "write" : "read")}>
                      <option value="read">只读 (read)</option>
                      <option value="write">读写 (write)</option>
                    </select>
                    <button type="button" className="button primary" disabled={grantBusy || !grantWorkspaceId} onClick={() => void addGrant(detail)}>
                      {grantBusy ? <LoaderCircle className="spin" size={13} /> : <ShieldCheck size={13} />}授权
                    </button>
                  </div>
                </>
              ) : (
                <div className="ac-grants-empty">无法加载该账户的授权。</div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="ac-footnote">
        <AlertTriangle size={12} />
        审计：角色/状态变更会记录 actor 与目标账户的 before/after（user_audit 表）。身份提供方与 subject 等敏感信息不会在此页面展示。
      </div>
    </div>
  );
}

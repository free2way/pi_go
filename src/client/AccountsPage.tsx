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
import { DEFAULT_LOCALE, intlLocale, t, type Locale } from "../shared/i18n";
import { api } from "./api";
import { useT } from "./i18n";

const roleKeys = { admin: "accounts.role.admin", user: "accounts.role.user" } as const;
const statusKeys = { active: "accounts.status.active", disabled: "accounts.status.disabled" } as const;
const permissionKeys = { read: "accounts.perm.read", write: "accounts.perm.write" } as const;

const formatTime = (date: string | null | undefined, locale: Locale = DEFAULT_LOCALE) =>
  date
    ? new Intl.DateTimeFormat(intlLocale(locale), { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(date))
    : "—";

/** Human explanation for the guardrail codes the server can return. */
export function describeAccountError(cause: unknown, locale: Locale = DEFAULT_LOCALE): string {
  const error = cause as { code?: string; message?: string };
  switch (error.code) {
    case "ADMIN_REQUIRED":
      return t(locale, "accounts.error.ADMIN_REQUIRED");
    case "SELF_ROLE_CHANGE":
      return t(locale, "accounts.error.SELF_ROLE_CHANGE");
    case "LAST_ADMIN":
      return t(locale, "accounts.error.LAST_ADMIN");
    case "NO_CHANGES":
      return t(locale, "accounts.error.NO_CHANGES");
    case "ACCOUNT_NOT_FOUND":
      return t(locale, "accounts.error.ACCOUNT_NOT_FOUND");
    case "WORKSPACE_NOT_FOUND":
      return t(locale, "accounts.error.WORKSPACE_NOT_FOUND");
    default:
      return error.message || t(locale, "accounts.error.generic");
  }
}

/** The single active admin may not be demoted or disabled — mirrors the server's LAST_ADMIN guard. */
function isLockedLastAdmin(account: AccountSummary, accounts: AccountSummary[]): boolean {
  if (account.role !== "admin" || account.status !== "active") return false;
  return accounts.filter((item) => item.role === "admin" && item.status === "active").length <= 1;
}

export function AccountsPage({ user }: { user?: CurrentUser }) {
  const { t, locale } = useT();
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
      setLoadError(describeAccountError(cause, locale));
    } finally {
      setLoading(false);
    }
  }, [locale]);

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
      setActionError(describeAccountError(cause, locale));
    } finally {
      setDetailLoading(false);
    }
  }, [expandedId, locale]);

  const patchAccount = async (account: AccountSummary, patch: { role?: "admin" | "user"; status?: "active" | "disabled" }) => {
    const changes: string[] = [];
    if (patch.role !== undefined && patch.role !== account.role) changes.push(t("accounts.changeRole", { from: t(roleKeys[account.role]), to: t(roleKeys[patch.role]) }));
    if (patch.status !== undefined && patch.status !== account.status) changes.push(t("accounts.changeStatus", { from: t(statusKeys[account.status]), to: t(statusKeys[patch.status]) }));
    if (changes.length === 0) return;
    const extra = patch.status === "disabled" && account.id === user?.id ? t("accounts.selfDisableNote") : "";
    if (!window.confirm(t("accounts.patchConfirm", { email: account.email, changes: changes.join("\n"), extra }))) return;
    setPendingId(account.id);
    setActionError("");
    try {
      const updated = await api.patchAccount(account.id, patch);
      setAccounts((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      if (detail?.id === updated.id) setDetail(updated);
    } catch (cause) {
      window.alert(t("accounts.saveFailed", { message: describeAccountError(cause, locale) }));
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
      setActionError(describeAccountError(cause, locale));
    } finally {
      setGrantBusy(false);
    }
  };

  const removeGrant = async (account: AccountSummary, workspaceId: string, workspaceName: string | null) => {
    if (!window.confirm(t("accounts.removeGrantConfirm", { workspace: workspaceName || workspaceId }))) return;
    setGrantBusy(true);
    setActionError("");
    try {
      setDetail(await api.removeAccountGrant(account.id, workspaceId));
    } catch (cause) {
      setActionError(describeAccountError(cause, locale));
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
            <h1>{t("nav.accounts")}</h1>
          </div>
        </section>
        <div className="ac-denied">
          <ShieldOff size={26} />
          <strong>{t("accounts.adminOnly")}</strong>
          <span>{t("accounts.adminOnlyHint")}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="accounts-page">
      <section className="ac-heading">
        <div>
          <span className="eyebrow">ACCOUNT MANAGEMENT</span>
          <h1>{t("nav.accounts")}</h1>
          <p>{t("accounts.subtitle")}</p>
        </div>
        <div className="ac-heading-actions">
          <button className="button secondary" type="button" disabled={loading} onClick={() => void load()}>
            {loading ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}{t("accounts.refresh")}
          </button>
        </div>
      </section>

      {loadError && <div className="form-error">{loadError}</div>}
      {actionError && <div className="form-error">{actionError}</div>}

      {loading ? (
        <div className="ac-empty"><LoaderCircle className="spin" size={20} /><span>{t("accounts.loading")}</span></div>
      ) : accounts.length === 0 ? (
        <div className="ac-empty"><Users size={26} /><strong>{t("accounts.empty")}</strong><span>{t("accounts.emptyHint")}</span></div>
      ) : (
        <div className="ac-table-wrap panel">
          <table className="ac-table">
            <thead>
              <tr>
                <th>{t("accounts.col.email")}</th>
                <th>{t("accounts.col.role")}</th>
                <th>{t("accounts.col.status")}</th>
                <th>{t("accounts.col.createdAt")}</th>
                <th>{t("accounts.col.lastLogin")}</th>
                <th>{t("accounts.col.runsOwned")}</th>
                <th>{t("accounts.col.workspacesOwned")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => {
                const self = account.id === user?.id;
                const locked = isLockedLastAdmin(account, accounts);
                const selfRoleHint = self ? t("accounts.selfRoleHint") : undefined;
                const lastAdminHint = locked ? t("accounts.lastAdminHint") : undefined;
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
                        <option value="user">{t("accounts.role.user")}</option>
                        <option value="admin">{t("accounts.role.admin")}</option>
                      </select>
                    </td>
                    <td>
                      <span className={`ac-badge ac-status-${account.status}`}>{t(statusKeys[account.status])}</span>
                      <select
                        className="ac-select"
                        value={account.status}
                        disabled={Boolean(pendingId) || locked}
                        title={lastAdminHint}
                        onChange={(event) => void patchAccount(account, { status: event.target.value === "disabled" ? "disabled" : "active" })}
                      >
                        <option value="active">{t("accounts.status.active")}</option>
                        <option value="disabled">{t("accounts.status.disabled")}</option>
                      </select>
                    </td>
                    <td className="ac-time">{formatTime(account.createdAt, locale)}</td>
                    <td className="ac-time">{formatTime(account.lastLoginAt, locale)}</td>
                    <td className="ac-num">{account.runsOwned}</td>
                    <td className="ac-num">{account.workspacesOwned}</td>
                    <td className="ac-actions">
                      {pendingId === account.id && <LoaderCircle className="spin" size={13} />}
                      <button type="button" onClick={() => void openGrants(account)}>
                        <UserCog size={13} />{expandedId === account.id ? t("accounts.collapseGrants") : t("accounts.grants")}
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
                <div className="ac-grants-loading"><LoaderCircle className="spin" size={16} /><span>{t("accounts.grantsLoading")}</span></div>
              ) : detail && detail.id === expandedId ? (
                <>
                  <div className="ac-grants-head">
                    <strong>{t("accounts.grantsTitle", { email: detail.email })}</strong>
                    <span>{t("accounts.grantsHint")}</span>
                  </div>
                  {detail.grants.length === 0 ? (
                    <div className="ac-grants-empty">{t("accounts.grantsEmpty")}</div>
                  ) : (
                    <ul className="ac-grant-list">
                      {detail.grants.map((grant) => (
                        <li key={grant.workspaceId}>
                          <span className="ac-grant-name">{grant.workspaceName || grant.workspaceId}</span>
                          <code>{grant.workspaceId}</code>
                          <span className={`ac-badge ac-perm-${grant.permission}`}>{t(permissionKeys[grant.permission])}</span>
                          <button type="button" className="danger" disabled={grantBusy} onClick={() => void removeGrant(detail, grant.workspaceId, grant.workspaceName)}>
                            <Trash2 size={12} />{t("common.remove")}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="ac-grant-add">
                    <select value={grantWorkspaceId} disabled={grantBusy || availableWorkspaces.length === 0} onChange={(event) => setGrantWorkspaceId(event.target.value)}>
                      <option value="">{availableWorkspaces.length === 0 ? t("accounts.noWorkspaces") : t("accounts.selectWorkspace")}</option>
                      {availableWorkspaces.map((workspace) => (
                        <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
                      ))}
                    </select>
                    <select value={grantPermission} disabled={grantBusy} onChange={(event) => setGrantPermission(event.target.value === "write" ? "write" : "read")}>
                      <option value="read">{t("accounts.permReadOption")}</option>
                      <option value="write">{t("accounts.permWriteOption")}</option>
                    </select>
                    <button type="button" className="button primary" disabled={grantBusy || !grantWorkspaceId} onClick={() => void addGrant(detail)}>
                      {grantBusy ? <LoaderCircle className="spin" size={13} /> : <ShieldCheck size={13} />}{t("accounts.grantAction")}
                    </button>
                  </div>
                </>
              ) : (
                <div className="ac-grants-empty">{t("accounts.grantsLoadFailed")}</div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="ac-footnote">
        <AlertTriangle size={12} />
        {t("accounts.footnote")}
      </div>
    </div>
  );
}

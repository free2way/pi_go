import { AlertTriangle, KeyRound, LoaderCircle, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { ConfigStatus, CredentialStatus, ModelCatalogResponse } from "../shared/types";
import { api } from "./api";

const roleLabel = { developer: "开发", reviewer: "审核" } as const;

export function ModelsPage({ config, onChanged }: { config?: ConfigStatus; onChanged: () => void }) {
  const [catalog, setCatalog] = useState<ModelCatalogResponse>();
  const [status, setStatus] = useState<CredentialStatus>();
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [busyProvider, setBusyProvider] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [models, credentials] = await Promise.all([api.models(), api.credentialStatus()]);
      setCatalog(models);
      setStatus(credentials);
      setError("");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const providers = [...new Set((catalog?.models ?? []).map((entry) => entry.provider))];
  const credentialFor = (provider: string) => status?.providers.find((item) => item.provider === provider);

  const saveProvider = async (provider: string) => {
    const apiKey = (keys[provider] || "").trim();
    if (apiKey.length < 12) {
      setError("Key 至少需要 12 个字符。");
      return;
    }
    setBusyProvider(provider);
    setError("");
    try {
      await api.saveCredentials({ provider, apiKey });
      setKeys((current) => ({ ...current, [provider]: "" }));
      await load();
      onChanged();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusyProvider("");
    }
  };

  const removeProvider = async (provider: string) => {
    if (!window.confirm(`删除 ${provider} 的 Key？该 provider 下的模型将不可用于新任务（历史任务不受影响）。`)) return;
    setBusyProvider(provider);
    setError("");
    try {
      await api.deleteCredentials(provider);
      await load();
      onChanged();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusyProvider("");
    }
  };

  return (
    <div className="workspaces-page">
      <section className="ws-heading">
        <div>
          <span className="eyebrow">MODELS &amp; CREDENTIALS</span>
          <h1>模型与凭据</h1>
          <p>模型来自管理员允许目录；开发与审核角色可各自选择模型（可来自不同 provider）。凭据按 provider 使用 AES-256-GCM 加密保存，仅当前账户可用，界面与 API 永不回显明文。</p>
        </div>
      </section>

      <div className={`ws-strip ${config?.realRunsAvailable ? "is-ready" : ""}`}>
        {config?.realRunsAvailable ? <ShieldCheck size={14} /> : <AlertTriangle size={14} />}
        <div>
          <strong>{config?.realRunsAvailable ? "真实执行已启用" : "真实执行尚未就绪"}</strong>
          <span>
            {config?.realRunsAvailable
              ? "已配置至少一个 provider 凭据；创建任务时会按所选开发/审核模型组合做可用性预检。"
              : "真实任务执行需要至少一个已验证的 provider Key，请在下方配置。"}
          </span>
        </div>
      </div>

      {error && <div className="form-error">{error}</div>}
      {loading && <div className="ws-empty"><LoaderCircle className="spin" size={20} /><span>正在加载模型目录…</span></div>}

      <div className="model-grid">
        {providers.map((provider) => {
          const credential = credentialFor(provider);
          const entries = (catalog?.models ?? []).filter((entry) => entry.provider === provider);
          return (
            <article className="panel model-card" key={provider}>
              <div className="panel-head">
                <div><span className="eyebrow">{provider.toUpperCase()}</span><h3>{provider}</h3></div>
                <span className={`model-credential ${credential ? "is-set" : ""}`}>{credential ? `${credential.masked}` : "未配置 Key"}</span>
              </div>
              <div className="model-list">
                {entries.map((entry) => (
                  <div className="model-row" key={entry.id}>
                    <div className="model-name"><strong>{entry.label}</strong><code>{entry.provider}/{entry.model}</code></div>
                    <div className="model-tags">
                      {entry.roles.map((role) => <span key={role}>{roleLabel[role]}</span>)}
                      {entry.reasoning && <span>推理</span>}
                      {/* AUD-08: distinguish configured-but-unverified from missing. */}
                      <span className={entry.available ? "ok" : "warn"}>
                        {entry.available ? (entry.verified ? "已校验可用" : "可用") : entry.unavailableReason === "credential_missing" ? "缺凭据" : "待校验"}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
              <div className="model-credential-form">
                <input
                  type="password"
                  autoComplete="new-password"
                  placeholder={credential ? "输入新 Key 可轮换" : "输入该 provider 的 API Key"}
                  value={keys[provider] || ""}
                  onChange={(event) => setKeys((current) => ({ ...current, [provider]: event.target.value }))}
                />
                <button type="button" className="button primary" disabled={busyProvider === provider || !(keys[provider] || "").trim()} onClick={() => void saveProvider(provider)}>
                  {busyProvider === provider ? <LoaderCircle className="spin" size={14} /> : <KeyRound size={14} />}安全保存
                </button>
                {credential && (
                  <button type="button" className="button danger-text" disabled={busyProvider === provider} onClick={() => void removeProvider(provider)}>删除 Key</button>
                )}
              </div>
            </article>
          );
        })}
      </div>

      {catalog && (
        <p className="credential-help">
          默认选择：开发 {catalog.defaultDeveloper.provider}/{catalog.defaultDeveloper.model} · 审核 {catalog.defaultReviewer.provider}/{catalog.defaultReviewer.model}（新建任务时可单独覆盖；任务创建后模型即固化，不受后续默认值或 Key 轮换影响）。
        </p>
      )}
    </div>
  );
}

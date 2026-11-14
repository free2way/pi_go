import { Activity, Bot, Braces } from "lucide-react";
import { DEFAULT_LOCALE, intlLocale, type Locale } from "../../shared/i18n";
import { useT } from "../i18n";
import type { RunState } from "../../shared/types";
import { runStateKey } from "../requirement-history";

export function Logo() {
  return (
    <div className="brand">
      <div className="brand-mark"><Braces size={19} /></div>
      <div><strong>PiGO</strong><span>CONTROL PLANE</span></div>
    </div>
  );
}

export function StatusPill({ state }: { state: RunState }) {
  const { t } = useT();
  return <span className={`status-pill status-${state}`}><i />{t(runStateKey(state))}</span>;
}

export function ProviderStatus({ label, provider, model, ready, icon: Icon }: {
  label: string;
  provider: string;
  model: string;
  ready: boolean;
  icon: typeof Bot;
}) {
  const { t } = useT();
  return (
    <div className="provider-row">
      <div className={`provider-icon ${provider}`}><Icon size={16} /></div>
      <div className="provider-copy"><span>{label}</span><strong>{model}</strong></div>
      <span className={`connection-dot ${ready ? "ready" : "missing"}`} title={t(ready ? "provider.credentialConfigured" : "provider.credentialMissing")} />
    </div>
  );
}


export function EmptyPanel({ icon: Icon, text }: { icon: typeof Activity; text: string }) {
  return <div className="empty-panel"><Icon size={22} /><span>{text}</span></div>;
}


export const formatClock = (date: string, locale: Locale = DEFAULT_LOCALE) => new Intl.DateTimeFormat(intlLocale(locale), { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(date));
export const formatDuration = (ms: number) => ms ? `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s` : "—";
export const compactNumber = (value: number) => value > 999 ? `${(value / 1000).toFixed(1)}k` : String(value);


export const terminalStates: RunState[] = ["completed", "needs_human", "failed", "cancelled"];

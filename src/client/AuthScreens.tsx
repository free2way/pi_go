import { LoaderCircle, RefreshCw } from "lucide-react";
import { useT } from "./i18n";

export function AuthLoadingScreen({ label }: { label?: string }) {
  const { t } = useT();
  return (
    <main className="auth-state" aria-live="polite">
      <LoaderCircle className="spin" size={22} />
      <span>{label ?? t("auth.loading")}</span>
    </main>
  );
}

export function AuthConfigurationError({ message }: { message: string }) {
  const { t } = useT();
  return (
    <main className="auth-state auth-state-error" role="alert">
      <strong>{t("auth.unavailableTitle")}</strong>
      <span>{message}</span>
      <button type="button" onClick={() => window.location.reload()}><RefreshCw size={15} />{t("auth.reload")}</button>
    </main>
  );
}

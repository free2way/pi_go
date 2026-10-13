import { lazy, Suspense, useEffect, useState } from "react";
import { App } from "./App";
import { AuthConfigurationError, AuthLoadingScreen } from "./AuthScreens";
import { useT } from "./i18n";

type AuthConfig =
  | { mode: "development" | "cloudflare"; clerk: null }
  | { mode: "clerk"; clerk: { publishableKey: string; proxyUrl: string } };

const ClerkAuthRoot = lazy(() =>
  import("./ClerkAuthRoot").then((module) => ({ default: module.ClerkAuthRoot })),
);

export function AuthRoot() {
  const [config, setConfig] = useState<AuthConfig>();
  const [errorStatus, setErrorStatus] = useState<number | "unavailable">();
  const { t } = useT();

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/auth/config", { signal: controller.signal, credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) {
          setErrorStatus(response.status);
          return undefined;
        }
        return response.json() as Promise<AuthConfig>;
      })
      .then((next) => { if (next) setConfig(next); })
      .catch(() => {
        if (!controller.signal.aborted) setErrorStatus("unavailable");
      });
    return () => controller.abort();
  }, []);

  if (errorStatus) {
    const message = errorStatus === "unavailable"
      ? t("auth.configUnavailable")
      : t("auth.configHttpFailed", { status: errorStatus });
    return <AuthConfigurationError message={message} />;
  }
  if (!config) return <AuthLoadingScreen />;
  if (config.mode !== "clerk") return <App />;

  return (
    <Suspense fallback={<AuthLoadingScreen />}>
      <ClerkAuthRoot config={config.clerk} />
    </Suspense>
  );
}

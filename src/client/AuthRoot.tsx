import { lazy, Suspense, useEffect, useState } from "react";
import { App } from "./App";
import { AuthConfigurationError, AuthLoadingScreen } from "./AuthScreens";

type AuthConfig =
  | { mode: "development" | "cloudflare"; clerk: null }
  | { mode: "clerk"; clerk: { publishableKey: string; proxyUrl: string } };

const ClerkAuthRoot = lazy(() =>
  import("./ClerkAuthRoot").then((module) => ({ default: module.ClerkAuthRoot })),
);

export function AuthRoot() {
  const [config, setConfig] = useState<AuthConfig>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/auth/config", { signal: controller.signal, credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`身份配置请求失败（HTTP ${response.status}）`);
        return response.json() as Promise<AuthConfig>;
      })
      .then(setConfig)
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "身份配置不可用");
      });
    return () => controller.abort();
  }, []);

  if (error) return <AuthConfigurationError message={error} />;
  if (!config) return <AuthLoadingScreen />;
  if (config.mode !== "clerk") return <App />;

  return (
    <Suspense fallback={<AuthLoadingScreen />}>
      <ClerkAuthRoot config={config.clerk} />
    </Suspense>
  );
}

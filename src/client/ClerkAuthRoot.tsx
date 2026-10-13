import { ClerkFailed, ClerkLoaded, ClerkLoading, ClerkProvider, SignIn, SignUp, useAuth, useClerk } from "@clerk/react";
import { useEffect, useState } from "react";
import { Bot, ShieldCheck } from "lucide-react";
import { App } from "./App";
import { setAuthTokenProvider } from "./api";
import { AuthConfigurationError, AuthLoadingScreen } from "./AuthScreens";

function SignInPortal() {
  const [intent, setIntent] = useState<"sign-in" | "sign-up">("sign-in");
  return (
    <main className="auth-page">
      <section className="auth-story" aria-labelledby="auth-title">
        <div className="auth-brand"><span><Bot size={19} /></span><strong>PiGO</strong></div>
        <p className="auth-kicker">MULTI-AGENT DELIVERY PLATFORM</p>
        <h1 id="auth-title">让开发、审核与发布<br />在同一条智能工作流中完成。</h1>
        <p className="auth-lead">使用邮箱创建账户，由多个专业 Agent 并行开发、独立审核，并把每一次决策留在可追溯的交付链路中。</p>
        <div className="auth-trust"><ShieldCheck size={17} /><span>Clerk 安全会话 · 邮箱验证 · 最小权限</span></div>
      </section>
      <section className="auth-panel" aria-label={intent === "sign-in" ? "登录" : "注册"}>
        <div className="auth-tabs" role="group" aria-label="账户操作">
          <button type="button" aria-pressed={intent === "sign-in"} className={intent === "sign-in" ? "active" : ""} onClick={() => setIntent("sign-in")}>登录</button>
          <button type="button" aria-pressed={intent === "sign-up"} className={intent === "sign-up" ? "active" : ""} onClick={() => setIntent("sign-up")}>邮箱注册</button>
        </div>
        <div className="auth-clerk-slot">
          {intent === "sign-in"
            ? <SignIn routing="hash" />
            : <SignUp routing="hash" />}
        </div>
      </section>
    </main>
  );
}

function ClerkSessionGate() {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const clerk = useClerk();
  const [apiReady, setApiReady] = useState(false);

  useEffect(() => {
    if (!isLoaded || !isSignedIn) {
      setApiReady(false);
      return;
    }
    const remove = setAuthTokenProvider(() => getToken());
    setApiReady(true);
    return () => {
      remove();
      setApiReady(false);
    };
  }, [getToken, isLoaded, isSignedIn]);

  if (!isLoaded) return <AuthLoadingScreen />;
  if (!isSignedIn) return <SignInPortal />;
  if (!apiReady) return <AuthLoadingScreen label="正在建立安全会话…" />;
  return <App onSignOut={() => void clerk.signOut({ redirectUrl: "/" })} />;
}

export function ClerkAuthRoot({ config }: { config: { publishableKey: string; proxyUrl: string } }) {
  return (
    <ClerkProvider
      publishableKey={config.publishableKey}
      proxyUrl={config.proxyUrl}
      signInFallbackRedirectUrl="/"
      signUpFallbackRedirectUrl="/"
      appearance={{
        variables: {
          colorPrimary: "#dff854",
          colorBackground: "#11151a",
          colorForeground: "#f0f2f4",
          colorMutedForeground: "#7f8995",
          colorInput: "#171b21",
          colorInputForeground: "#f0f2f4",
          borderRadius: "0.65rem",
        },
      }}
    >
      <ClerkFailed><AuthConfigurationError message="Clerk 身份服务加载失败，请稍后重试。" /></ClerkFailed>
      <ClerkLoading><AuthLoadingScreen /></ClerkLoading>
      <ClerkLoaded><ClerkSessionGate /></ClerkLoaded>
    </ClerkProvider>
  );
}

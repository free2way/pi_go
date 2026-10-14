import { ClerkFailed, ClerkLoaded, ClerkLoading, ClerkProvider, SignIn, SignUp, useAuth, useClerk } from "@clerk/react";
import { enUS, zhCN } from "@clerk/localizations";
import { useEffect, useState } from "react";
import { Bot, ShieldCheck } from "lucide-react";
import { App } from "./App";
import { setAuthTokenProvider } from "./api";
import { AuthConfigurationError, AuthLoadingScreen } from "./AuthScreens";
import { useT } from "./i18n";
import type { Locale } from "../shared/i18n";

export function clerkLocalizationFor(locale: Locale) {
  if (locale === "en") return enUS;
  return {
    ...zhCN,
    // Clerk's zh-CN catalog currently leaves these two placeholders undefined,
    // which makes the component fall back to English inside an otherwise
    // Chinese form. Keep the narrow overrides here until the upstream catalog
    // provides them.
    formFieldInputPlaceholder__password: "请输入密码",
    formFieldInputPlaceholder__signUpPassword: "请创建密码",
  };
}

export function SignInPortal() {
  const [intent, setIntent] = useState<"sign-in" | "sign-up">("sign-in");
  const { locale, locales, localeLabels, setLocale, t } = useT();
  return (
    <main className="auth-page">
      <div className="auth-language" role="group" aria-label={t("auth.language")}>
        {locales.map((option) => (
          <button
            key={option}
            type="button"
            lang={option === "zh" ? "zh-CN" : "en"}
            aria-pressed={locale === option}
            className={locale === option ? "active" : ""}
            title={localeLabels[option]}
            onClick={() => setLocale(option)}
          >
            {option === "zh" ? "中文" : "EN"}
          </button>
        ))}
      </div>
      <section className="auth-story" aria-labelledby="auth-title">
        <div className="auth-brand"><span><Bot size={19} /></span><strong>PiGO</strong></div>
        <p className="auth-kicker">{t("auth.kicker")}</p>
        <h1 id="auth-title">{t("auth.titleLine1")}<br />{t("auth.titleLine2")}</h1>
        <p className="auth-lead">{t("auth.lead")}</p>
        <div className="auth-trust"><ShieldCheck size={17} /><span>{t("auth.trust")}</span></div>
      </section>
      <section className="auth-panel" aria-label={intent === "sign-in" ? t("auth.signIn") : t("auth.signUp")}>
        <div className="auth-tabs" role="group" aria-label={t("auth.accountActions")}>
          <button type="button" aria-pressed={intent === "sign-in"} className={intent === "sign-in" ? "active" : ""} onClick={() => setIntent("sign-in")}>{t("auth.signIn")}</button>
          <button type="button" aria-pressed={intent === "sign-up"} className={intent === "sign-up" ? "active" : ""} onClick={() => setIntent("sign-up")}>{t("auth.signUp")}</button>
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
  const { t } = useT();

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
  if (!apiReady) return <AuthLoadingScreen label={t("auth.establishingSession")} />;
  return <App onSignOut={() => void clerk.signOut({ redirectUrl: "/" })} />;
}

export function ClerkAuthRoot({ config }: { config: { publishableKey: string; proxyUrl: string } }) {
  const { locale, t } = useT();
  return (
    <ClerkProvider
      publishableKey={config.publishableKey}
      proxyUrl={config.proxyUrl}
      signInFallbackRedirectUrl="/"
      signUpFallbackRedirectUrl="/"
      localization={clerkLocalizationFor(locale)}
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
      <ClerkFailed><AuthConfigurationError message={t("auth.clerkLoadFailed")} /></ClerkFailed>
      <ClerkLoading><AuthLoadingScreen /></ClerkLoading>
      <ClerkLoaded><ClerkSessionGate /></ClerkLoaded>
    </ClerkProvider>
  );
}

import { LoaderCircle, RefreshCw } from "lucide-react";

export function AuthLoadingScreen({ label = "正在连接身份服务…" }: { label?: string }) {
  return (
    <main className="auth-state" aria-live="polite">
      <LoaderCircle className="spin" size={22} />
      <span>{label}</span>
    </main>
  );
}

export function AuthConfigurationError({ message }: { message: string }) {
  return (
    <main className="auth-state auth-state-error" role="alert">
      <strong>暂时无法打开登录</strong>
      <span>{message}</span>
      <button type="button" onClick={() => window.location.reload()}><RefreshCw size={15} />重新加载</button>
    </main>
  );
}

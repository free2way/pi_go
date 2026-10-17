import { lazy, Suspense } from "react";
import { AuthLoadingScreen } from "./AuthScreens";

const App = lazy(() =>
  import("./App").then((module) => ({ default: module.App })),
);

export function AppLoader({ onSignOut }: { onSignOut?: () => void }) {
  return (
    <Suspense fallback={<AuthLoadingScreen />}>
      <App onSignOut={onSignOut} />
    </Suspense>
  );
}

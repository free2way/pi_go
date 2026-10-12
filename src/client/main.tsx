import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import { AuthRoot } from "./AuthRoot";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthRoot />
  </StrictMode>,
);


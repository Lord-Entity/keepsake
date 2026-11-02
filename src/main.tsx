import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/theme.css";
import { App } from "./App";

// Production only: block the native context menu. Dev builds keep it for inspection.
if (import.meta.env.PROD) {
  document.addEventListener("contextmenu", (event) => event.preventDefault());
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

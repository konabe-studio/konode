import React from "react";
import ReactDOM from "react-dom/client";
import { ErrorBoundary } from "@/lib/ui/error-boundary";
import OptionsApp from "./App";
import "../index.css";
import "../theme.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary surface="options">
      <OptionsApp />
    </ErrorBoundary>
  </React.StrictMode>
);

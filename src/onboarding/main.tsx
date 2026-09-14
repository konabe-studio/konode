import React from "react";
import ReactDOM from "react-dom/client";
import { ErrorBoundary } from "@/lib/ui/error-boundary";
import { applyDocumentLanguage } from "@/lib/utils/i18n";
import OnboardingApp from "./App";
import "../theme.css";

// Before the first render, while the page is still the English the markup claims it is.
applyDocumentLanguage();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary surface="onboarding">
      <OnboardingApp />
    </ErrorBoundary>
  </React.StrictMode>
);

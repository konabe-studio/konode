import React from "react";
import ReactDOM from "react-dom/client";
import { ErrorBoundary } from "@/lib/ui/error-boundary";
import OnboardingApp from "./App";
import "../theme.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary surface="onboarding">
      <OnboardingApp />
    </ErrorBoundary>
  </React.StrictMode>
);

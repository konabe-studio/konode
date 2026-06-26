import React from "react";
import ReactDOM from "react-dom/client";
import PopupApp from "./App";
import "../index.css";

// Opt the popup into the system-following light/dark theme (`.sk-body` in
// index.css). Scoped to this entry, so options/onboarding stay on the dark theme.
document.body.classList.add("sk-body");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <PopupApp />
  </React.StrictMode>
);

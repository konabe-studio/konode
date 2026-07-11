// Derive the Firefox manifest from the canonical Chrome manifest
// (public/manifest.json). Run after a Vite build into dist-firefox/ — Vite copies
// the Chrome manifest there, and this overwrites it with the Firefox variant.
//
// Usage: node scripts/make-firefox-manifest.mjs [outPath]
//   outPath defaults to dist-firefox/manifest.json
//
// Chrome ⇄ Firefox manifest differences we account for:
//   - background: Chrome MV3 requires `service_worker`; Firefox loads a
//     non-persistent event page via `background.scripts` (ES module supported on
//     Firefox 121+). Same bundled file (background.js), different key.
//   - `key`: Chrome-only (pins the extension ID for a stable OAuth redirect).
//     Firefox derives its ID from browser_specific_settings.gecko.id instead.
//   - browser_specific_settings.gecko: Firefox needs an explicit, STABLE add-on id
//     and a minimum version (module background scripts → 128.0 baseline).
//
// Everything else (permissions, optional_permissions, host_permissions,
// optional_host_permissions, action, options_ui, icons, CSP) is valid on Firefox
// MV3 as-is.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const srcPath = resolve(repoRoot, "public/manifest.json");
const outPath = resolve(repoRoot, process.argv[2] ?? "dist-firefox/manifest.json");

// ⚠️ MUST be confirmed before the first AMO upload — changing it after publish
// creates a brand-new listing. Tracks the planned brand domain (konode.org).
const GECKO_ID = "konode@konode.org";
const STRICT_MIN_VERSION = "128.0";

const manifest = JSON.parse(readFileSync(srcPath, "utf8"));

// Chrome-only: drop the pinned key (Firefox uses the gecko id).
delete manifest.key;

// Event-page background (module), not a service worker.
manifest.background = {
  scripts: ["background.js"],
  type: "module",
};

manifest.browser_specific_settings = {
  gecko: {
    id: GECKO_ID,
    strict_min_version: STRICT_MIN_VERSION,
  },
};

writeFileSync(outPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`Firefox manifest written → ${outPath}`);

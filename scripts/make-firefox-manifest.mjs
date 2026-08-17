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
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { pruneUnshippedLocales } from "./prune-locales.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const srcPath = resolve(repoRoot, "public/manifest.json");
const outPath = resolve(repoRoot, process.argv[2] ?? "dist-firefox/manifest.json");

// Firefox add-on id. An email-form id is the convention when you don't own a domain, and
// when this was chosen konode.org was neither registered nor ours (the domain + marketing
// site were dropped 2026-07-16), so the earlier `konode@konode.org` pointed at a domain
// that did not exist. `konabe@proton.me` is the contact address already used everywhere
// else (README, PRIVACY.md, the options Feedback link).
//
// konode.org IS ours again since, and serves the site. That changes NOTHING here.
//
// DO NOT "tidy" this into `konode@konode.org` now that the domain resolves. The id is
// STABLE once AMO has a listing: a different id is a brand-new add-on that loses its
// reviews, its ratings and every existing user's updates. AMO has listed Konode since
// 2026-08-04, so the window in which this was free to change is closed. An earlier version
// of this comment said "nothing is uploaded to AMO yet, so changing it is still free",
// which was true when written and would now be an expensive thing to believe.
//
// It is ALSO locked to the Google OAuth client, see driveRedirectFor() below.
const GECKO_ID = "konabe@proton.me";
const STRICT_MIN_VERSION = "128.0";

/**
 * Firefox's `identity.getRedirectURL(path)` returns
 *   https://<sha1(add-on id)>.extensions.allizom.org/<path>
 *
 * A deterministic function of the id, so unlike the per-install
 * `moz-extension://<uuid>/` origin it IS stable across profiles and installs and CAN be
 * registered as an Authorized redirect URI. Which also means: change GECKO_ID and Drive
 * sign-in breaks with `redirect_uri_mismatch` until the NEW url is registered in the
 * Google Cloud Console.
 *
 * Printed at the end of every build, because that coupling is otherwise invisible —
 * nothing in the code or the manifest mentions the Cloud Console.
 */
const driveRedirectFor = (id) =>
  `https://${createHash("sha1").update(id).digest("hex")}.extensions.allizom.org/gdrive`;

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
    // Konode has no server and no telemetry — nothing is collected by us or
    // Mozilla; all data goes to storage the user owns. Declare that explicitly
    // (Mozilla's data-consent key; clears the AMO/web-ext "missing" notice).
    data_collection_permissions: { required: ["none"] },
  },
};

writeFileSync(outPath, JSON.stringify(manifest, null, 2) + "\n");

// Same rule as the Chrome package: ship the finished languages only. AMO accepts a package
// carrying half-translated locales without complaint, where the Web Store rejects it, so
// nothing here would have told us — the reason to do it is the users, not the validator.
pruneUnshippedLocales(join(dirname(outPath), "_locales"), manifest.default_locale);

console.log(`Firefox manifest written → ${outPath}`);
console.log(`  add-on id:      ${GECKO_ID}`);
console.log(`  Drive redirect: ${driveRedirectFor(GECKO_ID)}`);
console.log("  ↑ must be an Authorized redirect URI on the Google OAuth client, or");
console.log("    Drive sign-in fails with redirect_uri_mismatch on Firefox.");

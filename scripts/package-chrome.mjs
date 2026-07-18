// Zip the built dist/ into a Chrome Web Store upload package.
//
// Run after `npm run build`. Produces web-ext-artifacts/konode-chrome-<version>.zip
// with manifest.json at the archive root (what the Web Store expects).
//
// The manifest `key` is STRIPPED from the store package. It's kept in
// public/manifest.json (and thus dist/) on purpose — it pins the extension ID for
// local unpacked dev and the dev OAuth redirect — but the Chrome Web Store rejects
// a first upload whose manifest contains `key` ("key field not allowed in
// manifest"). So we zip from a temp staging copy with `key` removed; dist/ itself
// is left untouched for `chrome://extensions` dev loading.
//
// After the store assigns the published extension ID (Package tab), add
// https://<published-id>.chromiumapp.org/gdrive to the Google OAuth client's
// authorized redirect URIs, or Drive sign-in breaks for published users. See
// STORE_LISTING.md.
//
// Usage: node scripts/package-chrome.mjs
//   (or `npm run package:chrome`, which builds first)

import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, cpSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const distDir = resolve(repoRoot, "dist");
const artifactsDir = resolve(repoRoot, "web-ext-artifacts");

if (!existsSync(resolve(distDir, "manifest.json"))) {
  console.error("dist/manifest.json not found — run `npm run build` first.");
  process.exit(1);
}

const { version } = JSON.parse(
  readFileSync(resolve(repoRoot, "package.json"), "utf8")
);
const outPath = resolve(artifactsDir, `konode-chrome-${version}.zip`);

mkdirSync(artifactsDir, { recursive: true });
rmSync(outPath, { force: true }); // zip appends otherwise

// Stage a copy so we can strip `key` without mutating dist/ (the dev-load dir).
const staging = mkdtempSync(join(tmpdir(), "konode-chrome-"));
try {
  cpSync(distDir, staging, { recursive: true });

  const manifestPath = join(staging, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if ("key" in manifest) {
    delete manifest.key;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    console.log("Stripped `key` from the store manifest (kept in dist/ for dev).");
  }

  // Zip the CONTENTS of the staging dir (cwd: staging) so manifest.json lands at
  // the archive root. -r recurse, -X strip extra file attributes, exclude junk.
  execFileSync(
    "zip",
    ["-r", "-X", outPath, ".", "-x", "*.DS_Store", "-x", "__MACOSX/*"],
    { cwd: staging, stdio: "inherit" }
  );
} finally {
  rmSync(staging, { recursive: true, force: true });
}

console.log(`\nChrome package written → ${outPath}`);

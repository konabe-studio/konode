// Zip the built dist/ into a Chrome Web Store upload package.
//
// Run after `npm run build`. Produces web-ext-artifacts/konode-chrome-<version>.zip
// with manifest.json at the archive root (what the Web Store expects).
//
// The manifest `key` is STRIPPED from the STORE package. It's kept in
// public/manifest.json (and thus dist/) on purpose — it pins the extension ID for
// local unpacked dev and the dev OAuth redirect — but the Chrome Web Store rejects
// a first upload whose manifest contains `key` ("key field not allowed in
// manifest"). So we zip from a temp staging copy with `key` removed; dist/ itself
// is left untouched for `chrome://extensions` dev loading.
//
// The SOURCE package (the GitHub release zip) KEEPS it. Nobody uploads that one to a store,
// and it is loaded unpacked, where an extension without `key` gets an id derived from the
// folder it sits in: a different id on every machine, which no OAuth redirect can be
// registered for. With the key it has the dev id, ccndglojjbnpepoalfggnmdelbnacfli, whose
// Dropbox redirect is registered (Drive's too, though a source build has no Google client
// secret). The cost: an unpacked install from an older release zip has its folder-derived id,
// so loading a zip that carries the key makes a NEW extension, which is set up again.
//
// After the store assigns the published extension ID (Package tab), add
// https://<published-id>.chromiumapp.org/gdrive to the Google OAuth client's
// authorized redirect URIs, or Drive sign-in breaks for published users. See
// STORE_LISTING.md.
//
// Usage: node scripts/package-chrome.mjs [--variant=store|source]
//   `npm run package:chrome` builds and packages the STORE variant;
//   `npm run package:source` does both browsers as SOURCE builds.
//
// The variant decides which folder the zip lands in, and it is checked against the built
// bundle before anything is written. See build-variant.mjs for why that check exists.

import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, cpSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { pruneUnshippedLocales } from "./prune-locales.mjs";
import { variantFromArgv, assertVariant, artifactDir } from "./build-variant.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const distDir = resolve(repoRoot, "dist");

if (!existsSync(resolve(distDir, "manifest.json"))) {
  console.error("dist/manifest.json not found — run `npm run build` first.");
  process.exit(1);
}

const variant = variantFromArgv();
assertVariant(distDir, variant);

const artifactsDir = resolve(repoRoot, "web-ext-artifacts", artifactDir("chrome", variant));

const { version } = JSON.parse(
  readFileSync(resolve(repoRoot, "package.json"), "utf8")
);
const outPath = resolve(artifactsDir, `konode-chrome-${version}.zip`);

mkdirSync(artifactsDir, { recursive: true });
rmSync(outPath, { force: true }); // zip appends otherwise

// On Windows, resolve bsdtar by absolute path: a `tar` on PATH there is usually
// GNU tar from Git for Windows, which can't write zip at all.
function bsdtar() {
  return process.platform === "win32"
    ? join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
    : "tar";
}

// Stage a copy so we can strip `key` without mutating dist/ (the dev-load dir).
const staging = mkdtempSync(join(tmpdir(), "konode-chrome-"));
try {
  cpSync(distDir, staging, { recursive: true });

  const manifestPath = join(staging, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (variant === "store" && "key" in manifest) {
    delete manifest.key;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    console.log("Stripped `key` from the store manifest (kept in dist/ for dev).");
  } else if ("key" in manifest) {
    console.log("Kept `key` in the source manifest: loaded unpacked, it gets the dev id.");
  }

  pruneUnshippedLocales(join(staging, "_locales"), manifest.default_locale);

  // Zip the CONTENTS of the staging dir (cwd: staging) so manifest.json lands at
  // the archive root. -r recurse, -X strip extra file attributes, exclude junk.
  try {
    execFileSync(
      "zip",
      ["-r", "-X", outPath, ".", "-x", "*.DS_Store", "-x", "__MACOSX/*"],
      { cwd: staging, stdio: "inherit" }
    );
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    // No Info-ZIP `zip` (the normal case on Windows). bsdtar/libarchive ships with
    // Windows 10+ and writes zip via `-a`; pass the top-level entries rather than
    // "." so nothing gets a "./" prefix in the archive.
    console.log("`zip` not found, falling back to bsdtar.");
    execFileSync(
      bsdtar(),
      ["-a", "-c", "-f", outPath, "--exclude", ".DS_Store", "--exclude", "__MACOSX", ...readdirSync(staging)],
      { cwd: staging, stdio: "inherit" }
    );
  }
} finally {
  rmSync(staging, { recursive: true, force: true });
}

console.log(
  `\n${variant === "store" ? "STORE" : "SOURCE"} package (Chrome) written → ${outPath}`
);
console.log(
  variant === "store"
    ? "  ↑ this is the one that goes to the Chrome Web Store."
    : "  ↑ this is the one that goes on the GitHub release. Not to a store."
);

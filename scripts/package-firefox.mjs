// Zip the built dist-firefox/ into an add-on package, through web-ext.
//
// This wraps `web-ext build` rather than calling it straight from package.json, for the
// same reason package-chrome.mjs exists: the variant has to be checked against the built
// bundle before a zip appears, and the zip has to land in the folder that matches where it
// is going. web-ext will happily package anything handed to it and says nothing about what
// is inside, which is exactly the gap that let a source build sit under a name that had
// been pointed at as store-ready.
//
// web-ext does the zipping itself because AMO cares how the archive is made: it rebuilds
// the add-on from the submitted source and diffs it, and web-ext produces the layout its
// reviewers expect. There is no reason to hand-roll that here.
//
// Usage: node scripts/package-firefox.mjs [--variant=store|source]
//   `npm run package:firefox` builds and packages the STORE variant;
//   `npm run package:source` does both browsers as SOURCE builds.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { variantFromArgv, assertVariant, artifactDir } from "./build-variant.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const distDir = resolve(repoRoot, "dist-firefox");

if (!existsSync(resolve(distDir, "manifest.json"))) {
  console.error("dist-firefox/manifest.json not found — run `npm run build:firefox` first.");
  process.exit(1);
}

const variant = variantFromArgv();
assertVariant(distDir, variant);

const artifactsDir = resolve(repoRoot, "web-ext-artifacts", artifactDir("firefox", variant));
mkdirSync(artifactsDir, { recursive: true });

const { version } = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));

// Run web-ext's entry point under the Node that is already running, rather than through
// `npx`. On Windows npx is a .cmd, and since the CVE-2024-27980 fix Node refuses to
// spawn a .cmd without `shell: true` (EINVAL) — and turning the shell on would put every
// one of these paths through Windows quoting rules for no gain.
//
// --filename: web-ext's default is konode-<version>.zip, which sat beside the Chrome zip
// with nothing to tell a downloader which was which.
const webExt = resolve(repoRoot, "node_modules", "web-ext", "bin", "web-ext.js");
execFileSync(
  process.execPath,
  [
    webExt,
    "build",
    "--source-dir",
    distDir,
    "--artifacts-dir",
    artifactsDir,
    "--overwrite-dest",
    "--filename",
    `konode-firefox-${version}.zip`,
  ],
  { cwd: repoRoot, stdio: "inherit" }
);

console.log(
  `\n${variant === "store" ? "STORE" : "SOURCE"} package (Firefox) written → ${resolve(artifactsDir, `konode-firefox-${version}.zip`)}`
);
console.log(
  variant === "store"
    ? "  ↑ this is the one that goes to addons.mozilla.org."
    : "  ↑ this is the one that goes on the GitHub release. Not to a store."
);

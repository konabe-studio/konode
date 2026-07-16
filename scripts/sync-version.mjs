// Single source of truth for the version = package.json. Stamps it into
// public/manifest.json so you only bump ONE place. Runs at the start of every build.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const manifestPath = resolve(root, "public/manifest.json");
const raw = readFileSync(manifestPath, "utf8");
// Replace only the top-level "version" value; leaves all other formatting intact.
const updated = raw.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);

if (updated !== raw) {
  writeFileSync(manifestPath, updated);
  console.log(`manifest version -> ${version}`);
} else {
  console.log(`manifest version already ${version}`);
}

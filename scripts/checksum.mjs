// Build fingerprint: a deterministic SHA-256 over the contents of dist/.
// Publish the printed COMBINED hash in each GitHub Release. Anyone can then check out
// the tag, run `npm ci && npm run build && npm run checksum`, and compare — a match
// means the packaged extension was built from exactly this source. (Best-effort: it
// assumes a comparable Node/OS toolchain; the pinned lockfile keeps deps identical.)
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, relative, join } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");

if (!existsSync(dist)) {
  console.error("dist/ not found — run `npm run build` first.");
  process.exit(1);
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

// Sort by OS-independent relative path so the fingerprint is stable across machines.
const files = walk(dist)
  .map((p) => relative(dist, p).split("\\").join("/"))
  .sort();

const combined = createHash("sha256");
for (const rel of files) {
  const hash = createHash("sha256").update(readFileSync(join(dist, rel))).digest("hex");
  console.log(`${hash}  ${rel}`);
  combined.update(`${rel}\n${hash}\n`);
}
console.log(`\nCOMBINED  ${combined.digest("hex")}`);

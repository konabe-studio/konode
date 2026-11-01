// The Firefox half: a real Firefox, the extension loaded as a temporary add-on by web-ext,
// and the driver page that reports back.
//
// Why it is shaped so differently from the Chromium half: Playwright has no way to load an
// extension into Firefox, and a WebDriver session cannot reach `browser.*` from a content
// page, so there is nothing to drive from outside. web-ext installs the build over
// Firefox's remote debugging protocol — which needs no signing, the one reason an unsigned
// build can run in a release Firefox at all — and from there the extension drives itself
// (lib/driver/) and posts what it found to the reporter.
import { cp, writeFile, readFile, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve, join } from "node:path";
import { buildWith } from "./peer.mjs";

const here = import.meta.dirname;

/** A tarball unpacked under ~/.local/opt, newest name first — how this was installed here. */
async function unpacked() {
  const base = join(process.env.HOME ?? "", ".local/opt");
  try {
    const dirs = (await readdir(base)).filter((d) => d.startsWith("firefox")).sort().reverse();
    return dirs.map((d) => join(base, d, "firefox/firefox"));
  } catch {
    return [];
  }
}

/** Where else a Firefox tends to be. Any version from 139 has `tabGroups`; 138 has not. */
const CANDIDATES = ["/usr/lib/firefox/firefox", "/usr/bin/firefox", "/snap/bin/firefox"];

const exists = async (path) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

/**
 * The Firefox to run, or null when there is none and the Gecko passes should skip.
 *
 * E2E_FIREFOX is the whole answer when it is set: a path that is not there means skip,
 * which is also how a run asks for the Chromium half alone, rather than quietly falling
 * back to some other Firefox on the machine.
 */
export async function firefoxBinary() {
  if (process.env.E2E_FIREFOX !== undefined) {
    const named = process.env.E2E_FIREFOX;
    return named && (await exists(named)) ? named : null;
  }
  for (const path of [...(await unpacked()), ...CANDIDATES]) {
    if (await exists(path)) return path;
  }
  return null;
}

/**
 * A copy of the Firefox build with the permissions this pass needs, the driver inside it,
 * and its instructions beside it.
 */
export async function buildFirefoxDriver({ dist, into, grant, config }) {
  await buildWith(dist, into, grant);
  for (const file of ["e2e.html", "e2e.js", "e2e-boot.js"]) {
    await cp(join(here, "driver", file), join(into, file));
  }
  const manifestPath = join(into, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!manifest.background?.scripts) {
    throw new Error("the Firefox build should carry background.scripts — is this dist/ rather than dist-firefox/?");
  }
  manifest.background.scripts = [...manifest.background.scripts, "e2e-boot.js"];
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(into, "e2e-config.json"), `${JSON.stringify(config, null, 2)}\n`);
  return into;
}

/**
 * Runs that build until it reports, then shuts Firefox down.
 *
 * MOZ_HEADLESS is how a web-ext run goes headless; there is no flag for it. The process
 * gets its own group so that killing it takes Firefox with it rather than leaving a
 * browser behind on a failure.
 */
export async function runFirefoxDriver({ extDir, binary, reporter, timeoutMs = 180_000, verbose = false }) {
  const webExt = resolve(here, "../../../node_modules/.bin/web-ext");
  const args = ["run", "--source-dir", extDir, "--firefox", binary, "--no-reload", "--no-input"];
  const child = spawn(webExt, args, {
    env: { ...process.env, MOZ_HEADLESS: process.env.E2E_HEADFUL ? "" : "1" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  const chatter = [];
  const watch = (stream) => stream.on("data", (chunk) => {
    const text = chunk.toString();
    chatter.push(text);
    if (verbose) process.stdout.write(text);
  });
  watch(child.stdout);
  watch(child.stderr);

  let exited = null;
  child.on("exit", (code) => { exited = code; });

  try {
    return await reporter.next(timeoutMs);
  } catch (err) {
    const tail = chatter.join("").split("\n").slice(-25).join("\n");
    throw new Error(`${err.message}${exited === null ? "" : ` (web-ext exited ${exited})`}\n--- web-ext output ---\n${tail}`);
  } finally {
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
  }
}

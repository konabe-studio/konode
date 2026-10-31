// Shoots the promo video's frames.
//
//   node scripts/promo/capture.mjs --lang=en
//   node scripts/promo/capture.mjs --lang=hu --only=1,3,8
//   node scripts/promo/capture.mjs --probe          what the extension's own UI looks like
//
// Output lands in promo-out/<lang>/shot-<n>/frame-00000.png, ready for assemble.mjs.
//
// Two kinds of shot. The kinetic ones are drawn by scripts/promo/kinetic and are seeked
// frame by frame, so they are bit-for-bit repeatable: that is what makes a re-shoot in
// another language the same film with different words. The product ones drive a real
// Chrome with the real extension loaded, which no amount of care makes frame-exact, so
// each beat is given a fixed frame budget instead and the timeline stays put.
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { serve } from "./lib/serve.mjs";
import { shootStills } from "./lib/devices.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// Shot 4 is drawn like the kinetic ones, out of stills shot from two real profiles:
// the browser cannot be seeked, a still can, and the sync behind it is real either way.
const KINETIC_SHOTS = [1, 2, 3, 4, 5, 6, 7, 8];
const STILLS_SHOTS = [4, 5, 6];

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = "true"] = a.replace(/^--/, "").split("=");
    return [k, v];
  }),
);

const lang = args.lang ?? "en";
const fps = Number(args.fps ?? 30);
const scale = Number(args.scale ?? 2);
const outRoot = resolve(ROOT, args.out ?? "promo-out", lang);
const only = args.only ? args.only.split(",").map(Number) : null;
const wanted = (shot) => !only || only.includes(shot);

const text = JSON.parse(await readFile(resolve(ROOT, "scripts/promo/text", `${lang}.json`), "utf8"));

// Inter carries no CJK glyphs, so a Chinese cut on a machine with no CJK font installed
// renders a screen of empty boxes and nobody notices until the video is out.
function warnAboutGlyphs() {
  if (!/^zh|^ja|^ko/.test(lang)) return;
  try {
    const have = execFileSync("fc-list", [`:lang=${lang.slice(0, 2)}`], { encoding: "utf8" }).trim();
    if (!have) console.warn(`\n  !  no font on this machine covers ${lang}. Install one (e.g. Noto Sans CJK) before trusting these frames.\n`);
  } catch {
    console.warn(`  !  could not check ${lang} font coverage (fc-list missing); eyeball the first frame.`);
  }
}

async function shotDir(shot) {
  const dir = resolve(outRoot, `shot-${shot}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  return dir;
}

const frameName = (i) => `frame-${String(i).padStart(5, "0")}.png`;

async function captureKinetic(browser, origin) {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: scale,
  });
  await page.goto(`${origin}/kinetic/`);

  for (const shot of KINETIC_SHOTS.filter(wanted)) {
    const duration = await page.evaluate(([l, s]) => window.__load(l, s), [lang, shot]);
    const dir = await shotDir(shot);
    const frames = Math.round((duration / 1000) * fps);
    for (let i = 0; i < frames; i++) {
      await page.evaluate((t) => window.__seek(t), (i / fps) * 1000);
      await page.screenshot({ path: resolve(dir, frameName(i)), animations: "disabled" });
    }
    console.log(`  shot ${shot}: ${frames} frames (${duration / 1000}s)`);
  }
  await page.close();
}

// The shipped build, with one line of its manifest changed.
//
// Konode asks for loopback access only when the user points it at a WebDAV server, and
// that request is a Chrome dialog, which is browser UI that nothing in a page can click.
// So the capture runs a copy of dist/ with http://127.0.0.1/* moved from
// optional_host_permissions into host_permissions, where loading unpacked grants it
// without asking. Same code, same pixels, one permission pre-granted instead of clicked.
// The copy lives in the ignored output directory and dist/ is never touched.
async function promoDist() {
  const dist = resolve(ROOT, "dist");
  if (!existsSync(resolve(dist, "manifest.json"))) {
    throw new Error("dist/ is not built. Run npm run build first.");
  }
  const out = resolve(ROOT, "promo-out", ".dist");
  await rm(out, { recursive: true, force: true });
  await cp(dist, out, { recursive: true });

  const file = resolve(out, "manifest.json");
  const manifest = JSON.parse(await readFile(file, "utf8"));
  const loopback = ["http://127.0.0.1/*", "http://localhost/*"];
  manifest.host_permissions = [...new Set([...(manifest.host_permissions ?? []), ...loopback])];
  manifest.optional_host_permissions = (manifest.optional_host_permissions ?? [])
    .filter((h) => !loopback.includes(h));

  // Same reason for the data types. History, tabs and the extension list are asked for
  // only when the user switches those streams on, and each ask is a dialog. The video
  // shows all four streams running, so the promo build has them from the start.
  manifest.permissions = [...new Set([...(manifest.permissions ?? []), ...(manifest.optional_permissions ?? [])])];
  delete manifest.optional_permissions;
  await writeFile(file, JSON.stringify(manifest, null, 2));
  return out;
}

// The extension as the browser really runs it.
//
// Chrome for Testing rather than the Chrome on this machine, and not for convenience:
// stable Chrome has stopped honouring --load-extension altogether, so the extension
// simply never loads and every page under chrome-extension:// answers
// ERR_BLOCKED_BY_CLIENT. Chrome for Testing is the same build without that refusal, and
// pinning it also means the shoot does not change when the machine's Chrome updates.
// Install it once with: npx playwright install chromium
//
// MV3 needs a headed persistent context, and the id is only knowable once its service
// worker is up.
async function openExtension(profile) {
  const dist = await promoDist();
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: false,
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: scale,
    locale: text.chromeLocale ?? lang,
    args: [
      `--disable-extensions-except=${dist}`,
      `--load-extension=${dist}`,
      `--lang=${text.chromeLocale ?? lang}`,
      "--hide-crash-restore-bubble",
    ],
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 15000 });
  const id = new URL(worker.url()).host;
  return { context, id };
}

// A drawn pointer, because Playwright's own recordings have no cursor in them at all.
const CURSOR = `
  (() => {
    const dot = document.createElement("div");
    dot.id = "__promo_cursor";
    dot.style.cssText = "position:fixed;z-index:2147483647;width:22px;height:22px;margin:-4px 0 0 -4px;pointer-events:none;opacity:0;background:no-repeat center/contain url('data:image/svg+xml;utf8,<svg xmlns=\\"http://www.w3.org/2000/svg\\" viewBox=\\"0 0 24 24\\"><path d=\\"M5 2l14 10-6 1 3.5 7-2.6 1.2L10.4 14 5 18z\\" fill=\\"white\\" stroke=\\"black\\" stroke-width=\\"1.2\\"/></svg>');";
    document.documentElement.append(dot);
    window.__cursor = (x, y, visible = true) => {
      dot.style.left = x + "px";
      dot.style.top = y + "px";
      dot.style.opacity = visible ? "1" : "0";
    };
  })();
`;

async function probe() {
  const profile = resolve(ROOT, "promo-out", ".probe-profile");
  await rm(profile, { recursive: true, force: true });
  const { context, id } = await openExtension(profile);
  const report = { extensionId: id, pages: {} };
  for (const name of ["popup.html", "onboarding.html", "options.html"]) {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/${name}`);
    await page.waitForTimeout(1500);
    report.pages[name] = await page.evaluate(() =>
      [...document.querySelectorAll("button, a, input, select, [role=button], h1, h2")]
        .map((n) => ({
          tag: n.tagName.toLowerCase(),
          text: (n.innerText ?? n.value ?? "").trim().slice(0, 60),
          id: n.id || undefined,
          cls: n.className?.toString().slice(0, 60) || undefined,
        }))
        .filter((n) => n.text),
    );
    await page.screenshot({ path: resolve(ROOT, "promo-out", `probe-${name}.png`) });
    await page.close();
  }
  await context.close();
  const file = resolve(ROOT, "promo-out", "probe.json");
  await writeFile(file, JSON.stringify(report, null, 2));
  console.log(`extension id ${id}\nwrote ${file} and promo-out/probe-*.png`);
}

async function main() {
  if (args.probe) return probe();

  warnAboutGlyphs();
  await mkdir(outRoot, { recursive: true });

  if (STILLS_SHOTS.some(wanted)) {
    console.log("two profiles, one real sync:");
    const result = await shootStills({
      dist: await promoDist(),
      outDir: outRoot,
      workDir: resolve(ROOT, "promo-out", ".profiles"),
      text: text.shots["4"],
      locale: text.chromeLocale ?? lang,
      scale,
    });
    const hero = text.shots["4"].bookmark;
    if (!result.onB.includes(hero)) {
      throw new Error(`the bookmark never reached the second device, so there is no shot 4 to cut: ${JSON.stringify(result.onB)}`);
    }
    console.log(`  "${hero}" reached ${text.shots["4"].deviceB} through ${result.files.length} file(s) on the server`);
  }

  const { origin, close } = await serve(ROOT, { "/stills": resolve(outRoot, "stills") });
  const browser = await chromium.launch({ channel: "chromium", headless: true });
  console.log(`kinetic shots, ${lang}, ${fps}fps @${scale}x:`);
  try {
    await captureKinetic(browser, origin);
  } finally {
    await browser.close();
    await close();
  }

}

await main();

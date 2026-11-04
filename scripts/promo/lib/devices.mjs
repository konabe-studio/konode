// Two throwaway profiles, one real sync between them, and the stills the video is built
// from.
//
// Nothing here is staged. The bookmark is created on the first profile, travels through
// the local WebDAV server, and the second profile's "after" still is whatever Chrome's
// own bookmark manager shows once it has arrived. If the sync broke, the still would
// show it, which is the point of shooting it this way rather than drawing it.
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { startWebdav } from "./webdav-server.mjs";

// Locale-neutral on purpose: these sit in the background of the shot in every language.
const BASE_BOOKMARKS = [
  ["Hacker News", "https://news.ycombinator.com/"],
  ["MDN Web Docs", "https://developer.mozilla.org/"],
  ["Wikipedia", "https://wikipedia.org/"],
];

const VIEW = { width: 1000, height: 640 };
const CLIP = { x: 0, y: 0, width: 1000, height: 430 };

function settings(davOrigin, device_id, device_label) {
  return {
    device_id,
    device_label,
    enabled_types: ["bookmarks", "sessions", "history", "extensions"],
    backends: [{
      type: "webdav",
      label: "WebDAV",
      enabled: true,
      webdav: { url: davOrigin, username: "promo", password: "promo", path: "konode" },
    }],
    active_backend: "webdav",
    sync_interval_seconds: 60,
    conflict_strategy: "lww",
    history_days_limit: 30,
    bulk_delete_percent: 60,
    excluded_bookmarks: [],
    auto_sync: false,
    sync_on_change: false,
    notifications_enabled: false,
    debug_mode: false,
    encryption_enabled: false,
    onboarding_completed: true,
  };
}

async function openDevice({ dist, profileDir, davOrigin, id, label, locale, scale, configure = true }) {
  await rm(profileDir, { recursive: true, force: true });
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chromium",
    headless: false,
    viewport: VIEW,
    deviceScaleFactor: scale,
    colorScheme: "dark",
    locale,
    args: [
      `--disable-extensions-except=${dist}`,
      `--load-extension=${dist}`,
      `--lang=${locale}`,
      "--force-dark-mode",
      "--hide-crash-restore-bubble",
    ],
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extensionId = new URL(worker.url()).host;

  // Configure the device the way the extension configures itself, with the message its
  // own Settings screen sends. Writing straight into storage looks like it works and
  // does not: the sync engine reads its backend when the worker boots, so "Sync now"
  // keeps answering "No storage backend is set up yet" over a storage entry that is
  // plainly correct. SAVE_SETTINGS saves and hands the engine the new settings.
  const config = settings(davOrigin, id, label);
  const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));

  // The first run mints the device's own settings a moment after the worker starts, and
  // that write would land on top of ours.
  for (let attempt = 0; ; attempt++) {
    const minted = await worker.evaluate(async () => {
      const { konode_settings: got } = await chrome.storage.local.get("konode_settings");
      return Boolean(got?.device_id);
    });
    if (minted) break;
    if (attempt > 40) throw new Error(`${label}: the extension never wrote its first-run settings`);
    await pause(300);
  }

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  if (configure) {
    const saved = await popup.evaluate((s) => chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", payload: s }), config);
    if (saved?.type !== "OK") throw new Error(`${label}: SAVE_SETTINGS answered ${JSON.stringify(saved)}`);
  }

  // The button's own label, in whatever language this profile runs in, straight from the
  // extension's translations rather than a guess per locale.
  const syncLabel = await worker.evaluate(() => chrome.i18n.getMessage("popup_sync_now"));

  const bookmarks = await context.newPage();
  await bookmarks.goto("chrome://bookmarks/");

  return {
    context,
    worker,
    extensionId,
    bookmarks,
    popup,
    async add(title, url) {
      await worker.evaluate(async ([t, u]) => {
        const bar = (await chrome.bookmarks.getTree())[0].children[0];
        await chrome.bookmarks.create({ parentId: bar.id, title: t, url: u });
      }, [title, url]);
    },
    async sync() {
      await popup.reload();
      await popup.waitForTimeout(800);
      await popup.getByRole("button", { name: syncLabel }).first().click();
      await popup.waitForTimeout(6000);
      const status = (await popup.evaluate(() => document.body.innerText))
        .split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 2).join(" ");
      console.log(`    ${label}: ${status}`);
    },
    async still(name, dir) {
      await bookmarks.reload();
      await bookmarks.waitForTimeout(1200);
      await bookmarks.screenshot({ path: resolve(dir, `${name}.png`), clip: CLIP });
    },
    async openTabs(urls) {
      for (const url of urls) {
        const tab = await context.newPage();
        await tab.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
      }
    },
    async stillOf(name, dir, url, size, { fullPage = false, unclip = false } = {}) {
      const page = await context.newPage();
      await page.setViewportSize(size);
      await page.goto(url);
      await page.waitForTimeout(2500);
      let clip;
      if (unclip) {
        // Two things are in the way of one still of the whole backend list. The list
        // scrolls inside its own box, so a full-page shot stops at the fold and two of
        // the three backends the narration names never appear. And the page carries on
        // past the list into the encryption panel, warnings and all, which is Settings
        // doing its job and a poor thing to pan past in a promo.
        //
        // So: let every inner scroller grow to its content, then end the still at the
        // last provider card. The anchor is that card's radio rather than a heading,
        // because headings are translated and this is not.
        await page.evaluate(() => {
          for (const node of document.querySelectorAll("*")) {
            const style = getComputedStyle(node);
            if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 4) {
              node.style.maxHeight = "none";
              node.style.height = "auto";
              node.style.overflow = "visible";
            }
            // A bar that sticks to the fold lands in the middle of a list that no longer
            // has one, and reads as a glitch. Put it back in the flow instead.
            if (style.position === "sticky" || style.position === "fixed") {
              node.style.position = "static";
            }
          }
        });
        await page.waitForTimeout(800);
        const bottom = await page.evaluate(() => {
          const cards = [...document.querySelectorAll('[role="button"]')]
            .filter((node) => node.querySelector(".radio-circle"));
          const last = cards.at(-1);
          if (!last) return null;
          return Math.ceil(last.getBoundingClientRect().bottom + window.scrollY + 24);
        });
        if (bottom) clip = { x: 0, y: 0, width: size.width, height: bottom };
      }
      await page.screenshot({ path: resolve(dir, `${name}.png`), fullPage, ...(clip ? { clip } : {}) });
      await page.close();
    },
    async titles() {
      return worker.evaluate(async () => {
        const flat = [];
        const walk = (n) => { if (n.url) flat.push(n.title); (n.children ?? []).forEach(walk); };
        (await chrome.bookmarks.getTree()).forEach(walk);
        return flat;
      });
    },
  };
}

/**
 * Shoots the four stills shot 4 is cut from, and returns what each device ended up
 * holding so the caller can refuse to build a video out of a sync that did not happen.
 */
export async function shootStills({ dist, outDir, workDir, text, locale, scale = 2 }) {
  const stills = resolve(outDir, "stills");
  await mkdir(stills, { recursive: true });
  const dav = await startWebdav();
  const devices = [];
  try {
    const a = await openDevice({
      dist, profileDir: resolve(workDir, "profile-a"), davOrigin: dav.origin,
      id: "promo-device-a", label: text.deviceA, locale, scale,
    });
    devices.push(a);
    const b = await openDevice({
      dist, profileDir: resolve(workDir, "profile-b"), davOrigin: dav.origin,
      id: "promo-device-b", label: text.deviceB, locale, scale,
    });
    devices.push(b);

    // Both devices start from the same shelf, and B gets there the way a real second
    // device would: by syncing, not by being set up the same.
    for (const [title, url] of BASE_BOOKMARKS) await a.add(title, url);
    await a.sync();
    console.log(`    on the server: ${dav.names().length} file(s)`);
    await b.sync();
    console.log(`    ${text.deviceB} holds: ${JSON.stringify(await b.titles())}`);

    await a.still("a-before", stills);
    await b.still("b-before", stills);

    await a.add(text.bookmark, "https://konode.app/");
    await a.still("a-after", stills);
    await a.sync();
    await b.sync();
    await b.still("b-after", stills);

    // Shots 5 and 6 come off a device that has been running for a while: the second
    // machine leaves a few tabs open, publishes them, and the first one picks them up,
    // so the popup has a real session from a real peer to show.
    await b.openTabs(BASE_BOOKMARKS.map(([, url]) => url));
    await b.sync();
    await a.sync();
    await a.stillOf("popup", stills, `chrome-extension://${a.extensionId}/popup.html`, { width: 400, height: 400 });

    // Shot 5 is the choice itself, so it is shot on a profile that has not made one. A
    // configured device shows its connection form and an encryption warning underneath
    // the list, which is a fine thing for Settings to say and a poor thing to pan past
    // in a promo.
    const fresh = await openDevice({
      dist, profileDir: resolve(workDir, "profile-fresh"), davOrigin: dav.origin,
      id: "promo-device-fresh", label: "fresh", locale, scale, configure: false,
    });
    devices.push(fresh);
    await fresh.stillOf("storage", stills, `chrome-extension://${fresh.extensionId}/options.html`,
      { width: 1040, height: 700 }, { fullPage: true, unclip: true });

    return { onA: await a.titles(), onB: await b.titles(), files: dav.names() };
  } finally {
    for (const d of devices) await d.context.close().catch(() => {});
    await dav.close();
  }
}

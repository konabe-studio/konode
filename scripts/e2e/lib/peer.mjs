// One Konode device under test.
//
// A throwaway Chromium profile with the extension loaded, pointed at the local WebDAV
// server and driven the way the extension drives itself: SAVE_SETTINGS, SYNC_NOW and
// RESTORE_SESSION, the same messages Settings and the popup send. Writing straight into
// chrome.storage looks like it works and does not — the engine reads its backend when the
// worker boots, so a storage write leaves "Sync now" answering "No storage backend is set
// up yet" over an entry that is plainly correct.
//
// Nothing here knows about tab groups. tab-groups.mjs is the pass that uses it.
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

/**
 * A copy of a built extension with some of its optional permissions already held.
 *
 * Konode asks for `tabs` and `tabGroups` from a click, and Chrome answers that click with
 * a dialog drawn in browser chrome, where Playwright has no way to click "Allow". Granting
 * them in a COPY of the build puts the profile in the state that click would leave it in,
 * which is the state this pass is about; `dist/` itself is never touched. What it does not
 * test is the prompt — that is `permissionsToEnable` / `tabGroupsAskable`, and they have
 * unit tests of their own.
 *
 * A permission that is already required stays required, and one the manifest does not list
 * as optional is ignored rather than invented.
 */
export async function buildWith(dist, into, grant) {
  await rm(into, { recursive: true, force: true });
  await mkdir(into, { recursive: true });
  await cp(dist, into, { recursive: true });
  const file = resolve(into, "manifest.json");
  const manifest = JSON.parse(await readFile(file, "utf8"));
  const optional = manifest.optional_permissions ?? [];
  const promoted = grant.filter((p) => optional.includes(p));
  manifest.optional_permissions = optional.filter((p) => !promoted.includes(p));
  manifest.permissions = [...new Set([...(manifest.permissions ?? []), ...promoted])];
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
  return into;
}

/** The settings a device would hold after setup, pointed at the local server. */
function settings(davOrigin, device_id, device_label, enabled_types) {
  return {
    device_id,
    device_label,
    enabled_types,
    backends: [{
      type: "webdav",
      label: "WebDAV",
      enabled: true,
      webdav: { url: davOrigin, username: "e2e", password: "e2e", path: "konode" },
    }],
    active_backend: "webdav",
    sync_interval_seconds: 3600,
    conflict_strategy: "lww",
    history_days_limit: 30,
    bulk_delete_percent: 60,
    excluded_bookmarks: [],
    // Every sync in this pass is one the test asked for, so that the thing being asserted
    // is the one that just ran.
    auto_sync: false,
    sync_on_change: false,
    notifications_enabled: false,
    debug_mode: false,
    encryption_enabled: false,
    onboarding_completed: true,
  };
}

const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));

export async function launchPeer({
  extDir, profileDir, davOrigin, id, label,
  enabledTypes = ["sessions"], headless = true,
}) {
  await rm(profileDir, { recursive: true, force: true });
  await mkdir(profileDir, { recursive: true });
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chromium",
    headless,
    viewport: { width: 1100, height: 760 },
    args: [
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
      "--no-first-run",
      "--hide-crash-restore-bubble",
    ],
  });

  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 30_000 });
  const extensionId = new URL(worker.url()).host;

  // The first run mints the device's own settings a moment after the worker starts, and
  // that write would land on top of ours.
  for (let attempt = 0; ; attempt++) {
    const minted = await worker.evaluate(async () => {
      const { konode_settings: got } = await chrome.storage.local.get("konode_settings");
      return Boolean(got?.device_id);
    });
    if (minted) break;
    if (attempt > 60) throw new Error(`${label}: the extension never wrote its first-run settings`);
    await pause(250);
  }

  // Any page on the extension's own origin can send it a message; the popup is the
  // lightest one that exists. It is a chrome-extension:// URL, so it is never a tab the
  // session publishes.
  const control = await context.newPage();
  await control.goto(`chrome-extension://${extensionId}/popup.html`);

  const send = (type, payload) =>
    control.evaluate(
      ([t, p]) => chrome.runtime.sendMessage(p === null ? { type: t } : { type: t, payload: p }),
      [type, payload ?? null]
    );
  const ok = async (type, payload) => {
    const answer = await send(type, payload);
    if (answer?.type !== "OK") {
      throw new Error(`${label}: ${type} answered ${JSON.stringify(answer)}`);
    }
    return answer;
  };

  await ok("SAVE_SETTINGS", settings(davOrigin, id, label, enabledTypes));

  /** Tab ids for a list of URLs, in the order given. Throws rather than group half of them. */
  const idsFor = async (urls) =>
    worker.evaluate(async (list) => {
      const open = await chrome.tabs.query({});
      const ids = list.map((u) => open.find((t) => t.url === u)?.id);
      if (ids.some((x) => typeof x !== "number")) {
        throw new Error(`not open here: ${list.filter((_, i) => typeof ids[i] !== "number").join(", ")}`);
      }
      return ids;
    }, urls);

  return {
    id,
    label,
    context,
    worker,
    extensionId,

    /** Open real tabs, the way a person would, and wait for each to have its title. */
    async openPages(urls) {
      for (const url of urls) {
        const tab = await context.newPage();
        await tab.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
      }
    },

    async pin(url) {
      const [tabId] = await idsFor([url]);
      await worker.evaluate((tid) => chrome.tabs.update(tid, { pinned: true }), tabId);
    },

    /**
     * Put these tabs in one group, and name it where this build may. `named` is ignored on
     * a build without `tabGroups`, which is the whole point of passing it there.
     */
    async group(urls, named) {
      const ids = await idsFor(urls);
      return worker.evaluate(async ([tabIds, g]) => {
        const groupId = await chrome.tabs.group({ tabIds });
        if (g && chrome.tabGroups) await chrome.tabGroups.update(groupId, g);
        return groupId;
      }, [ids, named ?? null]);
    },

    /** What `tabGroupSupport()` would answer here, asked the same way it asks. */
    async support() {
      return worker.evaluate(async () => {
        if (typeof chrome.tabs?.group !== "function") return "none";
        let granted = false;
        try { granted = await chrome.permissions.contains({ permissions: ["tabGroups"] }); } catch { granted = false; }
        return chrome.tabGroups && granted ? "full" : "membership";
      });
    },

    /** Every open tab, with the group it sits in. `groupId` needs no permission. */
    async tabs() {
      return worker.evaluate(async () =>
        (await chrome.tabs.query({})).map((t) => ({
          url: t.url, title: t.title, pinned: t.pinned, groupId: t.groupId, windowId: t.windowId,
        }))
      );
    },

    /** The groups as this browser has them, or null where the build may not read them. */
    async groups() {
      return worker.evaluate(async () => {
        let granted = false;
        try { granted = await chrome.permissions.contains({ permissions: ["tabGroups"] }); } catch { granted = false; }
        if (!chrome.tabGroups || !granted) return null;
        return (await chrome.tabGroups.query({})).map((g) => ({ id: g.id, title: g.title, color: g.color }));
      });
    },

    async remoteSessions() {
      const raw = await worker.evaluate(async () =>
        (await chrome.storage.local.get("konode_remote_sessions")).konode_remote_sessions ?? []
      );
      return Array.isArray(raw) ? raw : Object.values(raw ?? {});
    },

    sync: () => ok("SYNC_NOW"),
    restore: (sessionId) => ok("RESTORE_SESSION", { id: sessionId }),
    close: () => context.close().catch(() => {}),
  };
}

// ─── Konode Service Worker (MV3) ─────────────────────────────────────────
// Handles: alarm-based polling, bookmark/tab listeners, message routing

import type { ExtensionMessage, ExtensionResponse, SyncState } from "@/lib/types";
import { getSettings, getState, setState, saveSettings, clearStaleSyncLock, KEYS } from "@/lib/utils/storage";
import { SyncEngine } from "@/lib/sync/sync-engine";
import { registerBookmarkListeners } from "@/lib/handlers/bookmarks-handler";
import { createBackend } from "@/lib/backends/abstract-backend";
import { logger, setLoggerDebug } from "@/lib/utils/logger";
import { BADGE_COLORS, BADGE_TEXT, STATE_UPDATE } from "@/lib/constants";
import { browser } from "@/lib/utils/ext";
import { ensureSyncAlarm, SYNC_ALARM, BOOKMARK_ALARM } from "@/lib/utils/alarms";

// ─── State ────────────────────────────────────────────────────────────────

let syncEngine: SyncEngine | null = null;
let bookmarkDebounce: ReturnType<typeof setTimeout> | null = null;
const BOOKMARK_DEBOUNCE_MS = 1000; // coalesce bursts (a folder delete fires many events)

// ─── Init ─────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  const settings = await getSettings();
  setLoggerDebug(settings.debug_mode);

  // ── Reset stuck "syncing" state from previous session ──
  const currentState = await getState();
  if (currentState.status === "syncing") {
    const repaired = await setState({ status: "idle", last_error: null });
    logger.event("ServiceWorker", "Reset stuck syncing state");
    // Tell any ALREADY-OPEN popup. It reads the state once on mount, so without this it
    // sat on "Syncing…" with the Sync-now button disabled for its whole lifetime — the
    // repair happened in storage where nobody was looking.
    broadcastState(repaired);
  }

  // ── Drop a sync lock left behind by a worker that died mid-sync ──
  // The other half of that same stranded state, and it was missing: a worker torn down
  // mid-sync skips sync()'s finally, so konode_sync_lock kept a timestamp and every
  // sync for the next 2 minutes — the manual "Sync now" included — returned early while
  // still answering OK. Safe unconditionally: MV3 runs one worker at a time, so on a
  // fresh worker nothing can still be holding it.
  if (await clearStaleSyncLock()) {
    logger.event("ServiceWorker", "Cleared a sync lock left by an interrupted sync");
  }

  // ── Migration: drop the legacy "tabs" data type (folded into "sessions") ──
  // "tabs" is no longer part of DataType, so compare as plain strings.
  if ((settings.enabled_types as string[]).includes("tabs")) {
    const cleaned = settings.enabled_types.filter((t) => (t as string) !== "tabs");
    await saveSettings({ enabled_types: cleaned });
    settings.enabled_types = cleaned;
    logger.event("ServiceWorker", "Migrated: removed legacy 'tabs' data type");
  }

  syncEngine = new SyncEngine(settings, broadcastState);

  // Bookmark listeners are registered once at the top level (see bottom of file),
  // not here — init() re-runs on every SW wake and would stack duplicate listeners.

  // NOT forced: init() runs on every worker wake, and re-creating the alarm each time
  // reset its next fire and starved the periodic pull. See ensureSyncAlarm.
  if (settings.auto_sync) {
    await ensureSyncAlarm(settings.sync_interval_seconds);
  }

  logger.info("ServiceWorker", "Initialized");
}

// MV3 tears the worker down when idle and recreates it on the next event. Every
// entry point (alarm, message, bookmark change) awaits this so it never races a
// not-yet-created syncEngine — the bug that made sync only work with the worker
// inspector held open. Cached so init() runs once per worker lifetime.
let initPromise: Promise<void> | null = null;
function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = init().catch((err) => {
      logger.error("ServiceWorker.init", err);
      initPromise = null; // let the next event retry
    });
  }
  return initPromise;
}

// ─── Badge ────────────────────────────────────────────────────────────────

/** The toolbar badge is decoration, and not every browser has one to draw on — mobile
 *  builds in particular. A throw here used to travel up through `broadcastState`, which
 *  is called from the sync path, so a missing badge could take a working sync down with
 *  it. Nothing about the sync depends on this succeeding. */
function updateBadge(status: string): void {
  const key = status as keyof typeof BADGE_COLORS;
  try {
    browser.action.setBadgeBackgroundColor({ color: BADGE_COLORS[key] ?? BADGE_COLORS.idle });
    browser.action.setBadgeText({ text: BADGE_TEXT[key] ?? "" });
  } catch (e) {
    logger.debug("updateBadge", `This browser wouldn't take a toolbar badge: ${e instanceof Error ? e.message : e}`);
  }
}

/** Update the toolbar and push the state to any open popup/options view.
 *  chrome.extension.getViews doesn't exist in an MV3 service worker, so just broadcast —
 *  sendMessage rejects when no view is listening, which is expected; swallow it. */
function broadcastState(state: SyncState): void {
  updateBadge(state.status);
  browser.runtime.sendMessage({ type: STATE_UPDATE, payload: state }).catch(() => {});
}

// ─── Bookmark Listener ────────────────────────────────────────────────────

function onBookmarkChange(): void {
  // Backstop: a one-shot alarm survives SW suspension (Chrome floors it at ~30s),
  // so a change is never lost even if the fast path below doesn't get to run.
  browser.alarms.create(BOOKMARK_ALARM, { delayInMinutes: 0.5 });

  // Fast path: the worker is awake right now (the event just fired), so sync
  // almost immediately. A short debounce coalesces bursts (e.g. deleting a
  // folder fires many onRemoved events) into a single sync — applies equally to
  // adds and removes, so deletions propagate as promptly as additions.
  if (bookmarkDebounce) clearTimeout(bookmarkDebounce);
  bookmarkDebounce = setTimeout(async () => {
    bookmarkDebounce = null;
    await ensureInit();
    const settings = await getSettings();
    if (
      settings.sync_on_change &&
      settings.enabled_types.includes("bookmarks") &&
      syncEngine &&
      !syncEngine.isSyncing
    ) {
      // We're handling it now — drop the backstop so it doesn't double-sync.
      await browser.alarms.clear(BOOKMARK_ALARM);
      await syncEngine.sync(["bookmarks"]);
    }
    // If a sync is already running, leave the alarm to pick this change up next.
  }, BOOKMARK_DEBOUNCE_MS);
}

// ─── Message Handler ──────────────────────────────────────────────────────

// Return a Promise for the async response. The polyfill (and Firefox natively)
// resolve the sender's sendMessage promise with the value this resolves to —
// unlike raw Chrome's sendResponse + `return true`, which the polyfill ignores.
browser.runtime.onMessage.addListener(((message: ExtensionMessage): Promise<ExtensionResponse> =>
  handleMessage(message).catch((err): ExtensionResponse => ({
    type: "ERROR",
    payload: err instanceof Error ? err.message : "Unknown error",
  }))) as Parameters<typeof browser.runtime.onMessage.addListener>[0]);

async function handleMessage(message: ExtensionMessage): Promise<ExtensionResponse> {
  await ensureInit();
  switch (message.type) {
    case "SYNC_NOW": {
      if (!syncEngine) return { type: "ERROR", payload: "Engine not initialized" };
      // Await the sync so the pending message response keeps the MV3 worker alive
      // for its whole duration — otherwise a mid-sync suspension can skip the
      // lock's finally and strand the persisted lock until its TTL (C2).
      const outcome = await syncEngine.sync(
        message.payload?.data_type ? [message.payload.data_type] : undefined
      );
      // Don't answer OK for a sync that never started. This used to be a blanket OK, so
      // a stranded lock made "Sync now" a no-op that reported success.
      if (outcome === "no-backend") {
        return { type: "ERROR", payload: "No storage backend is set up yet." };
      }
      if (outcome === "already-running") {
        return { type: "ERROR", payload: "A sync is already running — try again in a moment." };
      }
      return { type: "OK" };
    }

    case "GET_STATE": {
      const state = await getState();
      return { type: "STATE", payload: state };
    }

    case "GET_SETTINGS": {
      const settings = await getSettings();
      return { type: "SETTINGS", payload: settings };
    }

    case "SAVE_SETTINGS": {
      const updated = await saveSettings(message.payload);
      setLoggerDebug(updated.debug_mode);

      // Reinit engine with new settings (awaited: an encryption/passphrase change
      // clears the upload checksums so the next sync re-uploads in the new form).
      await syncEngine?.updateSettings(updated);

      // Reconfigure alarm if interval changed
      if ("sync_interval_seconds" in message.payload || "auto_sync" in message.payload) {
        if (updated.auto_sync) {
          // FORCED: a real interval change is the one case that must restart the timer.
          await ensureSyncAlarm(updated.sync_interval_seconds, true);
        } else {
          await browser.alarms.clear(SYNC_ALARM);
        }
      }

      return { type: "OK" };
    }

    case "TEST_BACKEND": {
      const settings = await getSettings();
      const config = settings.backends.find((b) => b.type === message.payload.backend);
      if (!config) return { type: "ERROR", payload: "Backend not configured" };

      const backend = createBackend(config);
      const result = await backend.testConnection();
      return { type: "TEST_RESULT", payload: result };
    }

    case "RESOLVE_CONFLICT": {
      if (!syncEngine) return { type: "ERROR", payload: "Engine not initialized" };
      await syncEngine.resolveConflict(message.payload.id, message.payload.resolution);
      return { type: "OK" };
    }

    case "RESTORE_SESSION": {
      if (!syncEngine) return { type: "ERROR", payload: "Engine not initialized" };
      await syncEngine.restoreSession(message.payload?.id);
      return { type: "OK" };
    }

    case "CLEAR_AUDIT_LOG": {
      // Clears the local audit log (Settings → Activity). Named CLEAR_HISTORY until
      // 1.0.3 — it never touched browsing history, only this log.
      await browser.storage.local.set({ [KEYS.AUDIT_LOG]: [] });
      return { type: "OK" };
    }

    case "CREATE_SNAPSHOT": {
      if (!syncEngine) return { type: "ERROR", payload: "Engine not initialized" };
      await syncEngine.snapshotNow();
      return { type: "SNAPSHOTS", payload: await syncEngine.getSnapshots() };
    }

    case "LIST_DEVICES": {
      if (!syncEngine) return { type: "ERROR", payload: "Engine not initialized" };
      return { type: "DEVICES", payload: await syncEngine.listDevices() };
    }

    case "FORGET_DEVICE": {
      if (!syncEngine) return { type: "ERROR", payload: "Engine not initialized" };
      const removed = await syncEngine.forgetDevice(message.payload.device_id);
      return { type: "DEVICE_FORGOTTEN", payload: { removed } };
    }

    case "LIST_SNAPSHOTS": {
      if (!syncEngine) return { type: "ERROR", payload: "Engine not initialized" };
      return { type: "SNAPSHOTS", payload: await syncEngine.getSnapshots() };
    }

    case "RESTORE_SNAPSHOT": {
      if (!syncEngine) return { type: "ERROR", payload: "Engine not initialized" };
      const restored = await syncEngine.restoreFromSnapshot(message.payload.name);
      return { type: "SNAPSHOT_RESTORED", payload: { restored } };
    }

    case "DELETE_SNAPSHOT": {
      if (!syncEngine) return { type: "ERROR", payload: "Engine not initialized" };
      await syncEngine.removeSnapshot(message.payload.name);
      return { type: "SNAPSHOTS", payload: await syncEngine.getSnapshots() };
    }

    default:
      return { type: "ERROR", payload: "Unknown message type" };
  }
}

// ─── Alarm Handler ────────────────────────────────────────────────────────

browser.alarms.onAlarm.addListener(async (alarm) => {
  await ensureInit();
  if (!syncEngine) return;
  if (alarm.name === SYNC_ALARM) {
    logger.info("Alarm", "Periodic sync triggered");
    await syncEngine.sync();
  } else if (alarm.name === BOOKMARK_ALARM) {
    const settings = await getSettings();
    if (
      settings.sync_on_change &&
      settings.enabled_types.includes("bookmarks") &&
      !syncEngine.isSyncing
    ) {
      logger.info("Alarm", "Bookmark-change sync triggered");
      await syncEngine.sync(["bookmarks"]);
    }
  }
});

// ─── Lifecycle ────────────────────────────────────────────────────────────

browser.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    logger.event("Install", "First install, opening onboarding");
    browser.tabs.create({ url: browser.runtime.getURL("onboarding.html") });
  }
  await ensureInit();
});

browser.runtime.onStartup.addListener(async () => {
  await ensureInit();
});

// Register bookmark-change listeners once, synchronously, at the top level —
// MV3 requires event listeners to be attached on every worker load, and doing
// it here (not in init()) avoids stacking duplicate listeners across wakes.
registerBookmarkListeners(onBookmarkChange);

// Init on load (handles MV3 service worker wake-ups)
void ensureInit();

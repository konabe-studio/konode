// ─── Synkro Service Worker (MV3) ─────────────────────────────────────────
// Handles: alarm-based polling, bookmark/tab listeners, message routing

import type { ExtensionMessage, ExtensionResponse } from "@/lib/types";
import { getSettings, getState, setState, saveSettings } from "@/lib/utils/storage";
import { SyncEngine } from "@/lib/sync/sync-engine";
import { registerBookmarkListeners } from "@/lib/handlers/bookmarks-handler";
import { createBackend } from "@/lib/backends/abstract-backend";
import { logger, setLoggerDebug } from "@/lib/utils/logger";
import { BADGE_COLORS, STATE_UPDATE } from "@/lib/constants";

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
    await setState({ status: "idle", last_error: null });
    logger.info("ServiceWorker", "Reset stuck syncing state");
  }

  // ── Migration: drop the legacy "tabs" data type (folded into "sessions") ──
  // "tabs" is no longer part of DataType, so compare as plain strings.
  if ((settings.enabled_types as string[]).includes("tabs")) {
    const cleaned = settings.enabled_types.filter((t) => (t as string) !== "tabs");
    await saveSettings({ enabled_types: cleaned });
    settings.enabled_types = cleaned;
    logger.info("ServiceWorker", "Migrated: removed legacy 'tabs' data type");
  }

  syncEngine = new SyncEngine(settings, (state) => {
    updateBadge(state.status);
    // Push live status to any open popup/options view. chrome.extension.getViews
    // does not exist in an MV3 service worker, so just broadcast — sendMessage
    // rejects when no view is listening, which is expected; swallow it.
    chrome.runtime.sendMessage({ type: STATE_UPDATE, payload: state }).catch(() => {});
  });

  // Bookmark listeners are registered once at the top level (see bottom of file),
  // not here — init() re-runs on every SW wake and would stack duplicate listeners.

  if (settings.auto_sync) {
    await setupSyncAlarm(settings.sync_interval_seconds);
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

function updateBadge(status: string): void {
  chrome.action.setBadgeBackgroundColor({
    color: BADGE_COLORS[status as keyof typeof BADGE_COLORS] ?? BADGE_COLORS.idle,
  });

  chrome.action.setBadgeText({
    text: status === "syncing" ? "↑" : status === "error" ? "!" : "",
  });
}

// ─── Alarm ───────────────────────────────────────────────────────────────

async function setupSyncAlarm(intervalSeconds: number): Promise<void> {
  await chrome.alarms.clear("synkro-sync");
  // 0.5 min (30s) is Chrome's hard floor for background alarms — independent of
  // the storage backend (Drive/GitHub/WebDAV are all poll-only, no push), so the
  // receiving side can't pull faster than this regardless of what's configured.
  chrome.alarms.create("synkro-sync", {
    periodInMinutes: Math.max(0.5, intervalSeconds / 60),
  });
}

// ─── Bookmark Listener ────────────────────────────────────────────────────

function onBookmarkChange(): void {
  // Backstop: a one-shot alarm survives SW suspension (Chrome floors it at ~30s),
  // so a change is never lost even if the fast path below doesn't get to run.
  chrome.alarms.create("synkro-bookmark-sync", { delayInMinutes: 0.5 });

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
      await chrome.alarms.clear("synkro-bookmark-sync");
      await syncEngine.sync(["bookmarks"]);
    }
    // If a sync is already running, leave the alarm to pick this change up next.
  }, BOOKMARK_DEBOUNCE_MS);
}

// ─── Message Handler ──────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (message: ExtensionMessage, _sender, sendResponse) => {
    handleMessage(message)
      .then((response) => sendResponse(response))
      .catch((err) => {
        sendResponse({
          type: "ERROR",
          payload: err instanceof Error ? err.message : "Unknown error",
        } satisfies ExtensionResponse);
      });

    return true; // Keep channel open for async response
  }
);

async function handleMessage(message: ExtensionMessage): Promise<ExtensionResponse> {
  await ensureInit();
  switch (message.type) {
    case "SYNC_NOW": {
      if (!syncEngine) return { type: "ERROR", payload: "Engine not initialized" };
      syncEngine.sync(message.payload?.data_type ? [message.payload.data_type] : undefined);
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
          await setupSyncAlarm(updated.sync_interval_seconds);
        } else {
          await chrome.alarms.clear("synkro-sync");
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

    case "SET_EXTENSION_ENABLED": {
      await new Promise<void>((resolve, reject) =>
        chrome.management.setEnabled(message.payload.id, message.payload.enabled, () =>
          chrome.runtime.lastError
            ? reject(new Error(chrome.runtime.lastError.message))
            : resolve()
        )
      );
      return { type: "OK" };
    }

    case "CLEAR_HISTORY": {
      // Clears the local audit log shown in the popup.
      await chrome.storage.local.set({ synkro_audit: [] });
      return { type: "OK" };
    }

    default:
      return { type: "ERROR", payload: "Unknown message type" };
  }
}

// ─── Alarm Handler ────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  await ensureInit();
  if (!syncEngine) return;
  if (alarm.name === "synkro-sync") {
    logger.info("Alarm", "Periodic sync triggered");
    await syncEngine.sync();
  } else if (alarm.name === "synkro-bookmark-sync") {
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

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    logger.info("Install", "First install — opening onboarding");
    chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });
  }
  await ensureInit();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureInit();
});

// Register bookmark-change listeners once, synchronously, at the top level —
// MV3 requires event listeners to be attached on every worker load, and doing
// it here (not in init()) avoids stacking duplicate listeners across wakes.
registerBookmarkListeners(onBookmarkChange);

// Init on load (handles MV3 service worker wake-ups)
void ensureInit();

// ─── Synkro Service Worker (MV3) ─────────────────────────────────────────
// Handles: alarm-based polling, bookmark/tab listeners, message routing

import type { ExtensionMessage, ExtensionResponse } from "@/lib/types";
import { getSettings, getState, setState, saveSettings } from "@/lib/utils/storage";
import { SyncEngine } from "@/lib/sync/sync-engine";
import { registerBookmarkListeners } from "@/lib/handlers/bookmarks-handler";
import { createBackend } from "@/lib/backends/abstract-backend";
import { logger } from "@/lib/utils/logger";

// ─── State ────────────────────────────────────────────────────────────────

let syncEngine: SyncEngine | null = null;
let lastBookmarkChange = 0;
const BOOKMARK_DEBOUNCE_MS = 5000; // 5s — reduces 409 race conditions on rapid changes

// ─── Init ─────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  const settings = await getSettings();

  // ── Reset stuck "syncing" state from previous session ──
  const currentState = await getState();
  if (currentState.status === "syncing") {
    await setState({ status: "idle", last_error: null });
    logger.info("ServiceWorker", "Reset stuck syncing state");
  }

  // ── Migration: remove "tabs" from enabled_types ──
  if (settings.enabled_types.includes("tabs")) {
    await saveSettings({
      enabled_types: settings.enabled_types.filter((t) => t !== "tabs"),
    });
    settings.enabled_types = settings.enabled_types.filter((t) => t !== "tabs");
    logger.info("ServiceWorker", "Migrated: removed tabs from enabled_types");
  }

  syncEngine = new SyncEngine(settings, async (state) => {
    updateBadge(state.status);
    try {
      const views = chrome.extension?.getViews?.({ type: "popup" }) ?? [];
      if (views.length > 0) {
        chrome.runtime.sendMessage({ type: "STATE_UPDATE", payload: state }).catch(() => {});
      }
    } catch { /* popup not open */ }
  });

  if (settings.sync_on_change && settings.enabled_types.includes("bookmarks")) {
    registerBookmarkListeners(onBookmarkChange);
  } else if (settings.enabled_types.includes("bookmarks")) {
    registerBookmarkListeners(onBookmarkChange);
  }

  if (settings.auto_sync) {
    await setupSyncAlarm(settings.sync_interval_seconds);
  }

  logger.info("ServiceWorker", "Initialized");
}

// ─── Badge ────────────────────────────────────────────────────────────────

function updateBadge(status: string): void {
  const colors: Record<string, string> = {
    idle: "#71717a",
    syncing: "#fbbf24",
    success: "#6ee7b7",
    error: "#f87171",
    conflict: "#fb923c",
  };

  chrome.action.setBadgeBackgroundColor({
    color: colors[status] ?? colors.idle,
  });

  chrome.action.setBadgeText({
    text: status === "syncing" ? "↑" : status === "error" ? "!" : "",
  });
}

// ─── Alarm ───────────────────────────────────────────────────────────────

async function setupSyncAlarm(intervalSeconds: number): Promise<void> {
  await chrome.alarms.clear("synkro-sync");
  chrome.alarms.create("synkro-sync", {
    periodInMinutes: Math.max(1, intervalSeconds / 60),
  });
}

// ─── Bookmark Listener ────────────────────────────────────────────────────

function onBookmarkChange(): void {
  const now = Date.now();
  if (now - lastBookmarkChange < BOOKMARK_DEBOUNCE_MS) return;
  lastBookmarkChange = now;
  logger.info("BookmarkChange", "Detected — syncing");
  setTimeout(async () => {
    if (!syncEngine) return;
    // Skip if already syncing — the periodic sync will pick it up
    if (syncEngine.isSyncing) {
      logger.info("BookmarkChange", "Sync already in progress, skipping");
      return;
    }
    await syncEngine.sync(["bookmarks"]);
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

      // Reinit engine with new settings
      syncEngine?.updateSettings(updated);

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

    default:
      return { type: "ERROR", payload: "Unknown message type" };
  }
}

// ─── Alarm Handler ────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "synkro-sync") {
    if (!syncEngine) return;
    logger.info("Alarm", "Periodic sync triggered");
    await syncEngine.sync();
  }
});

// ─── Lifecycle ────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    logger.info("Install", "First install — opening onboarding");
    chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });
  }
  await init();
});

chrome.runtime.onStartup.addListener(async () => {
  await init();
});

// Init on load (handles MV3 service worker wake-ups)
init().catch((err) => logger.error("ServiceWorker.init", err));

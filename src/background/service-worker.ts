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

// ─── Init ─────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  const settings = await getSettings();

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
    chrome.runtime.sendMessage({ type: "STATE_UPDATE", payload: state }).catch(() => {});
  });

  // Bookmark listeners are registered once at the top level (see bottom of file),
  // not here — init() re-runs on every SW wake and would stack duplicate listeners.

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
  // Debounce via a one-shot alarm. A setTimeout would be dropped if MV3 suspends
  // the worker before it fires; an alarm survives suspension. Re-creating the
  // alarm on each change collapses bursts into a single delayed sync.
  // (Chrome clamps alarm delays to a ~30s floor.)
  chrome.alarms.create("synkro-bookmark-sync", { delayInMinutes: 0.5 });
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

    case "RESOLVE_CONFLICT": {
      if (!syncEngine) return { type: "ERROR", payload: "Engine not initialized" };
      await syncEngine.resolveConflict(message.payload.id, message.payload.resolution);
      return { type: "OK" };
    }

    case "RESTORE_SESSION": {
      if (!syncEngine) return { type: "ERROR", payload: "Engine not initialized" };
      await syncEngine.restoreSession();
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
  await init();
});

chrome.runtime.onStartup.addListener(async () => {
  await init();
});

// Register bookmark-change listeners once, synchronously, at the top level —
// MV3 requires event listeners to be attached on every worker load, and doing
// it here (not in init()) avoids stacking duplicate listeners across wakes.
registerBookmarkListeners(onBookmarkChange);

// Init on load (handles MV3 service worker wake-ups)
init().catch((err) => logger.error("ServiceWorker.init", err));

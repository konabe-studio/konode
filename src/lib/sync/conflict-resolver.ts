import type {
  ConflictItem,
  ConflictStrategy,
  SyncPacket,
  DataType,
} from "@/lib/types";
import { logger } from "@/lib/utils/logger";
import { browser } from "@/lib/utils/ext";
import { apiPresent } from "@/lib/utils/capabilities";

// ─── Packet clock ─────────────────────────────────────────────────────────

/**
 * A packet's timestamp in millis, with an unreadable one treated as the OLDEST possible
 * moment rather than as NaN.
 *
 * Nothing validates a peer packet's timestamp, and one really did arrive without a
 * usable one (see `normalizeRemoteSessions`). `new Date(undefined).getTime()` is NaN, and
 * NaN poisons both places this clock is read. In `orderPeersByTime` the comparator then
 * returns NaN, and a comparator that returns NaN leaves the order unspecified — which
 * defeats the entire purpose of that function, whose job is to make `peers[0]` identical
 * on every device regardless of the order a backend listed the files in. In LWW,
 * `localTime >= remoteTime` is FALSE against NaN, so a peer packet with an unreadable
 * timestamp beat the local one every single time, which is the opposite of what a packet
 * we cannot date deserves.
 *
 * Oldest is the safe reading: a packet whose age cannot be established should not win on
 * age, and it sorts last instead of anywhere.
 */
export function packetTime(timestamp: string | undefined): number {
  const t = new Date(timestamp ?? "").getTime();
  return Number.isNaN(t) ? -Infinity : t;
}

// ─── Conflict Resolver ────────────────────────────────────────────────────

export class ConflictResolver {
  constructor(private strategy: ConflictStrategy) {}

  updateStrategy(strategy: ConflictStrategy): void {
    this.strategy = strategy;
  }

  /**
   * Given a local packet and a remote packet, decide which wins.
   * Returns the winning packet or null if manual resolution is needed.
   */
  resolve(
    local: SyncPacket,
    remote: SyncPacket
  ): { winner: SyncPacket | null; conflict: ConflictItem | null } {
    // Same device — no conflict
    if (local.device_id === remote.device_id) {
      return { winner: local, conflict: null };
    }

    // Same checksum — identical content, no conflict
    if (local.checksum === remote.checksum) {
      return { winner: local, conflict: null };
    }

    switch (this.strategy) {
      case "lww": {
        const localTime = packetTime(local.timestamp);
        const remoteTime = packetTime(remote.timestamp);
        const winner = localTime >= remoteTime ? local : remote;
        logger.info(
          "ConflictResolver",
          `LWW: ${winner === local ? "local" : "remote"} wins for ${local.data_type}`
        );
        return { winner, conflict: null };
      }

      case "prefer-local":
        logger.info("ConflictResolver", `Prefer-local for ${local.data_type}`);
        return { winner: local, conflict: null };

      case "prefer-remote":
        logger.info("ConflictResolver", `Prefer-remote for ${local.data_type}`);
        return { winner: remote, conflict: null };

      case "manual": {
        // METADATA ONLY. This object goes into `konode_state`, which every setState()
        // rewrites in full and every STATE_UPDATE broadcasts to the popup — so it used
        // to carry the whole local tree, the whole remote tree AND the raw packet, the
        // same data up to three times per conflict. (`local_version` was never read by
        // anything.) The engine parks the raw peer packet in its own storage key and
        // reads it back on resolve; the popup only renders `id` and `data_type`.
        const conflict: ConflictItem = {
          id: crypto.randomUUID(),
          data_type: local.data_type,
          device_id: remote.device_id,
          device_label: remote.device_label,
          timestamp: new Date().toISOString(),
          resolved: false,
        };
        logger.warn(
          "ConflictResolver",
          `Manual conflict queued for ${local.data_type}`
        );
        return { winner: null, conflict };
      }
    }
  }

}

// ─── Peer ordering ─────────────────────────────────────────────────────────

/**
 * Orders peer packets newest-first by their `timestamp` (the same clock LWW uses
 * in `resolve`). Backends list files in arbitrary order (GitHub by filename, WebDAV
 * by PROPFIND order), so the engine sorts here to guarantee `peers[0]` is the most
 * recent regardless of backend. Stable copy — does not mutate the input.
 *
 * Ties (equal timestamps — common when a 1s debounce fans a change out to several
 * devices in the same second) are broken deterministically by `device_id`, so
 * `peers[0]` (the LWW / manual-conflict baseline) is IDENTICAL on every device
 * instead of depending on the backend's listing order.
 */
export function orderPeersByTime(packets: SyncPacket[]): SyncPacket[] {
  return [...packets].sort((a, b) => {
    // COMPARED, not subtracted. `packetTime` answers -Infinity for a packet it cannot
    // date, and two of those subtract to NaN — which is the same unspecified ordering
    // this function exists to rule out, just reached by a different route. Comparing
    // sidesteps the arithmetic: equal (including both undatable) falls through to the
    // device_id tie-break, which is what makes the order identical on every device.
    const ta = packetTime(a.timestamp);
    const tb = packetTime(b.timestamp);
    if (ta !== tb) return tb > ta ? 1 : -1;
    return a.device_id.localeCompare(b.device_id);
  });
}

// ─── Notify helper ───────────────────────────────────────────────────────

/** What every conflict notification's id starts with, so a click can tell it is ours. */
export const CONFLICT_NOTIFICATION_PREFIX = "conflict-";

export function notifyConflict(dataType: DataType): void {
  // A conflict is still recorded and still resolvable in the UI without this. Losing the
  // desktop notification is a small thing; losing the SYNC because the browser doesn't
  // implement notifications would not be, and this is called from inside the sync.
  if (!apiPresent("notifications", "create")) {
    logger.info("notifyConflict", `This browser has no notifications API, so the ${dataType} conflict is only shown in Konode`);
    return;
  }
  browser.notifications.create(`${CONFLICT_NOTIFICATION_PREFIX}${Date.now()}`, {
    type: "basic",
    iconUrl: "icons/icon48.png",
    title: "Konode: Sync Conflict",
    message: `A conflict was detected in ${dataType}. Open Konode to resolve it.`,
    priority: 1,
  });
}

/**
 * Open what a clicked conflict notification asks for, and say whether the click was ours.
 *
 * The toast says "Open Konode to resolve it", and clicking it did nothing: nothing listened
 * for the click (QA step H, 2026-08-28, Brave on Windows, where the toast also sat over the
 * toolbar button it was pointing at, so the one gesture it asked for had nowhere to go).
 * Conflicts are answered in the popup, so the click brings the browser to the front and opens
 * the popup there, where the browser lets an extension do that (`action.openPopup`, every
 * Chromium from 127; see focusBrowserWindow for why the focus comes first). Otherwise it opens the
 * same page in a window the popup's size, which answers them just as well (in a full tab it
 * sat in the top left corner of an empty page), and in a tab where there are no windows to
 * open, as on Firefox for Android. Firefox only opens a popup from a user action it
 * recognises, so on the desktop it usually takes the window.
 */
export async function openConflictFromNotification(id: string): Promise<boolean> {
  if (!id.startsWith(CONFLICT_NOTIFICATION_PREFIX)) return false;
  await Promise.resolve(browser.notifications.clear?.(id)).catch(() => {});
  const action = (browser as unknown as {
    action?: { openPopup?: (options?: { windowId?: number }) => Promise<void> };
  }).action;
  if (typeof action?.openPopup === "function") {
    try {
      const windowId = await focusBrowserWindow();
      await action.openPopup(windowId === undefined ? undefined : { windowId });
      return true;
    } catch (e) {
      // No focused window to open it in, or not without a gesture. The tab still works.
      logger.info("notifyConflict", `Couldn't open the popup (${e instanceof Error ? e.message : e}), opening it in a window`);
    }
  }
  const url = browser.runtime.getURL("popup.html");
  // 360 wide as the popup is, and tall enough for a few conflict cards (it caps at 600).
  if (typeof browser.windows?.create === "function") {
    try {
      await browser.windows.create({ url, type: "popup", width: 376, height: 640, focused: true });
      return true;
    } catch (e) {
      logger.info("notifyConflict", `Couldn't open a window (${e instanceof Error ? e.message : e}), opening a tab`);
    }
  }
  await browser.tabs.create({ url });
  return true;
}

/**
 * Bring the browser window last in front back to the front, and say which one it is.
 *
 * Chrome, and Firefox from 149, refuse to open a popup in a window that is not active, and
 * the click on the toast is what took the focus away: on Windows the toast is the system's
 * own, so when `onClicked` runs no browser window is active, however much it was in front a
 * moment before. Every click took the small-window path there (QA step AL, Chrome on
 * Windows). The browsers' own advice is to focus the window first, which is also what
 * clicking a notification is expected to do. Undefined where there are no windows to focus
 * (Firefox for Android) or none is open, and openPopup then picks its own default.
 */
async function focusBrowserWindow(): Promise<number | undefined> {
  const windows = browser.windows as Partial<typeof browser.windows> | undefined;
  if (typeof windows?.getLastFocused !== "function" || typeof windows.update !== "function") return undefined;
  try {
    const win = await windows.getLastFocused({ windowTypes: ["normal"] });
    if (win.id === undefined) return undefined;
    await windows.update(win.id, { focused: true });
    return win.id;
  } catch {
    return undefined;
  }
}

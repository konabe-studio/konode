// ─── Alarm names + periodic-sync scheduling ─────────────────────────────────
// Extracted from the service worker so the scheduling rule below is unit-testable:
// the SW registers listeners at module load, so it can't be imported from a test.

import { browser } from "@/lib/utils/ext";
import type { SyncSettings } from "@/lib/types";

/** Periodic pull — how this device learns about its PEERS' changes. */
export const SYNC_ALARM = "konode-sync";

/** One-shot backstop after a bookmark edit, in case the debounced fast path doesn't
 *  get to run (a setTimeout dies with the worker; an alarm survives). */
export const BOOKMARK_ALARM = "konode-bookmark-sync";

/**
 * Make sure the periodic sync alarm exists — WITHOUT disturbing one that is already
 * running.
 *
 * MV3 recreates the service worker for every event it has a listener for: a popup
 * opening, a message, a bookmark change. `init()` runs once per worker lifetime, and it
 * used to `clear()` + `create()` the alarm unconditionally — so every one of those wakes
 * reset the alarm's next fire to now + period. Ordinary browsing could therefore push
 * the periodic pull back indefinitely, and because that pull is how a device picks up
 * its peers' edits, the more you used the browser the later other devices' changes
 * arrived. (Your OWN edits were unaffected: they have the debounced fast path plus the
 * one-shot backstop above.)
 *
 * So: create it only when it is missing. `force` is for a real interval change, the one
 * case that must restart the timer.
 *
 * Deliberately does NOT compare `periodInMinutes` against the existing alarm: the
 * browser may clamp or round the value it stored, and any mismatch there would put us
 * straight back to recreating on every wake — the bug this fixes.
 *
 * Returns true when the alarm was (re)created.
 */
export async function ensureSyncAlarm(intervalSeconds: number, force = false): Promise<boolean> {
  if (!force && (await browser.alarms.get(SYNC_ALARM))) return false;
  await browser.alarms.clear(SYNC_ALARM);
  // 0.5 min (30s) is the platform floor for background alarms — and it applies whatever
  // the backend is, since Drive/GitHub/WebDAV are all poll-only with no push. So the
  // receiving side can never pull faster than this regardless of what's configured.
  await browser.alarms.create(SYNC_ALARM, { periodInMinutes: Math.max(0.5, intervalSeconds / 60) });
  return true;
}

/**
 * Whether the periodic alarm should exist. Off when the user turned Auto sync off in
 * Settings, and off while sync is paused from the popup (#89). One rule for the
 * worker's start, a settings save and the alarm itself, so the three cannot disagree.
 */
export function periodicSyncWanted(s: Pick<SyncSettings, "auto_sync" | "sync_paused">): boolean {
  return s.auto_sync && !s.sync_paused;
}

/**
 * Whether a bookmark edit should sync on its own. A paused device still RECORDS the edit
 * (the listeners write the tombstone, move and rename logs regardless); it only does not
 * upload it until the next sync someone asks for.
 */
export function changeSyncWanted(
  s: Pick<SyncSettings, "sync_on_change" | "sync_paused" | "enabled_types">,
): boolean {
  return s.sync_on_change && !s.sync_paused && s.enabled_types.includes("bookmarks");
}

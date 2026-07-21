// ─── Shared constants ───────────────────────────────────────────────────────
// Cross-cutting values that were previously hardcoded in more than one place.
// Storage keys live in `storage.ts` (exported as KEYS); this file holds the rest.

import type { SyncStatus } from "@/lib/types";

/** Broadcast from the service worker to any open popup/options view on state change.
 *  Not part of the ExtensionMessage/Response unions (it's a one-way push), so it's
 *  centralized here to keep the two sides from drifting on the string. */
export const STATE_UPDATE = "STATE_UPDATE" as const;

/** Chrome Web Store item-detail base — used to build install links for the
 *  extension-list feature. */
export const CWS_DETAIL_BASE = "https://chrome.google.com/webstore/detail/";

/** Store SEARCH bases (query appended, URI-encoded). Used cross-store, where an
 *  id/slug can't be mapped between the Chrome Web Store and Firefox Add-ons — we
 *  link to a name search in the CURRENT browser's store instead of a dead direct
 *  link, and never query the store ourselves (privacy: no external requests). */
export const CWS_SEARCH_BASE = "https://chromewebstore.google.com/search/";
export const AMO_SEARCH_BASE = "https://addons.mozilla.org/firefox/search/?q=";

/** Toolbar badge color per sync status. The service worker can't read the UI's
 *  CSS custom properties, so the palette is mirrored here as plain values.
 *  `success` is the Konode signal green (kept in sync with the UI accent). */
export const BADGE_COLORS: Record<SyncStatus, string> = {
  idle: "#71717a",
  syncing: "#fbbf24",
  success: "#34d399",
  error: "#f87171",
  conflict: "#fb923c",
};

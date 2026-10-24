/**
 * Which of a session's tabs a restore still has to open.
 *
 * Restore used to open every tab in the peer's session, whatever was already open here. So
 * restoring a peer's 10 tabs, letting it open an 11th, and restoring again left 21 tabs: the
 * ten from the first restore and all eleven again (reported on #51). A restore now brings
 * this browser up to the session, nothing more: a tab already open here is not opened again.
 *
 * Counted, not just looked up: two tabs of the same page in the session and one open here
 * still opens the second. URLs are compared by canonicalUrlKey, so a bare origin with and
 * without its trailing slash is one page, the way the bookmark merge already treats it.
 *
 * Shared by the popup, which shows the count before the click, and by importSession, which
 * opens them, so the number on the button is the number that opens.
 */

import { canonicalUrlKey } from "@/lib/utils/url";

/**
 * Where an open tab is, or is about to be. Chromium reports an empty `url` for a tab that is
 * still loading and keeps the address in `pendingUrl`, so a tab a restore opened a moment ago
 * would not count as open, and pressing Restore again would open it a second time.
 */
export function openTabUrl(tab: { url?: string; pendingUrl?: string }): string | undefined {
  return tab.url || tab.pendingUrl;
}

export function tabsToRestore<T extends { url?: string }>(tabs: T[], openUrls: Array<string | undefined>): T[] {
  const open = new Map<string, number>();
  for (const url of openUrls) {
    if (!url) continue; // no `tabs` permission: the URL is withheld, and the tab counts as nothing
    const key = canonicalUrlKey(url);
    open.set(key, (open.get(key) ?? 0) + 1);
  }
  return tabs.filter((t) => {
    const key = t.url ? canonicalUrlKey(t.url) : "";
    const here = open.get(key) ?? 0;
    if (!here) return true;
    open.set(key, here - 1);
    return false;
  });
}

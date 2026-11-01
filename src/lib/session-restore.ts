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
import { browser } from "@/lib/utils/ext";

/**
 * Where an open tab is, or is about to be. Chromium reports an empty `url` for a tab that is
 * still loading and keeps the address in `pendingUrl`, so a tab a restore opened a moment ago
 * would not count as open, and pressing Restore again would open it a second time.
 */
export function openTabUrl(tab: { url?: string; pendingUrl?: string }): string | undefined {
  return tab.url || tab.pendingUrl;
}

/**
 * The tabs a restore opened, by tab id, for as long as their page may still be on its way.
 *
 * Firefox has no `pendingUrl`: until a tab's page arrives it reads `about:blank`. So the popup
 * opened again while a restored page was still loading counted that tab as not open, offered
 * Restore again, and the press opened the page a second time (QA AU 4, headless Firefox 158).
 * The restore runs in the worker and the count in the popup, so the note is kept where both
 * read it: `storage.session`, in memory and gone with the browser, like the tabs it names.
 */
const RESTORE_PENDING_KEY = "konode_restore_pending";
// Long enough for any page to start arriving, short enough that a tab id the browser has
// handed to something else since cannot pass for the restored page for long.
export const RESTORE_PENDING_MS = 2 * 60 * 1000;

type Pending = Record<string, { url: string; at: number }>;

function sessionArea(): chrome.storage.StorageArea | undefined {
  // Absent on an engine without storage.session: the note is then simply not kept.
  return (browser.storage as unknown as { session?: chrome.storage.StorageArea }).session;
}

async function readPending(): Promise<Pending> {
  try {
    return ((await sessionArea()?.get(RESTORE_PENDING_KEY))?.[RESTORE_PENDING_KEY] as Pending | undefined) ?? {};
  } catch {
    return {};
  }
}

/** Note the tabs a restore just opened, with the address each one is loading. */
export async function rememberOpened(tabs: Array<{ id?: number; url?: string }>): Promise<void> {
  const area = sessionArea();
  if (!area) return;
  const now = Date.now();
  const kept = Object.fromEntries(Object.entries(await readPending()).filter(([, p]) => now - p.at < RESTORE_PENDING_MS));
  for (const t of tabs) if (t.id !== undefined && t.url) kept[String(t.id)] = { url: t.url, at: now };
  try {
    await area.set({ [RESTORE_PENDING_KEY]: kept });
  } catch {
    // A note that cannot be written costs a possible second tab, nothing more.
  }
}

/**
 * The open tabs' addresses for `tabsToRestore`: `openTabUrl`, except that a tab still showing
 * `about:blank` (or nothing) that a restore opened in the last two minutes counts as the page
 * it is loading.
 */
export async function openTabUrls(tabs: Array<{ id?: number; url?: string; pendingUrl?: string }>): Promise<Array<string | undefined>> {
  const pending = await readPending();
  const now = Date.now();
  return tabs.map((t) => {
    const url = openTabUrl(t);
    if (url && url !== "about:blank") return url;
    const p = t.id !== undefined ? pending[String(t.id)] : undefined;
    return p && now - p.at < RESTORE_PENDING_MS ? p.url : url;
  });
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

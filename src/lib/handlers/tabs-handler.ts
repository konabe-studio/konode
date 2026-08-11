import type { SyncSession } from "@/lib/types";

type TabInfo = { url: string; title?: string; pinned: boolean; favIconUrl?: string };
import { logger } from "@/lib/utils/logger";
import { isSafeContentUrl, isSensitiveUrl } from "@/lib/utils/url";
import { browser } from "@/lib/utils/ext";
import { assertDataTypeApi, isIOS } from "@/lib/utils/capabilities";
import { getSingleTabOpenLimit, setSingleTabOpenLimit } from "@/lib/utils/storage";

// ─── Export Current Tabs ──────────────────────────────────────────────────

/**
 * The open tabs worth publishing: plain web pages only, and never one carrying an
 * auth secret. Same rule `exportHistory` already applies.
 *
 * This used to exclude only `chrome://` and `chrome-extension://` by prefix, which
 * still uploaded `file://` (local paths, straight out of the user's disk),
 * `about:` / `moz-extension://` on Firefox, `brave://`, `edge://`, and OAuth callback
 * tabs whose fragment holds a live `#access_token=…` — to third-party storage,
 * unencrypted by default. `importSession` refuses to open every one of those anyway,
 * so this was the most sensitive data we handled, uploaded for no benefit at all.
 */
export async function exportCurrentTabs(): Promise<TabInfo[]> {
  assertDataTypeApi("sessions");
  const tabs = await browser.tabs.query({});
  const publishable = tabs.filter((t) => isSafeContentUrl(t.url) && !isSensitiveUrl(t.url));
  // Debug-only (never the audit log): a count, never the URLs themselves.
  if (publishable.length !== tabs.length) {
    logger.debug("exportCurrentTabs", `Excluded ${tabs.length - publishable.length} non-web/sensitive tab(s)`);
  }
  return publishable.map((t) => ({
    url: t.url!,
    title: t.title,
    pinned: t.pinned,
    favIconUrl: t.favIconUrl,
  }));
}

// ─── Export as Named Session ──────────────────────────────────────────────

export async function exportSession(label?: string): Promise<SyncSession> {
  const tabs = await exportCurrentTabs();
  return {
    id: crypto.randomUUID(),
    device_id: "", // filled by sync engine
    savedAt: new Date().toISOString(),
    label: label ?? `Session ${new Date().toLocaleDateString()}`,
    tabs,
  };
}

// ─── Import (open tabs from a session) ────────────────────────────────────

export async function importSession(session: SyncSession): Promise<void> {
  assertDataTypeApi("sessions");
  // Never open a non-web URL from a remote packet (javascript:/data:/file: are
  // an injection/exfiltration vector); only http(s) tabs are restored.
  const openable = session.tabs.filter((t) => {
    if (isSafeContentUrl(t.url)) return true;
    logger.warn("importSession", "Skipping an unsafe tab URL");
    return false;
  });

  logger.event("importSession", `Opening ${openable.length} tabs from "${session.label}"`);
  if (openable.length === 0) return;

  /**
   * Restore into the CURRENT window, one tab at a time, on engines that allow it.
   *
   * The history here matters, because both previous versions were half right. 1.0.2
   * replaced the per-tab loop with a single `windows.create({ url: urls })` because
   * WebKit/Orion lets only the FIRST programmatic open through per user gesture, so a
   * 15-tab session restored as one. That fixed WebKit but was applied to every engine,
   * and cost two visible things everywhere: the session landed in a NEW window instead of
   * the one you were in, and `pinned` was dropped, because the url-array form can't carry
   * it. The next version measured the engine instead: open two tabs, count them, fall
   * back to `windows.create` for the rest if the second never appeared.
   *
   * Measuring was the right instinct and the wrong order. WebKit's limit is ONE open per
   * gesture, not one per call, so spending it on tab 0 leaves nothing for the fallback:
   * the rescue window is swallowed exactly like the tab was, and the restore ends with a
   * single tab and no error. Confirmed in the field on Orion, a 10-tab session arriving
   * as 1, while the suite stayed green because a mock blocker has no concept of a user
   * gesture to run out of.
   *
   * So the engine has to be known BEFORE the gesture is spent. We remember what the last
   * restore learned, seed that from the platform on the first one, and only measure when
   * we still have no idea. Being wrong costs one restore and then corrects itself.
   */
  const urls = openable.map((t) => t.url as string);
  const openAllInOneWindow = async (list: string[]): Promise<void> => {
    try {
      await browser.windows.create({ url: list, focused: true });
    } catch (err) {
      logger.error("importSession", err);
    }
  };

  const remembered = await getSingleTabOpenLimit();
  const limited = remembered ?? (await isIOS());
  if (limited) {
    // One gesture, one open: spend it on the call that carries every URL. `pinned` is lost
    // here because the url-array form has nowhere to put it, which is the price of the
    // tabs existing at all on this engine.
    logger.event("importSession", `Opening ${urls.length} tab(s) in one window (this browser allows a single open per click)`);
    await openAllInOneWindow(urls);
    if (remembered === null) await setSingleTabOpenLimit(true);
    return;
  }

  const tabCount = async (): Promise<number> => (await browser.tabs.query({})).length;
  const before = await tabCount();

  for (let i = 0; i < openable.length; i++) {
    const t = openable[i];
    try {
      await browser.tabs.create({ url: t.url, pinned: t.pinned, active: false });
    } catch (e) {
      logger.error(`Tab open: ${t.url}`, e);
    }

    // Check once, after the second tab — the first is the one every engine allows, so it
    // proves nothing on its own. Only reachable when we had no stored answer.
    if (i === 1 && (await tabCount()) - before < 2) {
      const rest = openable.slice(1).map((x) => x.url as string);
      // Record BEFORE the rescue attempt: on WebKit the rescue is blocked too, and this
      // flag is the only reason the next restore opens all of them.
      await setSingleTabOpenLimit(true);
      logger.warn(
        "importSession",
        `This browser blocked the second tab, so ${rest.length} tab(s) are opening in their own window instead. If they don't appear, restore again: the next attempt opens them all at once.`
      );
      await openAllInOneWindow(rest);
      return;
    }
  }

  // Every tab landed where it was asked to, so per-tab restore is safe on this engine and
  // the next restore can skip the measurement.
  if (remembered === null) await setSingleTabOpenLimit(false);
}

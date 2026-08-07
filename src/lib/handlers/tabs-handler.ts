import type { SyncSession } from "@/lib/types";

type TabInfo = { url: string; title?: string; pinned: boolean; favIconUrl?: string };
import { logger } from "@/lib/utils/logger";
import { isSafeContentUrl, isSensitiveUrl } from "@/lib/utils/url";
import { browser } from "@/lib/utils/ext";
import { assertDataTypeApi } from "@/lib/utils/capabilities";

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
   * Restore into the CURRENT window, one tab at a time — and notice if that isn't working.
   *
   * 1.0.2 replaced this loop with a single `windows.create({ url: urls })` because
   * WebKit/Orion's popup blocker lets only the FIRST programmatic tab through, so a 15-tab
   * session restored as one. The workaround was correct about the problem, but it was
   * applied to every engine, and it cost two visible things everywhere: the session landed
   * in a new window instead of the one you were in, and `pinned` was dropped because the
   * url-array form has no way to carry it.
   *
   * Orion is not hypothetical — session restore genuinely works there when the backend is
   * one you can actually sign into on that engine (Koofr / WebDAV rather than Drive), so
   * simply reverting would break real users.
   *
   * So: don't guess the engine, MEASURE it. Open the first two tabs and count whether they
   * actually appeared. A blocker that throws and a blocker that silently swallows the tab
   * look identical from the return value, but neither can hide from a tab count. Engines
   * that open them get the current window and their pinned state; an engine that doesn't
   * gets the remainder in one window, exactly as before.
   */
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
    // proves nothing on its own.
    if (i === 1 && (await tabCount()) - before < 2) {
      const rest = openable.slice(1).map((x) => x.url as string);
      logger.warn(
        "importSession",
        `This browser blocked the second tab, so ${rest.length} tab(s) are opening in their own window instead`
      );
      try {
        await browser.windows.create({ url: rest, focused: true });
      } catch (err) {
        logger.error("importSession", err);
      }
      return;
    }
  }
}

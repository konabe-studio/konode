import type { SyncSession } from "@/lib/types";

type TabInfo = { url: string; title?: string; pinned: boolean; favIconUrl?: string };
import { logger } from "@/lib/utils/logger";
import { isSafeContentUrl } from "@/lib/utils/url";
import { browser } from "@/lib/utils/ext";

// ─── Export Current Tabs ──────────────────────────────────────────────────

export async function exportCurrentTabs(): Promise<TabInfo[]> {
  const tabs = await browser.tabs.query({});
  return tabs
    .filter((t) => t.url && !t.url.startsWith("chrome://") && !t.url.startsWith("chrome-extension://"))
    .map((t) => ({
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
  // Never open a non-web URL from a remote packet (javascript:/data:/file: are
  // an injection/exfiltration vector); only http(s) tabs are restored.
  const urls = session.tabs
    .filter((t) => {
      if (isSafeContentUrl(t.url)) return true;
      logger.warn("importSession", "Skipping an unsafe tab URL");
      return false;
    })
    .map((t) => t.url);

  logger.info("importSession", `Opening ${urls.length} tabs from "${session.label}"`);
  if (urls.length === 0) return;

  try {
    // Open ALL tabs in a single new window. A loop of tabs.create is blocked after
    // the first tab by WebKit/Orion's popup blocker (only the 1st programmatic tab
    // opened — confirmed against a 15-tab Brave session restoring as 1 on Orion).
    // One windows.create with a url array is a single, non-popup-limited action and
    // keeps the restored session in its own window. (pinned state isn't preserved
    // this way — an acceptable trade for actually restoring every tab.)
    await browser.windows.create({ url: urls, focused: false });
  } catch (err) {
    // Fallback for an engine without windows.create: best-effort per-tab (may hit
    // the same popup limit, but never worse than before).
    logger.warn("importSession", `windows.create failed, falling back to per-tab: ${err instanceof Error ? err.message : String(err)}`);
    for (const url of urls) {
      try {
        await browser.tabs.create({ url, active: false });
      } catch (e) {
        logger.error(`Tab open: ${url}`, e);
      }
    }
  }
}

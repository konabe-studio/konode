import type { SyncSession } from "@/lib/types";

type TabInfo = { url: string; title?: string; pinned: boolean; favIconUrl?: string };
import { logger } from "@/lib/utils/logger";
import { setTabCache, getTabCache } from "@/lib/utils/storage";
import { isSafeContentUrl } from "@/lib/utils/url";

// ─── Export Current Tabs ──────────────────────────────────────────────────

export async function exportCurrentTabs(): Promise<TabInfo[]> {
  const tabs = await chrome.tabs.query({});
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
  logger.info("importSession", `Opening ${session.tabs.length} tabs from "${session.label}"`);

  for (const tab of session.tabs) {
    // Never open a non-web URL from a remote packet (javascript:/data:/file: are
    // an injection/exfiltration vector); only http(s) tabs are restored.
    if (!isSafeContentUrl(tab.url)) {
      logger.warn("importSession", `Skipping unsafe tab URL: ${tab.url}`);
      continue;
    }
    try {
      await chrome.tabs.create({ url: tab.url, pinned: tab.pinned, active: false });
    } catch (err) {
      logger.error(`Tab open: ${tab.url}`, err);
    }
  }
}

// ─── Cache ────────────────────────────────────────────────────────────────

export async function updateTabCache(): Promise<void> {
  const tabs = await exportCurrentTabs();
  await setTabCache(tabs);
}

export async function getLastTabSnapshot(): Promise<TabInfo[] | null> {
  return getTabCache<TabInfo[]>();
}

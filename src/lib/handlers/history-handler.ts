import type { SyncHistoryItem } from "@/lib/types";
import { logger } from "@/lib/utils/logger";

// ─── Export ──────────────────────────────────────────────────────────────

export async function exportHistory(daysLimit = 30): Promise<SyncHistoryItem[]> {
  const startTime = Date.now() - daysLimit * 24 * 60 * 60 * 1000;

  const items = await chrome.history.search({
    text: "",
    startTime,
    maxResults: 5000,
  });

  return items.map((item) => ({
    url: item.url!,
    title: item.title,
    lastVisitTime: item.lastVisitTime ?? Date.now(),
    visitCount: item.visitCount ?? 1,
  }));
}

// ─── Import (merge remote history) ───────────────────────────────────────

export async function importHistory(items: SyncHistoryItem[]): Promise<void> {
  let added = 0;
  for (const item of items) {
    try {
      await chrome.history.addUrl({ url: item.url });
      added++;
    } catch (err) {
      logger.error(`History import: ${item.url}`, err);
    }
  }
  logger.info("importHistory", `Added ${added} history entries`);
}

// ─── Diff (only new entries since last sync) ───────────────────────────────

export async function getHistorySince(since: number): Promise<SyncHistoryItem[]> {
  const items = await chrome.history.search({
    text: "",
    startTime: since,
    maxResults: 1000,
  });

  return items.map((item) => ({
    url: item.url!,
    title: item.title,
    lastVisitTime: item.lastVisitTime ?? Date.now(),
    visitCount: item.visitCount ?? 1,
  }));
}

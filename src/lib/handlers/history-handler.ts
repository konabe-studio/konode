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
  // NOTE: chrome.history.addUrl can only record a visit at the *current* time —
  // the API cannot restore the original visitCount or lastVisitTime. History
  // restore is therefore inherently lossy (export/backup is the faithful path).
  // We at least de-dup against existing local URLs so repeated syncs don't keep
  // re-adding the same pages and inflating their visit counts.
  const existing = await chrome.history.search({ text: "", startTime: 0, maxResults: 100000 });
  const known = new Set(existing.map((h) => h.url));

  let added = 0;
  for (const item of items) {
    if (!item.url || known.has(item.url)) continue;
    try {
      await chrome.history.addUrl({ url: item.url });
      known.add(item.url);
      added++;
    } catch (err) {
      logger.error(`History import: ${item.url}`, err);
    }
  }
  logger.info("importHistory", `Added ${added} new history entries (skipped existing)`);
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

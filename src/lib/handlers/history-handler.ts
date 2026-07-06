import type { SyncHistoryItem } from "@/lib/types";
import { logger } from "@/lib/utils/logger";
import { isSafeContentUrl } from "@/lib/utils/url";
import { getImportedHistoryUrls, addImportedHistoryUrls } from "@/lib/utils/storage";

const EXPORT_MAX_RESULTS = 5000;

// ─── Export ──────────────────────────────────────────────────────────────

export async function exportHistory(daysLimit = 30): Promise<SyncHistoryItem[]> {
  const startTime = Date.now() - daysLimit * 24 * 60 * 60 * 1000;

  const items = await chrome.history.search({
    text: "",
    startTime,
    maxResults: EXPORT_MAX_RESULTS,
  });

  if (items.length >= EXPORT_MAX_RESULTS) {
    logger.warn("exportHistory", `Hit the ${EXPORT_MAX_RESULTS}-entry export cap — older history in the window is not synced this cycle`);
  }

  // Exclude URLs this device only RECEIVED via import (not genuinely visited
  // here) so imported entries aren't re-published as native visits and resurrect
  // across the mesh even after the origin device forgets them.
  const imported = new Set(await getImportedHistoryUrls());

  return items
    .filter((item) => item.url && !imported.has(item.url))
    .map((item) => ({
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
  const importedUrls: string[] = [];
  for (const item of items) {
    if (!item.url || known.has(item.url)) continue;
    // Only add plain web URLs from a remote packet — never javascript:/data:/file:.
    if (!isSafeContentUrl(item.url)) {
      logger.warn("importHistory", `Skipping unsafe URL: ${item.url}`);
      continue;
    }
    try {
      await chrome.history.addUrl({ url: item.url });
      known.add(item.url);
      importedUrls.push(item.url);
      added++;
    } catch (err) {
      logger.error(`History import: ${item.url}`, err);
    }
  }
  // Remember what we imported so exportHistory won't re-publish it as a native
  // visit (CO-6: stops old history from circulating the mesh indefinitely).
  await addImportedHistoryUrls(importedUrls);
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

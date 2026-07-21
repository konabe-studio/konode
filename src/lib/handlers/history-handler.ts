import type { SyncHistoryItem } from "@/lib/types";
import { logger } from "@/lib/utils/logger";
import { isSafeContentUrl } from "@/lib/utils/url";
import { getImportedHistoryUrls, addImportedHistoryUrls } from "@/lib/utils/storage";
import { browser } from "@/lib/utils/ext";

const EXPORT_MAX_RESULTS = 5000;

// ─── Export ──────────────────────────────────────────────────────────────

export async function exportHistory(daysLimit = 30): Promise<SyncHistoryItem[]> {
  const startTime = Date.now() - daysLimit * 24 * 60 * 60 * 1000;

  const items = await browser.history.search({
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
  // NOTE: on Chrome, history.addUrl records a visit only at the *current* time
  // (its API takes no visitTime), so the original lastVisitTime is lost and
  // visitCount can't be restored at all — history restore is lossy there
  // (export/backup is the faithful path). Firefox's addUrl does accept visitTime,
  // so the original date IS preserved below on Firefox. Either way we de-dup
  // against existing local URLs so repeated syncs don't re-add pages.
  const existing = await browser.history.search({ text: "", startTime: 0, maxResults: 100000 });
  const known = new Set(existing.map((h) => h.url));

  let added = 0;
  const importedUrls: string[] = [];
  for (const item of items) {
    if (!item.url || known.has(item.url)) continue;
    // Only add plain web URLs from a remote packet — never javascript:/data:/file:.
    if (!isSafeContentUrl(item.url)) {
      logger.warn("importHistory", "Skipping an unsafe URL");
      continue;
    }
    try {
      // Firefox's history.addUrl honors visitTime, so the restored entry keeps
      // its real date; Chrome's ignores everything but url and always stamps the
      // current time (its UrlDetails type has no visitTime — hence the cast).
      // Passing it is a harmless no-op on Chrome and preserves the timeline on
      // Firefox. The original time can't otherwise be set from an extension.
      const details: chrome.history.Url & { visitTime?: number } = { url: item.url };
      // Firefox's addUrl requires an INTEGER visitTime and rejects a fractional
      // value (Chrome's history search returns sub-millisecond floats like
      // 1783492571151.999), so round before passing. Chrome ignores it either way.
      if (item.lastVisitTime) details.visitTime = Math.round(item.lastVisitTime);
      await browser.history.addUrl(details);
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

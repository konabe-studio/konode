import type { SyncHistoryItem } from "@/lib/types";
import { logger } from "@/lib/utils/logger";
import { canonicalUrlKey, isSafeContentUrl, isSensitiveUrl } from "@/lib/utils/url";
import {
  getImportedHistoryUrls, addImportedHistoryUrls, dropImportedHistoryUrls,
} from "@/lib/utils/storage";
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
    logger.warn("exportHistory", `Hit the ${EXPORT_MAX_RESULTS}-entry export cap: older history in the window is not synced this cycle`);
  }

  // Exclude URLs this device only RECEIVED via import (not genuinely visited
  // here) so imported entries aren't re-published as native visits and resurrect
  // across the mesh even after the origin device forgets them.
  //
  // Keyed on the CANONICAL url, like the bookmark merge. The set holds what the PEER
  // published, while `items` comes back from the local history API in the browser's own
  // canonical form — so a raw-string compare missed (`https://x.com` vs `https://x.com/`)
  // and the device re-published imported entries as its own visits, which is exactly the
  // mesh-circulation this set exists to stop. Canonicalizing on read also keeps legacy
  // raw entries matching.
  const imported = new Set((await getImportedHistoryUrls()).map(canonicalUrlKey));

  // Release anything this device has SINCE VISITED ITSELF. importHistory records exactly
  // one visit per URL, so a local visitCount above 1 means the user has navigated here on
  // their own — at which point this is genuinely this device's browsing, and withholding
  // it from the group is wrong.
  //
  // Nothing used to leave this set. Once a page had arrived from any peer, this device
  // stopped publishing it forever. With three devices, each had already received most of
  // the mesh's URLs, so a day spent on familiar sites exported as NOTHING — which is
  // exactly the field report: a day of activity on one machine, "Added 0 new history
  // entries" on the other.
  const reclaimed = items
    .filter((i) => i.url && (i.visitCount ?? 1) > 1 && imported.has(canonicalUrlKey(i.url)))
    .map((i) => canonicalUrlKey(i.url as string));
  if (reclaimed.length) {
    await dropImportedHistoryUrls(reclaimed);
    for (const k of reclaimed) imported.delete(k);
    logger.info("exportHistory", `Publishing ${reclaimed.length} page(s) visited here since they arrived`);
  }

  return items
    // Never sync a URL that embeds an auth secret (OAuth callback token, reset
    // link, …) — even E2EE'd, that's uploading a live credential to third-party
    // storage. It stays in the local browser history; it just isn't published.
    .filter((item) => item.url && !imported.has(canonicalUrlKey(item.url)) && !isSensitiveUrl(item.url))
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
  // De-dup on the CANONICAL url, not the raw string. The browser canonicalizes on write
  // (a bare origin gains its trailing slash, the host lowercases, a default port drops),
  // so a peer that published `https://x.com` never matched the `https://x.com/` sitting
  // in local history — and the entry was re-added as a FRESH VISIT on every sync cycle,
  // forever, quietly inflating the visit count and the "most visited" ranking. Same
  // canonical key the bookmark merge uses for the same reason.
  const existing = await browser.history.search({ text: "", startTime: 0, maxResults: 100000 });
  const known = new Set(existing.filter((h) => h.url).map((h) => canonicalUrlKey(h.url as string)));

  let added = 0;
  const importedUrls: string[] = [];
  for (const item of items) {
    if (!item.url) continue;
    const key = canonicalUrlKey(item.url);
    if (known.has(key)) continue;
    // Only add plain web URLs from a remote packet — never javascript:/data:/file:.
    if (!isSafeContentUrl(item.url)) {
      logger.warn("importHistory", "Skipping an unsafe URL");
      continue;
    }
    // Defense in depth: a legacy packet (written before export filtered these) may
    // still carry an auth-secret URL — don't re-add it locally either.
    if (isSensitiveUrl(item.url)) continue;
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
      known.add(key);
      importedUrls.push(key);
      added++;
    } catch {
      // A per-URL rejection is non-fatal and expected for some entries the local
      // browser refuses to add (Firefox rejects over-long / malformed URLs, etc.).
      // Warn (not error) and log only the host — never the full URL, which could
      // carry sensitive query/fragment data — so one bad entry can't flood or leak.
      let host = "?";
      try { host = new URL(item.url).host; } catch { /* keep "?" */ }
      logger.warn("importHistory", `Skipped a history URL the browser rejected (${host})`);
    }
  }
  // Remember what we imported so exportHistory won't re-publish it as a native
  // visit (CO-6: stops old history from circulating the mesh indefinitely).
  await addImportedHistoryUrls(importedUrls);
  const summary = `Added ${added} new history entries (skipped existing)`;
  // Only worth remembering when it actually added something.
  if (added) logger.event("importHistory", summary);
  else logger.info("importHistory", summary);
}

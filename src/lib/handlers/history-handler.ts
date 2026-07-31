import type { SyncHistoryItem } from "@/lib/types";
import { logger } from "@/lib/utils/logger";
import { canonicalUrlKey, isSafeContentUrl, isSensitiveUrl } from "@/lib/utils/url";
import {
  getImportedHistoryStamps, recordImportedHistory, releaseImportedHistory,
} from "@/lib/utils/storage";
import { browser } from "@/lib/utils/ext";

const EXPORT_MAX_RESULTS = 5000;

/**
 * Slack when comparing a page's local last-visit time against the moment we imported it.
 *
 * We stamp the import with `Date.now()`, but the browser records the visit a beat later,
 * so the read-back time is a hair AFTER our stamp. Without slack that difference reads as
 * "the user visited this page themselves" and the import bounces straight back out.
 * Anything under this is an import; anything over it is a person.
 */
const IMPORT_STAMP_TOLERANCE_MS = 5_000;

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

  // Exclude pages this device only RECEIVED (CO-6) — publishing those as native visits
  // would circulate the mesh's own history back through it forever. But "received here"
  // is not "never visited here", and the old string[] could not tell them apart: once a
  // page had arrived from any peer, this device stopped publishing it PERMANENTLY, even
  // after the user genuinely browsed there. With three devices that had each received
  // most of the group's URLs, a day on familiar sites exported nothing at all.
  //
  // The stamp map answers the real question. A page is ours to publish as soon as its
  // local last-visit time has moved past the moment our import put it there.
  const stamps = await getImportedHistoryStamps();

  const publishable: chrome.history.HistoryItem[] = [];
  const reclaimed: string[] = [];
  for (const item of items) {
    // Never sync a URL that embeds an auth secret (OAuth callback token, reset link, …) —
    // even E2EE'd, that's uploading a live credential to third-party storage. It stays in
    // the local browser history; it just isn't published.
    if (!item.url || isSensitiveUrl(item.url)) continue;
    const key = canonicalUrlKey(item.url);
    const stamp = stamps[key];
    if (stamp !== undefined) {
      if ((item.lastVisitTime ?? 0) <= stamp + IMPORT_STAMP_TOLERANCE_MS) continue;
      reclaimed.push(key); // visited here since it arrived — it's genuinely ours now
    }
    publishable.push(item);
  }
  if (reclaimed.length) {
    await releaseImportedHistory(reclaimed);
    logger.info("exportHistory", `Publishing ${reclaimed.length} page(s) visited here since they arrived`);
  }

  return publishable.map((item) => ({
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
  // The LAST VISIT TIME per URL, not just "do we have it". Presence alone meant a page the
  // receiver had ever opened could never receive another visit from a peer, so two devices
  // browsing the same sites synced nothing and the log read "Added 0 new history entries"
  // forever. Reported from the field as a full day of browsing that never showed up.
  const localLastVisit = new Map<string, number>();
  for (const h of existing) {
    if (h.url) localLastVisit.set(canonicalUrlKey(h.url), h.lastVisitTime ?? 0);
  }

  // One stamp for the whole batch: the moment these visits arrived here. exportHistory
  // compares against it to tell an import apart from the user's own later visit.
  const stamp = Date.now();
  let added = 0;
  const importedUrls: string[] = [];
  for (const item of items) {
    if (!item.url) continue;
    const key = canonicalUrlKey(item.url);
    const localTime = localLastVisit.get(key);
    // Take a peer's visit only when it is genuinely NEWER than anything we already hold
    // for that page. That single test is what keeps this from looping, on both engines:
    // Chrome's addUrl stamps the visit NOW, so our local time immediately exceeds the
    // peer's and the same visit can never be taken twice; Firefox's honors visitTime, so
    // our local time becomes exactly the peer's and the strict `>` blocks the repeat.
    // Without it, addUrl would re-record the same visit every cycle — the visit-count
    // inflation that made the blanket skip necessary in the first place.
    if (localTime !== undefined && !(item.lastVisitTime !== undefined && item.lastVisitTime > localTime)) continue;
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
      // Assume the worst case for a repeat within this same batch: Chrome will have
      // stamped the visit now, so nothing older than `stamp` can be newer than it.
      localLastVisit.set(key, Math.max(localTime ?? 0, stamp));
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
  // Remember WHEN these arrived, so exportHistory won't re-publish them as native visits
  // (CO-6: stops old history from circulating the mesh indefinitely) while still letting
  // the user's own later visit through.
  await recordImportedHistory(importedUrls, stamp);
  const summary = `Added ${added} new history entries (skipped existing)`;
  // Only worth remembering when it actually added something.
  if (added) logger.event("importHistory", summary);
  else logger.info("importHistory", summary);
}

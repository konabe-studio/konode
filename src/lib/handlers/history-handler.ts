import type { SyncHistoryItem } from "@/lib/types";
import { logger } from "@/lib/utils/logger";
import { canonicalUrlKey, isSafeContentUrl, isSensitiveUrl } from "@/lib/utils/url";
import {
  getImportedHistoryStamps, recordImportedHistory, releaseImportedHistory,
  getRejectedHistoryUrls, recordRejectedHistoryUrls, rejectionStillHolds,
  clearRejectedHistoryUrls, getVisitTimeSupport, setVisitTimeSupport,
} from "@/lib/utils/storage";
import { browser } from "@/lib/utils/ext";
import { assertDataTypeApi } from "@/lib/utils/capabilities";

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

/**
 * How many history writes are allowed in flight at once.
 *
 * The import used to await one addUrl per URL, in order. Every one of those is a round
 * trip out to the browser process, so a first sync of 3,737 entries was 3,737 round trips
 * end to end, with nothing else happening in between. That is the reported "Firefox takes
 * forever on the first sync", and it is a shape problem, not a volume problem: the same
 * number of writes overlapped is a fraction of the wall clock.
 *
 * Bounded rather than unbounded. Both engines funnel these into one history database, so
 * firing several thousand at once buys nothing over a modest window and risks starving
 * the rest of the browser on a big first sync.
 */
const IMPORT_CONCURRENCY = 16;

/**
 * Does this browser's history.addUrl accept a `visitTime`?
 *
 * Firefox does, and keeps the page's real date. CHROME REJECTS THE WHOLE CALL: its
 * `details` parameter is validated strictly, and an unknown property throws "Error at
 * parameter 'details': Unexpected property: 'visitTime'". The code here claimed for a long
 * time that passing it was "a harmless no-op on Chrome", which was simply wrong. Because
 * the failure was swallowed by a bare `catch {}`, the consequence stayed invisible: on
 * Chromium virtually every page arriving from another device was refused, since virtually
 * every one carries a visit time. It surfaced only once rejections began reporting why.
 *
 * Detected by CAPABILITY, not by engine: send it, and if the call fails, try the same page
 * again without it. A browser that accepts the property is never charged for the probe,
 * and the answer holds for any engine, including ones that don't exist yet. The answer is
 * persisted so an MV3 worker restart doesn't have to rediscover it.
 */

// ─── Export ──────────────────────────────────────────────────────────────

export async function exportHistory(daysLimit = 30): Promise<SyncHistoryItem[]> {
  assertDataTypeApi("history");
  const startTime = Date.now() - daysLimit * 24 * 60 * 60 * 1000;

  const items = await browser.history.search({
    text: "",
    startTime,
    maxResults: EXPORT_MAX_RESULTS,
  });

  if (items.length >= EXPORT_MAX_RESULTS) {
    // Console only. This is a standing fact about the user's history size, not an event:
    // warning about it every cycle put one line a minute into a 200-entry log and pushed
    // out everything worth reading. The cap belongs in Settings, where it stays visible
    // without repeating.
    logger.info("exportHistory", `Hit the ${EXPORT_MAX_RESULTS}-entry export cap: older history in the window is not synced this cycle`);
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
    // Non-web URLs are dropped BEFORE they go out. Only isSensitiveUrl was checked here,
    // so a Chromium device happily published its `file://` paths and `chrome://` pages —
    // a privacy leak in its own right (the tab sync already refuses these for that very
    // reason), and the far end can never store them, so it re-rejects the same URLs on
    // every cycle forever. The loop was feeding itself.
    if (!item.url || !isSafeContentUrl(item.url) || isSensitiveUrl(item.url)) continue;
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

/**
 * Canonical URL → local last-visit time, for every page this browser holds.
 *
 * Split out and passed in because of what it costs. It reads the WHOLE local history
 * (up to 100k rows) and builds a map of it, and `importHistory` runs once per PEER, not
 * once per sync: three other devices meant three full scans a minute at the default
 * interval, each one allocating a map of every page the user has ever visited. The engine
 * now builds this once per sync and hands the same map to every peer's import.
 *
 * Which is only safe because the import keeps it CURRENT: every page it stores is written
 * back into the map, so the second peer sees what the first one added and the "is the
 * peer's visit newer than ours" test still answers correctly. Re-reading from the browser
 * was what used to make that true.
 */
export async function buildLocalHistoryIndex(): Promise<Map<string, number>> {
  assertDataTypeApi("history");
  const existing = await browser.history.search({ text: "", startTime: 0, maxResults: 100000 });
  const index = new Map<string, number>();
  for (const h of existing) {
    if (h.url) index.set(canonicalUrlKey(h.url), h.lastVisitTime ?? 0);
  }
  return index;
}

export async function importHistory(
  items: SyncHistoryItem[],
  localIndex?: Map<string, number>
): Promise<void> {
  assertDataTypeApi("history");
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
  // The LAST VISIT TIME per URL, not just "do we have it". Presence alone meant a page the
  // receiver had ever opened could never receive another visit from a peer, so two devices
  // browsing the same sites synced nothing and the log read "Added 0 new history entries"
  // forever. Reported from the field as a full day of browsing that never showed up.
  //
  // Built here only when nobody handed us one. The sync engine does, once per cycle,
  // because this scan is the expensive part of an import and it was being paid per peer.
  const localLastVisit = localIndex ?? (await buildLocalHistoryIndex());

  // One stamp for the whole batch: the moment these visits arrived here. exportHistory
  // compares against it to tell an import apart from the user's own later visit.
  const stamp = Date.now();
  // What this browser has already refused. Re-attempting those every cycle was the single
  // biggest source of both wasted work and audit-log noise (see HIST_REJECT_RETRY_MS).
  const rejectedBefore = await getRejectedHistoryUrls();
  // null until this browser has told us, one way or the other.
  let visitTimeAccepted = await getVisitTimeSupport();
  let added = 0;
  let staleRejects = 0;
  const importedUrls: string[] = [];
  const freshlyRejected: string[] = [];
  const rejectedHosts = new Set<string>();
  let rejectReason = "";
  let unsafeSkipped = 0;

  // ── Decide everything first, write afterwards.
  //
  // Every test below is synchronous, so the whole work list can be settled in one pass
  // and the writes can then overlap. Interleaving them was what forced the writes to be
  // sequential: each iteration's decision depended on the previous iteration's await.
  const pending: Array<{ url: string; key: string; visitTime?: number }> = [];
  const claimed = new Set<string>();
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
    // Already known to be unstorable here — don't spend another call finding out.
    if (rejectionStillHolds(rejectedBefore[key], stamp)) { staleRejects++; continue; }
    // Only add plain web URLs from a remote packet — never javascript:/data:/file:.
    if (!isSafeContentUrl(item.url)) { unsafeSkipped++; continue; }
    // Defense in depth: a legacy packet (written before export filtered these) may
    // still carry an auth-secret URL — don't re-add it locally either.
    if (isSensitiveUrl(item.url)) continue;
    // A packet is URL-keyed, so it shouldn't list one page twice — but the writes overlap
    // now, and two concurrent adds of the same URL would each record a visit. Dedupe here
    // instead of relying on the loop's own bookkeeping to catch it.
    if (claimed.has(key)) continue;
    claimed.add(key);
    pending.push({
      url: item.url,
      key,
      // Firefox's addUrl requires an INTEGER visitTime and rejects a fractional value
      // (Chrome's history search returns sub-millisecond floats like 1783492571151.999),
      // so round here. Chrome ignores it either way.
      visitTime: item.lastVisitTime ? Math.round(item.lastVisitTime) : undefined,
    });
  }

  // ── Write, several at a time.
  /**
   * Record locally what a stored page's last-visit time now is, so the shared index stays
   * true for the peers folded after this one. Firefox keeps the visit time we sent;
   * Chrome ignores it and stamps the moment of the call, which is `stamp` for this batch.
   */
  const noteStored = (job: { key: string; visitTime?: number }, sentTime: boolean): void => {
    localLastVisit.set(job.key, sentTime && job.visitTime !== undefined ? job.visitTime : stamp);
  };

  const writeOne = async (job: { url: string; key: string; visitTime?: number }): Promise<void> => {
    // Only send the visit time to a browser that takes it. Firefox keeps the page's real
    // date that way; Chrome throws on the property, so there it must not be sent at all.
    const sendTime = job.visitTime !== undefined && visitTimeAccepted !== false;
    try {
      const details: chrome.history.Url & { visitTime?: number } = { url: job.url };
      if (sendTime) details.visitTime = job.visitTime;
      await browser.history.addUrl(details);
      if (sendTime && visitTimeAccepted === null) {
        visitTimeAccepted = true;
        await setVisitTimeSupport(true);
      }
      noteStored(job, sendTime);
      importedUrls.push(job.key);
      added++;
      return;
    } catch (err) {
      // Only worth a second try while we still don't know whether this browser takes the
      // property. Once it has accepted one, a failure is the page's own problem.
      if (sendTime && visitTimeAccepted === null) {
        // We sent a property this browser may not accept, so the page itself isn't
        // necessarily the problem. Try it again plainly before blaming it.
        try {
          await browser.history.addUrl({ url: job.url });
          if (visitTimeAccepted !== false) {
            visitTimeAccepted = false;
            await setVisitTimeSupport(false);
            logger.info("importHistory", "This browser doesn't accept visit times; pages will be dated when they arrive");
            // Every rejection recorded up to now was recorded while we were sending a
            // property this browser refuses, so all of them are suspect. Forget them
            // rather than leaving pages suppressed for a week over our own mistake.
            await clearRejectedHistoryUrls();
          }
          noteStored(job, false);
          importedUrls.push(job.key);
          added++;
          return;
        } catch { /* genuinely unstorable — fall through and record it */ }
      }
      // A per-URL rejection is non-fatal and expected for some entries the local browser
      // refuses to add (Firefox rejects over-long / malformed URLs, etc.). Collected and
      // reported ONCE below rather than a line each: these arrive in bursts, every line is
      // a whole-array rewrite of the audit log, and a burst of them used to bury
      // everything else in the 200-entry ring within two cycles.
      freshlyRejected.push(job.key);
      try { rejectedHosts.add(new URL(job.url).host); } catch { rejectedHosts.add("?"); }
      // The reason used to be discarded entirely (`catch {}`), which is why nobody ever
      // found out WHY Firefox refuses accounts.google.com. One message per batch is
      // affordable, and it's the only way that question ever gets answered.
      if (!rejectReason) rejectReason = err instanceof Error ? err.message : String(err);
    }
  };
  // The FIRST write goes alone while the answer is still unknown, and only then does the
  // rest overlap. `visitTimeAccepted` is one variable read and written by every concurrent
  // writeOne, so a batch of 16 starting against `null` had all 16 send the property, all
  // 16 fail on Chrome, and all 16 run the fallback probe and the `clearRejectedHistoryUrls`
  // that goes with it. Harmless, being idempotent, but it is 16 round trips and a repeated
  // log line to learn something one call answers. One probe costs one round trip, once per
  // browser, and the answer is persisted.
  let start = 0;
  if (visitTimeAccepted === null && pending.length) {
    await writeOne(pending[0]);
    start = 1;
  }
  for (let i = start; i < pending.length; i += IMPORT_CONCURRENCY) {
    await Promise.all(pending.slice(i, i + IMPORT_CONCURRENCY).map(writeOne));
  }
  // Remember WHEN these arrived, so exportHistory won't re-publish them as native visits
  // (CO-6: stops old history from circulating the mesh indefinitely) while still letting
  // the user's own later visit through.
  await recordImportedHistory(importedUrls, stamp);

  // ── One line per outcome, and each says WHAT was skipped and WHY. The old messages
  // ("Skipping an unsafe URL") named neither, so a user reading their Activity log saw a
  // wall of red that told them nothing except that something was wrong.
  if (freshlyRejected.length) {
    await recordRejectedHistoryUrls(freshlyRejected, stamp);
    const hosts = [...rejectedHosts].slice(0, 3).join(", ");
    const more = rejectedHosts.size > 3 ? ` and ${rejectedHosts.size - 3} more` : "";
    logger.warn(
      "importHistory",
      `Your browser wouldn't store ${freshlyRejected.length} page(s) from another device (${hosts}${more})` +
        `${rejectReason ? `: ${rejectReason}` : ""}. Konode won't keep retrying them.`
    );
  }
  if (unsafeSkipped) {
    logger.warn(
      "importHistory",
      `Skipped ${unsafeSkipped} page(s) that aren't ordinary web addresses. Konode only syncs http and https pages, never local files or browser-internal pages.`
    );
  }
  if (staleRejects) {
    logger.info("importHistory", `Skipped ${staleRejects} page(s) this browser refused earlier`);
  }

  const summary = `Added ${added} new history entries (skipped existing)`;
  // Only worth remembering when it actually added something.
  if (added) logger.event("importHistory", summary);
  else logger.info("importHistory", summary);
}

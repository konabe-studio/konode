// The one-time rating card in the popup.
//
// Konode asks for a rating once, ever, and only someone it has demonstrably worked for:
// two weeks after the first sync that counted, and only after many of them. A sync counts
// when it finished clean (no problem, no conflict, no held-back deletion) with at least one
// other device in the folder, because Konode with nothing to sync against has not done its
// job yet. The popup adds the rest: never during setup, never beside an error, never on an
// install no store knows (`reviewPageFor`). Either button ends it for good, and so does
// rating from the Settings row, which is always there.
//
// The counting stops at the threshold, so the worker writes this at most RATE_MIN_SYNCS
// times in an install's life and only reads it after that.

import { getRateProgress, setRateProgress } from "@/lib/utils/storage";
import type { RateProgress } from "@/lib/utils/storage";

export const RATE_MIN_DAYS = 14;
export const RATE_MIN_SYNCS = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Record one sync that counts. Returns true once counting is over, so the caller can
 * stop asking for the rest of the worker's life.
 *
 * Never throws: a storage hiccup here must not turn a sync that worked into a failed one.
 */
export async function noteCleanSync(now: number = Date.now()): Promise<boolean> {
  try {
    const p = await getRateProgress();
    if (p && p.syncs >= RATE_MIN_SYNCS) return true;
    const next: RateProgress = {
      first_at: p?.first_at ?? new Date(now).toISOString(),
      syncs: (p?.syncs ?? 0) + 1,
    };
    await setRateProgress(next);
    return next.syncs >= RATE_MIN_SYNCS;
  } catch {
    return false;
  }
}

/** Whether the card has earned its one showing. The popup's own conditions come on top. */
export function rateCardDue(
  progress: RateProgress | null,
  answeredAt: string | null,
  now: number = Date.now(),
): boolean {
  if (answeredAt || !progress) return false;
  if (progress.syncs < RATE_MIN_SYNCS) return false;
  const first = Date.parse(progress.first_at);
  return Number.isFinite(first) && now - first >= RATE_MIN_DAYS * DAY_MS;
}

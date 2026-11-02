/**
 * The title writes the merge made itself, so the recorder can tell them from the user's.
 *
 * `importing` is a window in TIME: it is true while a merge runs, and the browser delivers
 * onChanged whenever it gets round to it — often after the merge that caused it has already
 * returned. That window cost us in both directions.
 *
 * Late: an echo of the merge's own rename arrived outside the window, read as a user rename
 * and went out re-stamped with `Date.now()`, outranking every peer's copy of the same
 * operation. That is the sync loop reported from the field.
 *
 * Early: everything the user did INSIDE the window was dropped. A sync runs every minute and
 * takes seconds, so a folder renamed at the wrong moment recorded nothing. The new title
 * still rode along in the tree, but the operation did not, and the peers — which match
 * folders by title — found no folder of that name and made one beside the user's.
 *
 * So the merge says what it wrote, and the recorder skips the one event that matches it, by
 * CONTENT rather than by timing. Every other rename is recorded, mid-sync or not.
 *
 * Deliberately a leaf module: no chrome, no storage, nothing to import. It is in-memory
 * state in a service worker that can be torn down at any moment, which is fine — a worker
 * that dies mid-merge loses the records AND the events they were waiting for.
 */

/**
 * How long an unclaimed write stays claimable.
 *
 * Far beyond any plausible event delay, because the two failure modes are not equal: an
 * entry that expires too early lets an echo through, which is the field loop, while one
 * that lingers can only swallow a rename to the very same title on the very same node,
 * and only if the merge's own event was never delivered at all.
 */
const TTL_MS = 30_000;

interface SelfWrite {
  title: string;
  at: number;
}

/** node id → the titles the merge wrote to it and has not seen come back yet. */
const pending = new Map<string, SelfWrite[]>();

function prune(now: number): void {
  for (const [id, list] of pending) {
    const live = list.filter((w) => now - w.at < TTL_MS);
    if (live.length) pending.set(id, live);
    else pending.delete(id);
  }
}

/**
 * The merge is about to write `title` to `id`.
 *
 * Called BEFORE the write, not after: nothing promises that the write resolves before its
 * own event is delivered. A write that then fails leaves an entry nobody claims, which the
 * TTL clears.
 */
export function noteSelfTitleWrite(id: string, title: string): void {
  const now = Date.now();
  prune(now);
  const list = pending.get(id) ?? [];
  list.push({ title, at: now });
  pending.set(id, list);
}

/**
 * Is this onChanged the merge's own write coming back? Claims the record if so, so a
 * second, genuine rename to the same title is still recorded.
 */
export function takeSelfTitleWrite(id: string, title: string): boolean {
  const now = Date.now();
  prune(now);
  const list = pending.get(id);
  if (!list) return false;
  const i = list.findIndex((w) => w.title === title);
  if (i < 0) return false;
  list.splice(i, 1);
  if (!list.length) pending.delete(id);
  return true;
}

/**
 * Test seam: drop what one test's merge wrote, so it cannot answer for the next one's.
 *
 * Wired into the suite's global `beforeEach` rather than each test file's, because the
 * bookmark fake hands out the same ids to every test — an unclaimed entry from one would
 * otherwise silence a rename in another, which is how the first attempt at this went wrong.
 */
export function resetSelfWrites(): void {
  pending.clear();
}

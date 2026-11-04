import type { ConflictDiff, DiffSide, SyncBookmark, SyncHistoryItem } from "@/lib/types";
import { blockedSample, normalizePayload } from "@/lib/handlers/bookmarks-handler";
import { rootKindOf } from "@/lib/utils/bookmark-roots";
import { canonicalUrlKey } from "@/lib/utils/url";

/**
 * What differs between this device and the peer on a Manual conflict card (#35).
 *
 * The card asked "Keep local or Use remote?" about two versions nobody could see. These are
 * the facts that question is about, in the units the person is deciding about: bookmarks
 * and visited pages, by title and address, not a text diff of two JSON files.
 *
 * An item is the same item on both sides when its address is, compared by canonicalUrlKey
 * like everywhere else, so `https://x.com` and `https://x.com/` are one page. A bookmark
 * held twice on one side is still one entry in the lists.
 *
 * Kept pure, apart from the engine that opens the packets, so it can be tested on payloads.
 */

/** How many entries each list shows before "and N more". Not stored, so more than #23's five. */
export const CONFLICT_SAMPLE_SIZE = 10;

interface Entry {
  /** The first copy met, which is the one listed. */
  first: { title?: string; url: string };
  /** Each copy's folder path and title. Two devices agree on a bookmark when these do. */
  where: Set<string>;
}

/**
 * Every bookmark in a tree, by canonical address, in tree order.
 *
 * The folder path is keyed the way bookmarkContent keys it (#34), the root by its kind
 * rather than its title or id, so the same tree on Chrome and on Firefox gives the same
 * paths and a bookmark is never "moved" just because the two browsers name their roots
 * differently.
 */
function bookmarkEntries(tree: SyncBookmark[]): Map<string, Entry> {
  const out = new Map<string, Entry>();
  // tree[0] is the virtual root and its children the real roots; a bare list of roots too.
  const roots = tree[0]?.children ?? tree;
  roots.forEach((root, i) => {
    const kind = rootKindOf(root);
    const top = kind === "menu" ? "other" : kind ?? `root:${root.title?.trim().toLowerCase() || i}`;
    const walk = (nodes: SyncBookmark[] | undefined, path: string[]): void => {
      for (const n of nodes ?? []) {
        if (n._deleted) continue;
        if (n.url) {
          const key = canonicalUrlKey(n.url);
          const where = [...path, n.title ?? ""].join("\u0000");
          const seen = out.get(key);
          if (seen) seen.where.add(where);
          else out.set(key, { first: { title: n.title, url: n.url }, where: new Set([where]) });
        } else {
          walk(n.children, [...path, n.title ?? ""]);
        }
      }
    };
    walk(root.children, [top]);
  });
  return out;
}

function side(entries: Map<string, Entry>, other: Map<string, Entry>): DiffSide {
  const missing = [...entries].filter(([key]) => !other.has(key)).map(([, e]) => e.first);
  return { total: missing.length, sample: blockedSample(missing, CONFLICT_SAMPLE_SIZE) };
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

/**
 * Bookmarks: which addresses only one side has, and how many both have but keep under a
 * different title or in a different folder.
 *
 * `remoteTree` is the peer's tree as Use remote would read it, with this device's
 * exclusions already taken out (see peerTreeAsMerged). The local payload is this device's
 * export, which never held them.
 */
export function diffBookmarks(localPayload: unknown, remoteTree: SyncBookmark[]): ConflictDiff {
  const local = bookmarkEntries(normalizePayload(localPayload).tree);
  const remote = bookmarkEntries(remoteTree);
  let changed = 0;
  for (const [key, r] of remote) {
    const l = local.get(key);
    if (l && !sameSet(l.where, r.where)) changed++;
  }
  return { only_remote: side(remote, local), only_local: side(local, remote), changed };
}

/** Each page once, by canonical address, most recently visited first. */
function historyEntries(payload: unknown): Map<string, Entry> {
  const items = (Array.isArray(payload) ? payload : []) as SyncHistoryItem[];
  const live = items
    .filter((h) => h && typeof h.url === "string" && h.url && !h._deleted)
    .sort((a, b) => (b.lastVisitTime ?? 0) - (a.lastVisitTime ?? 0));
  const out = new Map<string, Entry>();
  for (const h of live) {
    const key = canonicalUrlKey(h.url);
    if (!out.has(key)) out.set(key, { first: { title: h.title, url: h.url }, where: new Set() });
  }
  return out;
}

/**
 * History: which pages only one side has. A page both have counts as the same page whatever
 * its visit times and counts, since those are not something a person recognizes in a list,
 * so `changed` is always 0 here.
 */
export function diffHistory(localPayload: unknown, remotePayload: unknown): ConflictDiff {
  const local = historyEntries(localPayload);
  const remote = historyEntries(remotePayload);
  return { only_remote: side(remote, local), only_local: side(local, remote), changed: 0 };
}

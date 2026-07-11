import type { SyncBookmark, Tombstone, MoveRecord, BookmarkPayload, ConflictStrategy } from "@/lib/types";
import { logger } from "@/lib/utils/logger";
import {
  setBookmarkCache, getBookmarkCache,
  getTombstones, setTombstones,
  getMoves, setMoves,
} from "@/lib/utils/storage";
import { defaultOtherRootId, matchLocalRoot } from "@/lib/utils/bookmark-roots";
import { browser } from "@/lib/utils/ext";

type BookmarkNode = chrome.bookmarks.BookmarkTreeNode;

// ─── Read ─────────────────────────────────────────────────────────────────

export async function exportBookmarks(): Promise<SyncBookmark[]> {
  const tree = await browser.bookmarks.getTree();
  return tree.map(mapNode);
}

function mapNode(node: BookmarkNode): SyncBookmark {
  return {
    id: node.id,
    parentId: node.parentId ?? null,
    title: node.title,
    url: node.url,
    // Stable fallback (not Date.now()) so an unchanged tree exports to an identical
    // payload/checksum every time — the root node carries no dateAdded, and a moving
    // value there would defeat upload de-dup and cross-device checksum matching.
    dateAdded: node.dateAdded ?? 0,
    // NOTE: node.dateGroupModified is deliberately NOT synced — it's a per-folder
    // local mod-time that differs across devices for the same logical tree, so
    // including it only churned the payload/checksum. Nothing in the merge reads it.
    children: node.children?.map(mapNode),
  };
}

// ─── Tombstones (deletion tracking) ────────────────────────────────────────

const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

// Suppress tombstone recording while WE import (our own create/remove churn
// during a merge must not be mistaken for user deletions).
let importing = false;

export function toDeletedMap(list: Tombstone[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of list) m.set(t.url, Math.max(m.get(t.url) ?? 0, t.deletedAt));
  return m;
}

export function gcTombstones(list: Tombstone[]): Tombstone[] {
  const cutoff = Date.now() - TOMBSTONE_TTL_MS;
  const byUrl = new Map<string, number>();
  for (const t of list) {
    if (t.deletedAt < cutoff) continue;
    byUrl.set(t.url, Math.max(byUrl.get(t.url) ?? 0, t.deletedAt));
  }
  return [...byUrl].map(([url, deletedAt]) => ({ url, deletedAt }));
}

export function mergeTombstoneLists(a: Tombstone[], b: Tombstone[]): Tombstone[] {
  return gcTombstones([...a, ...b]);
}

// ─── Moves (placement log — same TTL/dedup shape as tombstones) ─────────────

export function toMoveMap(list: MoveRecord[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of list) m.set(r.url, Math.max(m.get(r.url) ?? 0, r.at));
  return m;
}

export function gcMoves(list: MoveRecord[]): MoveRecord[] {
  const cutoff = Date.now() - TOMBSTONE_TTL_MS;
  const byUrl = new Map<string, number>();
  for (const r of list) {
    if (r.at < cutoff) continue;
    byUrl.set(r.url, Math.max(byUrl.get(r.url) ?? 0, r.at));
  }
  return [...byUrl].map(([url, at]) => ({ url, at }));
}

export function mergeMoveLists(a: MoveRecord[], b: MoveRecord[]): MoveRecord[] {
  return gcMoves([...a, ...b]);
}

/** Record tombstones for every URL in a removed bookmark/folder subtree. */
async function recordRemovedTombstones(node: BookmarkNode): Promise<void> {
  if (importing) return;
  const urls: string[] = [];
  const walk = (n: BookmarkNode) => {
    if (n.url) urls.push(n.url);
    n.children?.forEach(walk);
  };
  walk(node);
  if (!urls.length) return;
  const now = Date.now();
  const current = await getTombstones();
  await setTombstones(mergeTombstoneLists(current, urls.map((url) => ({ url, deletedAt: now }))));
  logger.info("Tombstones", `Recorded ${urls.length} deletion(s)`);
}

/** Editing a bookmark's URL fires onChanged (NOT onRemoved), so no tombstone is
 *  recorded for the REPLACED url. Since the whole sync model is URL-keyed, a peer
 *  that still holds the old url re-adds it on the next merge — leaving a duplicate
 *  next to the edited bookmark. Record a tombstone for the old url so the edit is
 *  treated as delete(old)+add(new) and the old url is suppressed everywhere.
 *  The old url comes from the last-synced snapshot (konode_bm_cache), which is
 *  exactly what peers still hold. */
async function recordUrlChange(id: string, newUrl: string | undefined): Promise<void> {
  if (importing || !newUrl) return;
  const cache = await getBookmarkCache<SyncBookmark[]>();
  if (!cache) return;
  const prev = flattenNodes(cache).find((n) => n.id === id);
  const oldUrl = prev?.url;
  if (!oldUrl || oldUrl === newUrl) return;
  const now = Date.now();
  const current = await getTombstones();
  await setTombstones(mergeTombstoneLists(current, [{ url: oldUrl, deletedAt: now }]));
  logger.info("Tombstones", "Recorded a URL-change deletion");
}

/** Record a move (per URL) for a moved bookmark/folder subtree, so the new
 *  placement propagates with LWW. */
async function recordMove(id: string): Promise<void> {
  if (importing) return;
  const urls: string[] = [];
  try {
    const sub = await browser.bookmarks.getSubTree(id);
    const walk = (n: BookmarkNode) => {
      if (n.url) urls.push(n.url);
      n.children?.forEach(walk);
    };
    sub.forEach(walk);
  } catch {
    return;
  }
  if (!urls.length) return;
  const now = Date.now();
  const current = await getMoves();
  await setMoves(mergeMoveLists(current, urls.map((url) => ({ url, at: now }))));
  logger.info("Moves", `Recorded ${urls.length} move(s)`);
}

/** Bookmark sync payload: live tree + this device's (pruned) deletion log. */
export async function exportBookmarkPayload(): Promise<BookmarkPayload> {
  const [tree, tombstones, moves] = await Promise.all([exportBookmarks(), getTombstones(), getMoves()]);
  const gced = gcTombstones(tombstones);
  const gcedMoves = gcMoves(moves);
  await setTombstones(gced); // keep the stored logs pruned
  await setMoves(gcedMoves);
  // Snapshot the current (full) tree so a later URL edit can find the replaced
  // url by id and tombstone it (see recordUrlChange). This is the state peers hold.
  await setBookmarkCache(tree);
  // Don't sync empty folders — a folder carries no tombstone, so leaving empty
  // folders in the payload is what made a deleted folder resurrect from a peer.
  return { tree: pruneEmptyFolders(tree), tombstones: gced, moves: gcedMoves };
}

/** Normalize a parsed bookmark payload (supports the legacy bare-array format). */
export function normalizePayload(payload: unknown): BookmarkPayload {
  if (Array.isArray(payload)) return { tree: payload as SyncBookmark[], tombstones: [], moves: [] };
  const p = (payload ?? {}) as Partial<BookmarkPayload>;
  return { tree: p.tree ?? [], tombstones: p.tombstones ?? [], moves: p.moves ?? [] };
}

// ─── Write (import from remote) ──────────────────────────────────────────

export async function importBookmarks(
  payload: unknown,
  strategy: "merge" | "replace" = "merge",
  conflictStrategy: ConflictStrategy = "lww",
  deletePercent = 60
): Promise<void> {
  const { tree, tombstones: remoteTombstones, moves: remoteMoves = [] } = normalizePayload(payload);
  importing = true;
  try {
    // Capture our own deletions/moves before folding in the peer's, so the merge
    // can compare "mine vs theirs" (matters for prefer-* and move LWW). Then
    // persist the merged logs so this device propagates them onward.
    const localTombstones = await getTombstones();
    const localMoves = await getMoves();
    await setTombstones(mergeTombstoneLists(localTombstones, remoteTombstones));
    await setMoves(mergeMoveLists(localMoves, remoteMoves));

    if (strategy === "replace") {
      await clearAndImport(tree);
    } else {
      await mergeBookmarks(tree, localTombstones, remoteTombstones, localMoves, remoteMoves, conflictStrategy, deletePercent);
    }
  } finally {
    importing = false;
  }
}

async function clearAndImport(tree: SyncBookmark[]): Promise<void> {
  // The remote tree: tree[0] is the virtual root, tree[0].children are the real roots.
  const remoteRoots = tree[0]?.children ?? tree;

  // Guard: never wipe local bookmarks for an empty or malformed remote payload
  // (a corrupt/tampered file or a transient empty read must not destroy data).
  const hasRemoteContent = remoteRoots.some((r) => (r?.children?.length ?? 0) > 0);
  if (!hasRemoteContent) {
    logger.warn("clearAndImport", "Remote bookmark tree is empty/invalid — skipping destructive replace");
    return;
  }

  // Snapshot local bookmarks first so a failed import can be recovered.
  try {
    await setBookmarkCache(await exportBookmarks());
  } catch { /* best effort */ }

  // Get the local root folders. Ids are browser-specific (Chrome numbers them
  // "1"/"2"/"3"; Firefox uses "toolbar_____"/"unfiled_____"/…) — bookmark-roots.ts
  // maps between them by kind, so nothing here hardcodes Chrome ids.
  const localTree = await browser.bookmarks.getTree();
  const localRoots = localTree[0]?.children ?? [];

  // Clear all children from each local root folder
  for (const root of localRoots) {
    if (root.children) {
      for (const child of root.children) {
        try {
          await browser.bookmarks.removeTree(child.id);
        } catch { /* system folders may be protected */ }
      }
    }
  }

  // Match remote roots to local roots by kind (bar/other/mobile/menu), then exact
  // id, then title, then position — so a Chrome tree restores cleanly onto Firefox
  // and vice-versa. See matchLocalRoot in bookmark-roots.ts.
  for (let i = 0; i < remoteRoots.length; i++) {
    const remoteRoot = remoteRoots[i];
    if (!remoteRoot) continue;

    const localRootId = matchLocalRoot(remoteRoot, localRoots, i);
    if (!localRootId) continue;

    for (const child of remoteRoot.children ?? []) {
      await restoreNode(child, localRootId);
    }
  }

  logger.info("clearAndImport", "Bookmark structure restored from remote");
}

async function restoreNode(
  node: SyncBookmark,
  parentId: string
): Promise<void> {
  try {
    if (node.url) {
      await browser.bookmarks.create({
        parentId,
        title: node.title,
        url: node.url,
      });
    } else {
      const folder = await browser.bookmarks.create({
        parentId,
        title: node.title,
      });
      for (const child of node.children ?? []) {
        await restoreNode(child, folder.id);
      }
    }
  } catch (err) {
    logger.error(`Bookmark restore: ${node.title}`, err);
  }
}

async function mergeBookmarks(
  remoteTree: SyncBookmark[],
  localTombstones: Tombstone[],
  remoteTombstones: Tombstone[],
  localMoves: MoveRecord[],
  remoteMoves: MoveRecord[],
  strategy: ConflictStrategy,
  deletePercent = 60,
): Promise<void> {
  // Index local URL bookmarks (ids + newest dateAdded per URL).
  const localFlat = flattenNodes(await exportBookmarks()).filter((n) => n.url);
  const localByUrl = new Map<string, { ids: string[]; dateAdded: number }>();
  for (const n of localFlat) {
    if (!n.url) continue;
    const e = localByUrl.get(n.url) ?? { ids: [], dateAdded: 0 };
    e.ids.push(n.id);
    e.dateAdded = Math.max(e.dateAdded, n.dateAdded ?? 0);
    localByUrl.set(n.url, e);
  }

  const localDel = toDeletedMap(localTombstones);
  const remoteDel = toDeletedMap(remoteTombstones);
  const localMoveAt = toMoveMap(localMoves);
  const remoteMoveAt = toMoveMap(remoteMoves);
  const remoteAdd = new Map<string, number>();
  for (const n of flattenNodes(remoteTree)) {
    if (n.url) remoteAdd.set(n.url, Math.max(remoteAdd.get(n.url) ?? 0, n.dateAdded ?? 0));
  }

  // ── Step A: apply the peer's deletions to local ──
  // prefer-local never deletes local. prefer-remote and lww both honor a peer
  // deletion, but never destroy a local add that is STRICTLY NEWER than the
  // tombstone — a fresh re-add always survives an older deletion (a re-add is the
  // user's newer intent). prefer-remote still differs from lww on the add/move
  // side (it adopts the peer's placement); only the delete side is guarded here.
  const toRemove: string[] = [];
  if (strategy !== "prefer-local") {
    for (const [url, dAt] of remoteDel) {
      const loc = localByUrl.get(url);
      if (!loc) continue;
      if (loc.dateAdded <= dAt) toRemove.push(...loc.ids);
    }
  }
  // Safety: refuse a mass-delete from a corrupt/oversized tombstone log. The
  // threshold is user-configurable (Settings → Advanced, default 60%): a floor of
  // 20 keeps small trees from tripping it, and a normal bulk cleanup up to the
  // percentage still propagates.
  const pct = deletePercent > 0 ? deletePercent : 60;
  const cap = Math.max(20, Math.floor((localFlat.length * pct) / 100));
  if (toRemove.length > cap) {
    logger.warn("mergeBookmarks", `Skipped deleting ${toRemove.length} bookmarks (cap ${cap}, ${pct}% of ${localFlat.length}) — exceeds the mass-delete guard`);
  } else {
    for (const id of toRemove) {
      try { await browser.bookmarks.remove(id); } catch (err) { logger.error("Bookmark delete (tombstone)", err); }
    }
  }

  // ── Step B: fold the remote tree in (folders preserved). For each URL: add it
  //    if missing (unless a deletion suppresses it), or — if already local — move
  //    it to the peer's folder when the peer's placement wins (move LWW). The
  //    placement map is the CURRENT local parent per URL, read after deletions. ──
  // url → current local {id, parent, index-within-parent}, so we can detect both
  // a folder change and a reorder, and skip a move that's already in the right spot.
  const placement = new Map<string, { id: string; parentId: string | null; index: number }>();
  const indexLocal = (nodes: SyncBookmark[]): void => {
    nodes.forEach((n, i) => {
      if (n.url && !placement.has(n.url)) placement.set(n.url, { id: n.id, parentId: n.parentId, index: i });
      if (n.children) indexLocal(n.children);
    });
  };
  indexLocal(await exportBookmarks());
  const suppressedByDeletion = (url: string): boolean => {
    const lAt = localDel.get(url);
    const rAt = remoteDel.get(url);
    if (strategy === "prefer-local") return lAt !== undefined;   // honor only our deletions
    if (strategy === "prefer-remote") return rAt !== undefined;  // honor the peer's deletions
    const newestDel = Math.max(lAt ?? 0, rAt ?? 0);              // lww
    return newestDel > 0 && newestDel >= (remoteAdd.get(url) ?? 0);
  };
  const shouldMove = (url: string): boolean => {
    if (strategy === "prefer-local") return false;               // local placement wins
    if (strategy === "prefer-remote") return true;               // peer placement wins
    return (remoteMoveAt.get(url) ?? 0) > (localMoveAt.get(url) ?? 0); // lww: newer move wins
  };

  const localRoots = (await browser.bookmarks.getTree())[0]?.children ?? [];
  const otherId = defaultOtherRootId(localRoots);
  if (!otherId) {
    logger.warn("mergeBookmarks", "No writable root folder found");
    return;
  }

  let added = 0;
  let moved = 0;
  const addedUrls = new Set<string>();

  // Create folders LAZILY — a folder is only materialized when a descendant
  // bookmark is actually added/moved under it (`ensureParent` walks up and creates
  // the chain on demand, memoized). This stops an empty folder from resurrecting
  // from a peer: when a folder's bookmarks are all deleted/tombstoned (folders carry
  // no tombstone of their own), nothing triggers its creation, so it stays gone.
  // `index` = the node's position among its siblings in the REMOTE tree, so adds
  // and moves land at the peer's position instead of always at the end of the folder.
  const mergeNode = async (node: SyncBookmark, ensureParent: () => Promise<string>, index: number): Promise<void> => {
    if (node.url) {
      if (addedUrls.has(node.url)) return;
      const loc = placement.get(node.url);
      if (loc) {
        // Already local → relocate to the peer's folder/position if its placement wins.
        if (shouldMove(node.url)) {
          try {
            const targetId = await ensureParent();
            if (loc.parentId !== targetId || loc.index !== index) {
              await browser.bookmarks.move(loc.id, { parentId: targetId, index });
              moved++;
            }
          } catch (err) {
            logger.error(`Bookmark move: ${node.title}`, err);
          }
        }
        return; // present → never add a duplicate
      }
      if (suppressedByDeletion(node.url)) return;
      try {
        const parentId = await ensureParent();
        await browser.bookmarks.create({ parentId, index, title: node.title, url: node.url });
        addedUrls.add(node.url);
        added++;
      } catch (err) {
        logger.error(`Bookmark merge add: ${node.title}`, err);
      }
    } else {
      // Reuse a same-title folder under the parent, else create it (at the peer's
      // position) — but only when the first descendant actually needs it.
      let folderId: string | null = null;
      const ensureThis = async (): Promise<string> => {
        if (folderId) return folderId;
        const parentId = await ensureParent();
        const children = await browser.bookmarks.getChildren(parentId);
        const existing = children.find((c) => !c.url && c.title === node.title);
        folderId = existing
          ? existing.id
          : (await browser.bookmarks.create({ parentId, index, title: node.title })).id;
        return folderId;
      };
      let i = 0;
      for (const child of node.children ?? []) { await mergeNode(child, ensureThis, i); i++; }
    }
  };

  const remoteRoots = remoteTree[0]?.children ?? remoteTree;
  for (let r = 0; r < remoteRoots.length; r++) {
    const remoteRoot = remoteRoots[r];
    if (!remoteRoot) continue;
    const targetRootId = matchLocalRoot(remoteRoot, localRoots, r) ?? otherId;
    let i = 0;
    for (const child of remoteRoot.children ?? []) {
      await mergeNode(child, () => Promise.resolve(targetRootId), i);
      i++;
    }
  }

  logger.info("mergeBookmarks", `Merged +${added} / -${toRemove.length} / moved ${moved} (folders preserved)`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function flattenNodes(nodes: SyncBookmark[]): SyncBookmark[] {
  const result: SyncBookmark[] = [];
  function walk(n: SyncBookmark) {
    result.push(n);
    n.children?.forEach(walk);
  }
  nodes.forEach(walk);
  return result;
}

/** Drop folders with no bookmark (URL) descendant — empty folders aren't synced,
 *  so a deleted folder doesn't keep resurrecting empty from a peer. The virtual
 *  root and the three top-level roots are always kept. */
function pruneEmptyFolders(tree: SyncBookmark[]): SyncBookmark[] {
  const hasUrlDescendant = (n: SyncBookmark): boolean =>
    !!n.url || (n.children ?? []).some(hasUrlDescendant);
  const pruneChildren = (children: SyncBookmark[]): SyncBookmark[] =>
    children
      .filter((c) => !!c.url || hasUrlDescendant(c))
      .map((c) => (c.url ? c : { ...c, children: pruneChildren(c.children ?? []) }));
  return tree.map((root) => ({
    ...root,
    children: (root.children ?? []).map((r) =>
      r.url ? r : { ...r, children: pruneChildren(r.children ?? []) }
    ),
  }));
}

// ─── Listeners ───────────────────────────────────────────────────────────

export type BookmarkChangeCallback = () => void;

export function registerBookmarkListeners(onChange: BookmarkChangeCallback): void {
  browser.bookmarks.onCreated.addListener(onChange);
  browser.bookmarks.onChanged.addListener((id, changeInfo) => {
    // A URL edit is a delete(old)+add(new) in the URL-keyed sync model — record a
    // tombstone for the replaced url so a peer doesn't resurrect it as a duplicate.
    void recordUrlChange(id, changeInfo.url);
    onChange();
  });
  browser.bookmarks.onMoved.addListener((id) => {
    // Record the move (per URL, timestamped) so the new placement propagates.
    void recordMove(id);
    onChange();
  });
  browser.bookmarks.onRemoved.addListener((_id, removeInfo) => {
    // Record a tombstone so the deletion propagates instead of resurrecting.
    void recordRemovedTombstones(removeInfo.node);
    onChange();
  });
  logger.info("BookmarkListeners", "Registered");
}

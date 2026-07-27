import type { SyncBookmark, Tombstone, MoveRecord, FolderMoveRecord, BookmarkPayload, ConflictStrategy } from "@/lib/types";
import { logger } from "@/lib/utils/logger";
import {
  setBookmarkCache, getBookmarkCache,
  getTombstones, setTombstones,
  getMoves, setMoves,
  getFolderMoves, setFolderMoves,
} from "@/lib/utils/storage";
import { defaultOtherRootId, matchLocalRoot, matchLocalRootEx, rootKind } from "@/lib/utils/bookmark-roots";
import { canonicalUrlKey } from "@/lib/utils/url";
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

// ─── Folder moves (path-keyed reposition log — folders have no URL) ─────────

// A NUL joiner can't collide with a bookmark title, so it's a safe path key.
export function folderPathKey(path: string[]): string {
  return path.join("\u0000");
}

export function toFolderMoveMap(list: FolderMoveRecord[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of list) {
    const k = folderPathKey(r.path);
    m.set(k, Math.max(m.get(k) ?? 0, r.at));
  }
  return m;
}

export function gcFolderMoves(list: FolderMoveRecord[]): FolderMoveRecord[] {
  const cutoff = Date.now() - TOMBSTONE_TTL_MS;
  const byPath = new Map<string, FolderMoveRecord>();
  for (const r of list) {
    if (r.at < cutoff) continue;
    const k = folderPathKey(r.path);
    const existing = byPath.get(k);
    if (!existing || r.at > existing.at) byPath.set(k, r); // keep the newest per path
  }
  return [...byPath.values()];
}

export function mergeFolderMoveLists(a: FolderMoveRecord[], b: FolderMoveRecord[]): FolderMoveRecord[] {
  return gcFolderMoves([...a, ...b]);
}

/** URLs present anywhere in the CURRENT local tree (called after a mutation). */
async function localUrlSet(): Promise<Set<string>> {
  return new Set(flattenNodes(await exportBookmarks()).filter((n) => n.url).map((n) => n.url as string));
}

/** Record tombstones for every URL in a removed bookmark/folder subtree — but only
 *  for URLs whose LAST local copy was just removed. Deleting one of several
 *  identical-URL bookmarks must NOT tombstone the URL: the tombstone is URL-keyed,
 *  so it would delete every copy on every peer (and the surviving local copy, being
 *  older than the tombstone, wouldn't re-propagate → the devices diverge). */
async function recordRemovedTombstones(node: BookmarkNode): Promise<void> {
  if (importing) return;
  const urls: string[] = [];
  const walk = (n: BookmarkNode) => {
    if (n.url) urls.push(n.url);
    n.children?.forEach(walk);
  };
  walk(node);
  if (!urls.length) return;
  const remaining = await localUrlSet();
  const gone = [...new Set(urls)].filter((url) => !remaining.has(url));
  if (!gone.length) return; // every removed URL still has another local copy
  const now = Date.now();
  const current = await getTombstones();
  await setTombstones(mergeTombstoneLists(current, gone.map((url) => ({ url, deletedAt: now }))));
  logger.info("Tombstones", `Recorded ${gone.length} deletion(s)`);
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
  // Same guard as deletion: don't tombstone the old url if another local bookmark
  // still holds it (editing one of several identical-URL copies).
  if ((await localUrlSet()).has(oldUrl)) return;
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

/** A cross-device-stable key for a sibling used to anchor a folder reposition: a
 *  bookmark by URL, a folder by title. Both survive across devices (unlike an id or
 *  absolute index), so the receiver can locate the same anchor. */
function siblingKey(node: { url?: string; title: string }): string {
  return node.url ? `u:${node.url}` : `f:${node.title}`;
}

/** Build a folder's browser-agnostic path — `[rootKind, …ancestorTitles, title]`
 *  — by walking up the parent chain to a known root. Returns null if the chain
 *  never reaches a mappable root (so the caller fails safe). */
async function folderPath(id: string): Promise<string[] | null> {
  const path: string[] = [];
  let currentId: string | undefined = id;
  // Bound the walk so a malformed parent chain can't loop forever.
  for (let hops = 0; hops < 64 && currentId; hops++) {
    let node: BookmarkNode | undefined;
    try { [node] = await browser.bookmarks.get(currentId); } catch { return null; }
    if (!node) return null;
    const kind = rootKind(node.id);
    if (kind) { path.unshift(kind); return path; } // reached a root → done
    path.unshift(node.title);
    currentId = node.parentId;
  }
  return null;
}

/** Record a folder REPOSITION (per path) so a reorder among siblings propagates
 *  with LWW. Only pure reorders (same parent) are recorded — a cross-parent folder
 *  move relocates its bookmarks via the URL move-log (recordMove) and the emptied
 *  shell is cleaned up on the receiver during merge. A folder has no URL, so this
 *  is the only signal that carries its own position across devices. */
async function recordFolderMove(id: string, moveInfo: chrome.bookmarks.BookmarkMoveInfo): Promise<void> {
  if (importing) return;
  if (moveInfo.parentId !== moveInfo.oldParentId) return; // reorder only
  let node: BookmarkNode | undefined;
  try { [node] = await browser.bookmarks.get(id); } catch { return; }
  if (!node || node.url) return; // folders only
  const path = await folderPath(id);
  if (!path || path.length < 2) return; // need at least [kind, title]
  // Anchor to the shared siblings on either side (by url/title, not index) so the
  // reposition survives devices with different device-local siblings.
  let prev: string | undefined;
  let next: string | undefined;
  try {
    const siblings = await browser.bookmarks.getChildren(moveInfo.parentId);
    const gi = siblings.findIndex((s) => s.id === id);
    if (gi > 0) prev = siblingKey(siblings[gi - 1]);
    if (gi >= 0 && gi < siblings.length - 1) next = siblingKey(siblings[gi + 1]);
  } catch { /* best effort — fall back to index on the receiver */ }
  const now = Date.now();
  const current = await getFolderMoves();
  await setFolderMoves(mergeFolderMoveLists(current, [{ path, index: moveInfo.index, at: now, prev, next }]));
  logger.info("Moves", "Recorded a folder reposition");
}

/** Bookmark sync payload: live tree + this device's (pruned) deletion log. */
export async function exportBookmarkPayload(): Promise<BookmarkPayload> {
  const [tree, tombstones, moves, folderMoves] = await Promise.all([
    exportBookmarks(), getTombstones(), getMoves(), getFolderMoves(),
  ]);
  const gced = gcTombstones(tombstones);
  const gcedMoves = gcMoves(moves);
  const gcedFolderMoves = gcFolderMoves(folderMoves);
  await setTombstones(gced); // keep the stored logs pruned
  await setMoves(gcedMoves);
  await setFolderMoves(gcedFolderMoves);
  // Snapshot the current (full) tree so a later URL edit can find the replaced
  // url by id and tombstone it (see recordUrlChange). This is the state peers hold.
  await setBookmarkCache(tree);
  // Don't sync empty folders — a folder carries no tombstone, so leaving empty
  // folders in the payload is what made a deleted folder resurrect from a peer.
  return { tree: pruneEmptyFolders(tree), tombstones: gced, moves: gcedMoves, folderMoves: gcedFolderMoves };
}

/** Normalize a parsed bookmark payload (supports the legacy bare-array format). */
export function normalizePayload(payload: unknown): BookmarkPayload {
  if (Array.isArray(payload)) return { tree: payload as SyncBookmark[], tombstones: [], moves: [], folderMoves: [] };
  const p = (payload ?? {}) as Partial<BookmarkPayload>;
  return { tree: p.tree ?? [], tombstones: p.tombstones ?? [], moves: p.moves ?? [], folderMoves: p.folderMoves ?? [] };
}

// ─── Write (import from remote) ──────────────────────────────────────────

export async function importBookmarks(
  payload: unknown,
  strategy: "merge" | "replace" = "merge",
  conflictStrategy: ConflictStrategy = "lww",
  deletePercent = 60
): Promise<void> {
  const { tree, tombstones: remoteTombstones, moves: remoteMoves = [], folderMoves: remoteFolderMoves = [] } = normalizePayload(payload);
  importing = true;
  try {
    // Capture our own deletions/moves before folding in the peer's, so the merge
    // can compare "mine vs theirs" (matters for prefer-* and move LWW). Then
    // persist the merged logs so this device propagates them onward.
    const localTombstones = await getTombstones();
    const localMoves = await getMoves();
    const localFolderMoves = await getFolderMoves();
    await setTombstones(mergeTombstoneLists(localTombstones, remoteTombstones));
    await setMoves(mergeMoveLists(localMoves, remoteMoves));
    await setFolderMoves(mergeFolderMoveLists(localFolderMoves, remoteFolderMoves));

    if (strategy === "replace") {
      await clearAndImport(tree);
    } else {
      await mergeBookmarks(tree, localTombstones, remoteTombstones, localMoves, remoteMoves, localFolderMoves, remoteFolderMoves, conflictStrategy, deletePercent);
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
  localFolderMoves: FolderMoveRecord[],
  remoteFolderMoves: FolderMoveRecord[],
  strategy: ConflictStrategy,
  deletePercent = 60,
): Promise<void> {
  // All URL identity maps below are keyed by the CANONICAL url (canonicalUrlKey),
  // not the raw string, so a bare-origin bookmark that Chromium/Firefox store with
  // a trailing slash and WebKit (Orion) store without one are treated as the SAME
  // bookmark. Keying on the raw string re-added the peer's form every sync — an
  // unbounded duplication (seen live: telex.hu ×6 on Brave, ×11 on Firefox). We
  // still create/move using the node's original url; only matching is canonical.
  const canonMap = (m: Map<string, number>): Map<string, number> => {
    const out = new Map<string, number>();
    for (const [url, at] of m) out.set(canonicalUrlKey(url), Math.max(out.get(canonicalUrlKey(url)) ?? 0, at));
    return out;
  };

  // Index local URL bookmarks (ids + newest dateAdded per canonical URL).
  const localFlat = flattenNodes(await exportBookmarks()).filter((n) => n.url);
  const localByUrl = new Map<string, { ids: string[]; dateAdded: number }>();
  for (const n of localFlat) {
    if (!n.url) continue;
    const key = canonicalUrlKey(n.url);
    const e = localByUrl.get(key) ?? { ids: [], dateAdded: 0 };
    e.ids.push(n.id);
    e.dateAdded = Math.max(e.dateAdded, n.dateAdded ?? 0);
    localByUrl.set(key, e);
  }

  const localDel = canonMap(toDeletedMap(localTombstones));
  const remoteDel = canonMap(toDeletedMap(remoteTombstones));
  const localMoveAt = canonMap(toMoveMap(localMoves));
  const remoteMoveAt = canonMap(toMoveMap(remoteMoves));
  const remoteAdd = new Map<string, number>();
  for (const n of flattenNodes(remoteTree)) {
    if (n.url) remoteAdd.set(canonicalUrlKey(n.url), Math.max(remoteAdd.get(canonicalUrlKey(n.url)) ?? 0, n.dateAdded ?? 0));
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
  // Keyed by canonical url (see canonMap above) so lookups from the remote tree
  // match regardless of bare-origin trailing-slash differences between engines.
  const placement = new Map<string, { id: string; parentId: string | null; index: number }>();
  const indexLocal = (nodes: SyncBookmark[]): void => {
    nodes.forEach((n, i) => {
      const k = n.url ? canonicalUrlKey(n.url) : undefined;
      if (k && !placement.has(k)) placement.set(k, { id: n.id, parentId: n.parentId, index: i });
      if (n.children) indexLocal(n.children);
    });
  };
  indexLocal(await exportBookmarks());
  const suppressedByDeletion = (url: string): boolean => {
    const key = canonicalUrlKey(url);
    const lAt = localDel.get(key);
    const rAt = remoteDel.get(key);
    if (strategy === "prefer-local") return lAt !== undefined;   // honor only our deletions
    if (strategy === "prefer-remote") return rAt !== undefined;  // honor the peer's deletions
    const newestDel = Math.max(lAt ?? 0, rAt ?? 0);              // lww
    return newestDel > 0 && newestDel >= (remoteAdd.get(key) ?? 0);
  };
  const shouldMove = (url: string): boolean => {
    if (strategy === "prefer-local") return false;               // local placement wins
    if (strategy === "prefer-remote") return true;               // peer placement wins
    const key = canonicalUrlKey(url);
    return (remoteMoveAt.get(key) ?? 0) > (localMoveAt.get(key) ?? 0); // lww: newer move wins
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
  // Folders a cross-parent bookmark move emptied on THIS device — the receiver
  // relocated the bookmarks (URL move-log) but the folder they left behind is a
  // shell. Cleaned up after the fold (bottom-up), never touching user-empty
  // folders (only ids WE moved a bookmark out of).
  const emptiedParents = new Set<string>();

  // Create folders LAZILY — a folder is only materialized when a descendant
  // bookmark is actually added/moved under it (`ensureParent` walks up and creates
  // the chain on demand, memoized). This stops an empty folder from resurrecting
  // from a peer: when a folder's bookmarks are all deleted/tombstoned (folders carry
  // no tombstone of their own), nothing triggers its creation, so it stays gone.
  // `index` = the node's position among its siblings in the REMOTE tree, so adds
  // and moves land at the peer's position instead of always at the end of the folder.
  const mergeNode = async (node: SyncBookmark, ensureParent: () => Promise<string>, index: number, rootConfident: boolean, prevKey: string | undefined): Promise<void> => {
    if (node.url) {
      // Match on the canonical key (bare-origin trailing-slash differs by engine),
      // but create/move with the node's original url below.
      const urlKey = canonicalUrlKey(node.url);
      if (addedUrls.has(urlKey)) return;
      const loc = placement.get(urlKey);
      if (loc) {
        // Already local → relocate to the peer's folder/position if its placement
        // wins AND we could confidently map the peer's root. Without confidence a
        // "move" would displace the bookmark into the default root — skip it.
        if (shouldMove(node.url) && rootConfident) {
          try {
            const targetId = await ensureParent();
            // Anchor to the peer's previous sibling (shared by url/title) instead of an
            // absolute index — an index doesn't translate across devices with different
            // device-local siblings. Fall back to the peer's index when the anchor is
            // absent here. (Mirrors the folder-reposition placement in Step C.)
            const target = await anchoredIndex(targetId, loc.id, prevKey, index);
            if (loc.parentId !== targetId || loc.index !== target) {
              const from = loc.parentId;
              if (loc.parentId !== targetId) {
                await browser.bookmarks.move(loc.id, { parentId: targetId, index: target });
              } else {
                // Same-parent reorder: moveToIndex corrects the ±1 move-convention quirk
                // (a raw downward move lands one slot short on Chromium).
                await moveToIndex(loc.id, targetId, target);
              }
              moved++;
              // Track the folder we moved this bookmark OUT of, so an emptied shell
              // (left by a cross-parent folder move on the peer) is cleaned up below.
              if (from && from !== targetId && !rootKind(from)) emptiedParents.add(from);
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
        addedUrls.add(urlKey);
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
      const kids = node.children ?? [];
      for (let i = 0; i < kids.length; i++) {
        await mergeNode(kids[i], ensureThis, i, rootConfident, i > 0 ? siblingKey(kids[i - 1]) : undefined);
      }
    }
  };

  const remoteRoots = remoteTree[0]?.children ?? remoteTree;
  for (let r = 0; r < remoteRoots.length; r++) {
    const remoteRoot = remoteRoots[r];
    if (!remoteRoot) continue;
    // `confident` is false only when the peer root fell back to position/default
    // (unmappable) — moves are gated on it so a reposition from such a peer can't
    // displace an existing bookmark into the default root. See bookmark-roots.ts.
    const match = matchLocalRootEx(remoteRoot, localRoots, r);
    const targetRootId = match.id ?? otherId;
    const rootConfident = match.confident;
    const kids = remoteRoot.children ?? [];
    for (let i = 0; i < kids.length; i++) {
      await mergeNode(kids[i], () => Promise.resolve(targetRootId), i, rootConfident, i > 0 ? siblingKey(kids[i - 1]) : undefined);
    }
  }

  // ── Step C: apply folder REPOSITIONS (path-keyed LWW). A folder reordered among
  //    its siblings on a peer carries no URL, so Step B never touches its position —
  //    replay the peer's folder-move here. Placement is ANCHOR-based: position the
  //    folder immediately after the peer's `prev` sibling (or before `next`),
  //    identified by url/title so it maps across devices with different local
  //    siblings; the absolute `index` is only a last-resort fallback. Path
  //    resolution fails safe (skips) when the root kind or a path segment is absent,
  //    so no confidence gate is needed. ──
  const localFolderMoveAt = toFolderMoveMap(localFolderMoves);
  let folderMoved = 0;
  for (const rec of remoteFolderMoves) {
    const winsLWW = strategy === "prefer-local" ? false
      : strategy === "prefer-remote" ? true
      : rec.at > (localFolderMoveAt.get(folderPathKey(rec.path)) ?? 0);
    if (!winsLWW) continue;
    const folderId = await resolveFolderPath(rec.path, localRoots);
    if (!folderId) continue;
    try {
      const [node] = await browser.bookmarks.get(folderId);
      if (!node || node.parentId == null) continue;
      const siblings = await browser.bookmarks.getChildren(node.parentId);
      // The order WITHOUT this folder is the frame the anchors are resolved against.
      const rest = siblings.filter((s) => s.id !== folderId);
      let target: number | null = null;
      if (rec.prev !== undefined) {
        const p = rest.findIndex((s) => siblingKey(s) === rec.prev);
        if (p >= 0) target = p + 1;               // immediately after `prev`
      }
      if (target === null && rec.next !== undefined) {
        const n = rest.findIndex((s) => siblingKey(s) === rec.next);
        if (n >= 0) target = n;                    // immediately before `next`
      }
      if (target === null && rec.prev === undefined) target = 0; // peer had it first
      if (target === null) target = Math.min(rec.index, siblings.length - 1); // fallback
      if (node.index !== target) {
        await moveToIndex(folderId, node.parentId, target);
        folderMoved++;
      }
    } catch (err) {
      logger.error(`Folder reposition: ${rec.path.join("/")}`, err);
    }
  }

  // ── Step D: prune shells left by a cross-parent folder move (see emptiedParents).
  //    Bottom-up: removing an empty folder can empty its parent, so re-queue it. ──
  let shells = 0;
  const queue = [...emptiedParents];
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id) || rootKind(id)) continue; // never remove a root
    seen.add(id);
    try {
      const [node] = await browser.bookmarks.get(id);
      if (!node || node.url) continue; // gone already, or not a folder
      const children = await browser.bookmarks.getChildren(id);
      if (children.length === 0) {
        await browser.bookmarks.remove(id);
        shells++;
        if (node.parentId) queue.push(node.parentId);
      }
    } catch { /* concurrently removed — ignore */ }
  }

  logger.info("mergeBookmarks", `Merged +${added} / -${toRemove.length} / moved ${moved} / folders ${folderMoved} / shells ${shells} (folders preserved)`);
}

/** Resolve a browser-agnostic folder path (`[rootKind, …titles]`) to a local
 *  folder id, or null if the root kind or any path segment is missing locally. */
async function resolveFolderPath(path: string[], localRoots: BookmarkNode[]): Promise<string | null> {
  if (path.length < 2) return null;
  const [kind, ...titles] = path;
  const root = localRoots.find((r) => rootKind(r.id) === kind);
  if (!root) return null;
  let currentId = root.id;
  for (const title of titles) {
    const children = await browser.bookmarks.getChildren(currentId);
    const match = children.find((c) => !c.url && c.title === title);
    if (!match) return null; // path diverged (renamed / not yet synced)
    currentId = match.id;
  }
  return currentId;
}

/** Move a node to a target FINAL index within its parent, correcting for the
 *  browser's same-parent move convention. Chromium computes the insertion point
 *  against the pre-removal array, so a downward same-folder move lands one slot
 *  short of the requested index (Firefox uses the final-index convention and lands
 *  exactly). Read back and nudge once when it fell short — enough for the ±1 the
 *  convention difference produces, without fighting the browser in a loop. */
/** Target index for placing `movingId` in `parentId`, anchored to the peer's previous
 *  sibling (`prevKey`, a url/title key shared across devices) rather than an absolute
 *  index that doesn't translate when devices have different device-local siblings.
 *  Frame = the parent's children WITHOUT the moving node (the final-array convention
 *  moveToIndex expects). Falls back to the peer's absolute index if the anchor is
 *  absent locally. */
async function anchoredIndex(parentId: string, movingId: string, prevKey: string | undefined, fallbackIndex: number): Promise<number> {
  const rest = (await browser.bookmarks.getChildren(parentId)).filter((c) => c.id !== movingId);
  if (prevKey === undefined) return 0; // peer had it first
  const p = rest.findIndex((c) => siblingKey(c) === prevKey);
  if (p >= 0) return p + 1; // immediately after the shared prev sibling
  return Math.min(fallbackIndex, rest.length); // anchor absent locally → fallback
}

async function moveToIndex(id: string, parentId: string, finalIndex: number): Promise<void> {
  await browser.bookmarks.move(id, { index: finalIndex });
  const kids = await browser.bookmarks.getChildren(parentId);
  const actual = kids.findIndex((c) => c.id === id);
  if (actual !== -1 && actual === finalIndex - 1) {
    // Clamp to kids.length (not length-1): a same-parent move accepts index = count
    // ("to the end"), and clamping one lower re-requests the index that already fell
    // short — a move to the LAST slot would never converge.
    await browser.bookmarks.move(id, { index: Math.min(finalIndex + 1, kids.length) });
  }
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

// ─── Snapshot restore ──────────────────────────────────────────────────────

/** Restore bookmarks from a snapshot tree: re-create every URL that isn't currently
 *  present locally, into its folder path, IGNORING tombstones — the whole point of a
 *  restore point is to bring back deleted bookmarks. Fresh creates get a current
 *  dateAdded, which beats an older peer deletion on the next sync (mergeBookmarks
 *  Step A keeps a local add strictly newer than the tombstone). Local tombstones for
 *  the restored URLs are dropped so this device doesn't immediately re-delete them.
 *  Folders are materialized lazily (only when a restored bookmark lands under them),
 *  so an empty folder from the snapshot isn't recreated. Returns the count added. */
export async function restoreBookmarks(tree: SyncBookmark[]): Promise<number> {
  importing = true;
  try {
    const snapUrls = new Set(
      flattenNodes(tree).filter((n) => n.url).map((n) => canonicalUrlKey(n.url as string))
    );
    const tombs = await getTombstones();
    await setTombstones(tombs.filter((t) => !snapUrls.has(canonicalUrlKey(t.url))));

    const localRoots = (await browser.bookmarks.getTree())[0]?.children ?? [];
    const otherId = defaultOtherRootId(localRoots);
    if (!otherId) return 0;

    const present = new Set(
      flattenNodes(await exportBookmarks()).filter((n) => n.url).map((n) => canonicalUrlKey(n.url as string))
    );
    let added = 0;

    const walk = async (node: SyncBookmark, ensureParent: () => Promise<string>): Promise<void> => {
      if (node.url) {
        const key = canonicalUrlKey(node.url);
        if (present.has(key)) return;
        try {
          const parentId = await ensureParent();
          await browser.bookmarks.create({ parentId, title: node.title, url: node.url });
          present.add(key);
          added++;
        } catch { /* skip invalid url */ }
        return;
      }
      let folderId: string | null = null;
      const ensureThis = async (): Promise<string> => {
        if (folderId) return folderId;
        const parentId = await ensureParent();
        const children = await browser.bookmarks.getChildren(parentId);
        const existing = children.find((c) => !c.url && c.title === node.title);
        folderId = existing ? existing.id : (await browser.bookmarks.create({ parentId, title: node.title })).id;
        return folderId;
      };
      for (const kid of node.children ?? []) await walk(kid, ensureThis);
    };

    const roots = tree[0]?.children ?? tree;
    for (let r = 0; r < roots.length; r++) {
      const root = roots[r];
      if (!root) continue;
      const targetRootId = matchLocalRoot(root, localRoots, r) ?? otherId;
      for (const kid of root.children ?? []) await walk(kid, () => Promise.resolve(targetRootId));
    }
    logger.info("Snapshots", `Restored ${added} bookmark(s)`);
    return added;
  } finally {
    importing = false;
  }
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
  browser.bookmarks.onMoved.addListener((id, moveInfo) => {
    // Record the move (per URL, timestamped) so the new placement propagates.
    void recordMove(id);
    // Also record a folder's own reposition (path-keyed) — a reordered folder has
    // no URL, so recordMove alone can't carry its new index across devices.
    void recordFolderMove(id, moveInfo);
    onChange();
  });
  browser.bookmarks.onRemoved.addListener((_id, removeInfo) => {
    // Record a tombstone so the deletion propagates instead of resurrecting.
    void recordRemovedTombstones(removeInfo.node);
    onChange();
  });
  logger.info("BookmarkListeners", "Registered");
}

import type { SyncBookmark, Tombstone, BookmarkPayload, ConflictStrategy } from "@/lib/types";
import { logger } from "@/lib/utils/logger";
import { setBookmarkCache, getBookmarkCache, getTombstones, setTombstones } from "@/lib/utils/storage";

// ─── Read ─────────────────────────────────────────────────────────────────

export async function exportBookmarks(): Promise<SyncBookmark[]> {
  const tree = await chrome.bookmarks.getTree();
  return tree.map(mapNode);
}

function mapNode(node: chrome.bookmarks.BookmarkTreeNode): SyncBookmark {
  return {
    id: node.id,
    parentId: node.parentId ?? null,
    title: node.title,
    url: node.url,
    dateAdded: node.dateAdded ?? Date.now(),
    dateModified: node.dateGroupModified,
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

/** Record tombstones for every URL in a removed bookmark/folder subtree. */
async function recordRemovedTombstones(node: chrome.bookmarks.BookmarkTreeNode): Promise<void> {
  if (importing) return;
  const urls: string[] = [];
  const walk = (n: chrome.bookmarks.BookmarkTreeNode) => {
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

/** Bookmark sync payload: live tree + this device's (pruned) deletion log. */
export async function exportBookmarkPayload(): Promise<BookmarkPayload> {
  const [tree, tombstones] = await Promise.all([exportBookmarks(), getTombstones()]);
  const gced = gcTombstones(tombstones);
  await setTombstones(gced); // keep the stored log pruned
  return { tree, tombstones: gced };
}

/** Normalize a parsed bookmark payload (supports the legacy bare-array format). */
export function normalizePayload(payload: unknown): BookmarkPayload {
  if (Array.isArray(payload)) return { tree: payload as SyncBookmark[], tombstones: [] };
  const p = (payload ?? {}) as Partial<BookmarkPayload>;
  return { tree: p.tree ?? [], tombstones: p.tombstones ?? [] };
}

// ─── Write (import from remote) ──────────────────────────────────────────

export async function importBookmarks(
  payload: unknown,
  strategy: "merge" | "replace" = "merge",
  conflictStrategy: ConflictStrategy = "lww"
): Promise<void> {
  const { tree, tombstones: remoteTombstones } = normalizePayload(payload);
  importing = true;
  try {
    // Capture our own deletions before folding in the peer's, so the merge can
    // tell "I deleted this" from "they deleted this" (matters for prefer-*).
    const localTombstones = await getTombstones();
    await setTombstones(mergeTombstoneLists(localTombstones, remoteTombstones));

    if (strategy === "replace") {
      await clearAndImport(tree);
    } else {
      await mergeBookmarks(tree, localTombstones, remoteTombstones, conflictStrategy);
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

  // Get the local root folders (Bookmarks bar = "1", Other bookmarks = "2", Mobile = "3")
  const localTree = await chrome.bookmarks.getTree();
  const localRoots = localTree[0]?.children ?? [];

  // Clear all children from each local root folder
  for (const root of localRoots) {
    if (root.children) {
      for (const child of root.children) {
        try {
          await chrome.bookmarks.removeTree(child.id);
        } catch { /* system folders may be protected */ }
      }
    }
  }

  // Match remote roots to local roots by Chrome's stable IDs ("1"/"2"/"3"),
  // then by title, then by position — never by localized title alone.
  const localRootIds = new Set(localRoots.map((r) => r.id));
  const localRootByTitle = new Map(localRoots.map((r) => [r.title.toLowerCase(), r.id]));
  const localRootIdList = localRoots.map((r) => r.id);

  for (let i = 0; i < remoteRoots.length; i++) {
    const remoteRoot = remoteRoots[i];
    if (!remoteRoot) continue;

    const localRootId =
      (localRootIds.has(remoteRoot.id) ? remoteRoot.id : undefined) ??
      localRootByTitle.get(remoteRoot.title?.toLowerCase()) ??
      localRootIdList[i] ??
      localRootIdList[1]; // fallback to "Other bookmarks"

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
      await chrome.bookmarks.create({
        parentId,
        title: node.title,
        url: node.url,
      });
    } else {
      const folder = await chrome.bookmarks.create({
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
  strategy: ConflictStrategy,
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
  const remoteAdd = new Map<string, number>();
  for (const n of flattenNodes(remoteTree)) {
    if (n.url) remoteAdd.set(n.url, Math.max(remoteAdd.get(n.url) ?? 0, n.dateAdded ?? 0));
  }

  // ── Step A: apply the peer's deletions to local ──
  // prefer-local never deletes local; prefer-remote deletes unconditionally;
  // lww deletes only when the deletion is newer than the local add, so a fresh
  // re-add survives an older tombstone.
  const toRemove: string[] = [];
  if (strategy !== "prefer-local") {
    for (const [url, dAt] of remoteDel) {
      const loc = localByUrl.get(url);
      if (!loc) continue;
      if (strategy === "prefer-remote" || loc.dateAdded <= dAt) toRemove.push(...loc.ids);
    }
  }
  // Safety: refuse a mass-delete from a corrupt/oversized tombstone log.
  const cap = Math.max(20, Math.floor(localFlat.length * 0.5));
  if (toRemove.length > cap) {
    logger.warn("mergeBookmarks", `Skipped deleting ${toRemove.length} bookmarks (cap ${cap}) — tombstone data looks wrong`);
  } else {
    for (const id of toRemove) {
      try { await chrome.bookmarks.remove(id); } catch (err) { logger.error("Bookmark delete (tombstone)", err); }
    }
  }

  // ── Step B: additively merge the remote tree (folders preserved), skipping
  //    anything already local or that a deletion should suppress. ──
  const localUrlsNow = new Set(flattenUrls(await exportBookmarks()));
  const skipAdd = (url: string): boolean => {
    if (localUrlsNow.has(url)) return true;
    const lAt = localDel.get(url);
    const rAt = remoteDel.get(url);
    if (strategy === "prefer-local") return lAt !== undefined;   // honor only our deletions
    if (strategy === "prefer-remote") return rAt !== undefined;  // honor the peer's deletions
    const newestDel = Math.max(lAt ?? 0, rAt ?? 0);              // lww
    return newestDel > 0 && newestDel >= (remoteAdd.get(url) ?? 0);
  };

  const localRoots = (await chrome.bookmarks.getTree())[0]?.children ?? [];
  const localRootIds = new Set(localRoots.map((r) => r.id));
  const localRootByTitle = new Map(localRoots.map((r) => [r.title.toLowerCase(), r.id]));
  const otherId =
    localRoots.find((r) => r.id === "2")?.id ?? localRoots[1]?.id ?? localRoots[0]?.id;
  if (!otherId) {
    logger.warn("mergeBookmarks", "No writable root folder found");
    return;
  }

  let added = 0;
  const addedUrls = new Set<string>();
  const mergeNode = async (node: SyncBookmark, parentId: string): Promise<void> => {
    if (node.url) {
      if (skipAdd(node.url) || addedUrls.has(node.url)) return;
      try {
        await chrome.bookmarks.create({ parentId, title: node.title, url: node.url });
        addedUrls.add(node.url);
        added++;
      } catch (err) {
        logger.error(`Bookmark merge add: ${node.title}`, err);
      }
    } else {
      // Folder: reuse a same-title folder under parent if present, else create it.
      let folderId: string;
      try {
        const children = await chrome.bookmarks.getChildren(parentId);
        const existing = children.find((c) => !c.url && c.title === node.title);
        folderId = existing
          ? existing.id
          : (await chrome.bookmarks.create({ parentId, title: node.title })).id;
      } catch (err) {
        logger.error(`Bookmark merge folder: ${node.title}`, err);
        return;
      }
      for (const child of node.children ?? []) await mergeNode(child, folderId);
    }
  };

  const remoteRoots = remoteTree[0]?.children ?? remoteTree;
  for (const remoteRoot of remoteRoots) {
    if (!remoteRoot) continue;
    const targetRootId =
      (localRootIds.has(remoteRoot.id) ? remoteRoot.id : undefined) ??
      localRootByTitle.get(remoteRoot.title?.toLowerCase()) ??
      otherId;
    for (const child of remoteRoot.children ?? []) await mergeNode(child, targetRootId);
  }

  logger.info("mergeBookmarks", `Merged +${added} / -${toRemove.length} (folders preserved)`);
}

// ─── Diff ────────────────────────────────────────────────────────────────

export interface BookmarkDiff {
  added: SyncBookmark[];
  removed: SyncBookmark[];
  modified: SyncBookmark[];
}

export async function diffBookmarks(
  previous: SyncBookmark[]
): Promise<BookmarkDiff> {
  const current = await exportBookmarks();
  const currentFlat = flattenNodes(current);
  const previousFlat = flattenNodes(previous);

  const prevMap = new Map(previousFlat.map((n) => [n.id, n]));
  const currMap = new Map(currentFlat.map((n) => [n.id, n]));

  const added = currentFlat.filter((n) => !prevMap.has(n.id));
  const removed = previousFlat.filter((n) => !currMap.has(n.id));
  const modified = currentFlat.filter((n) => {
    const prev = prevMap.get(n.id);
    return prev && (prev.title !== n.title || prev.url !== n.url);
  });

  return { added, removed, modified };
}

// ─── Cache ───────────────────────────────────────────────────────────────

export async function updateBookmarkCache(): Promise<void> {
  const tree = await exportBookmarks();
  await setBookmarkCache(tree);
}

export async function getLastBookmarkSnapshot(): Promise<SyncBookmark[] | null> {
  return getBookmarkCache<SyncBookmark[]>();
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

function flattenUrls(nodes: SyncBookmark[]): string[] {
  return flattenNodes(nodes)
    .map((n) => n.url)
    .filter((u): u is string => !!u);
}

// ─── Listeners ───────────────────────────────────────────────────────────

export type BookmarkChangeCallback = () => void;

export function registerBookmarkListeners(onChange: BookmarkChangeCallback): void {
  chrome.bookmarks.onCreated.addListener(onChange);
  chrome.bookmarks.onChanged.addListener(onChange);
  chrome.bookmarks.onMoved.addListener(onChange);
  chrome.bookmarks.onRemoved.addListener((_id, removeInfo) => {
    // Record a tombstone so the deletion propagates instead of resurrecting.
    void recordRemovedTombstones(removeInfo.node);
    onChange();
  });
  logger.info("BookmarkListeners", "Registered");
}

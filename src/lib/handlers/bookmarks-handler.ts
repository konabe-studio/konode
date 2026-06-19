import type { SyncBookmark } from "@/lib/types";
import { logger } from "@/lib/utils/logger";
import { setBookmarkCache, getBookmarkCache } from "@/lib/utils/storage";

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

// ─── Write (import from remote) ──────────────────────────────────────────

export async function importBookmarks(
  remoteTree: SyncBookmark[],
  strategy: "merge" | "replace" = "merge"
): Promise<void> {
  if (strategy === "replace") {
    await clearAndImport(remoteTree);
  } else {
    await mergeBookmarks(remoteTree);
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

async function mergeBookmarks(remoteTree: SyncBookmark[]): Promise<void> {
  const localUrls = new Set(flattenUrls(await exportBookmarks()));

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

  // Recreate the remote folder hierarchy instead of dumping every bookmark flat
  // into "Other Bookmarks". URLs are de-duped against what's already local.
  const mergeNode = async (node: SyncBookmark, parentId: string): Promise<void> => {
    if (node.url) {
      if (localUrls.has(node.url)) return;
      try {
        await chrome.bookmarks.create({ parentId, title: node.title, url: node.url });
        localUrls.add(node.url);
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

  logger.info("mergeBookmarks", `Merged ${added} new bookmarks from remote (folders preserved)`);
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
  chrome.bookmarks.onRemoved.addListener(onChange);
  logger.info("BookmarkListeners", "Registered");
}

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

  // Build a map from remote root titles → local root IDs
  // e.g. "Bookmarks bar" → "1", "Other bookmarks" → "2"
  const localRootByTitle = new Map(localRoots.map((r) => [r.title.toLowerCase(), r.id]));

  // Also map by position as fallback (index 0 = bar, index 1 = other)
  const localRootIds = localRoots.map((r) => r.id);

  // The remote tree structure: tree[0] is the virtual root, tree[0].children are the real roots
  // We need to find the actual bookmark content roots
  const remoteRoots = tree[0]?.children ?? tree;

  for (let i = 0; i < remoteRoots.length; i++) {
    const remoteRoot = remoteRoots[i];
    if (!remoteRoot) continue;

    // Find matching local root by title or position
    const localRootId =
      localRootByTitle.get(remoteRoot.title.toLowerCase()) ??
      localRootIds[i] ??
      localRootIds[1]; // fallback to "Other bookmarks"

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
  const localTree = await exportBookmarks();
  const localUrls = new Set(flattenUrls(localTree));

  const toAdd = flattenNodes(remoteTree).filter(
    (n) => n.url && !localUrls.has(n.url)
  );

  // Add missing bookmarks to the "Other Bookmarks" folder
  const roots = (await chrome.bookmarks.getTree())[0]?.children ?? [];
  const other = roots.find((r) => r.id === "2") ?? roots[1]; // "2" = Other Bookmarks

  if (!other) {
    logger.warn("mergeBookmarks", "Could not find Other Bookmarks folder");
    return;
  }

  for (const node of toAdd) {
    try {
      await chrome.bookmarks.create({
        parentId: other.id,
        title: node.title,
        url: node.url,
      });
    } catch (err) {
      logger.error(`Bookmark merge add: ${node.title}`, err);
    }
  }

  logger.info("mergeBookmarks", `Added ${toAdd.length} new bookmarks from remote`);
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

import type {
  SyncBookmark, Tombstone, MoveRecord, FolderMoveRecord, TitleRecord, FolderRenameRecord,
  FolderDeleteRecord, AppearedRecord, KeptShellRecord, CreatedRecord, BookmarkPayload, ConflictStrategy,
  BookmarkExclusion,
} from "@/lib/types";
import { logger } from "@/lib/utils/logger";
import {
  setBookmarkCache, getBookmarkCache,
  getTombstones, setTombstones, updateTombstones,
  getMoves, setMoves, updateMoves,
  getFolderMoves, setFolderMoves, updateFolderMoves,
  getTitles, setTitles, updateTitles,
  getFolderRenames, setFolderRenames, updateFolderRenames,
  updateFolderDeletes,
  getAppeared, updateAppeared, getKeptShells, updateKeptShells,
  getCreated, updateCreated, getPeerRemovals, updatePeerRemovals, getBookmarkExclusions,
} from "@/lib/utils/storage";
import {
  asRootKind, defaultOtherRootId, findLocalRootByKind, matchLocalRoot, matchLocalRootEx,
  rootKindOf,
} from "@/lib/utils/bookmark-roots";
import { canonicalUrlKey } from "@/lib/utils/url";
import {
  excludedByOwnRule, excludedInSubtree, folderPathExcluded, mayHaveOwnRule, partitionExcluded, peerRules,
  rootKey, type Partition,
} from "@/lib/utils/bookmark-exclusions";
import { browser } from "@/lib/utils/ext";
import { assertDataTypeApi, eventPresent } from "@/lib/utils/capabilities";

// Chromium 134+ types its permanent folders on the node (`folderType`) and tells an
// account root from a local-only one (`syncing`); @types/chrome doesn't carry either yet.
// Both are optional, so a plain BookmarkTreeNode still satisfies this.
type BookmarkNode = chrome.bookmarks.BookmarkTreeNode & {
  folderType?: string;
  syncing?: boolean;
};

// ─── Read ─────────────────────────────────────────────────────────────────

/**
 * The tree as it syncs: everything except what this device keeps to itself (#54). Every
 * reader of the local tree in this file goes through here, so an excluded node is invisible
 * to the export, to the merge and to the deletion recorders alike, and none of them can
 * publish, move or delete it.
 */
export async function exportBookmarks(): Promise<SyncBookmark[]> {
  assertDataTypeApi("bookmarks");
  return (await localExclusions()).part.tree;
}

interface LocalExclusions {
  rules: BookmarkExclusion[];
  part: Partition<SyncBookmark>;
  /** The real roots, excluded nodes included. */
  roots: BookmarkNode[];
}

/** This device's tree, split into what syncs and what it keeps to itself (#54). */
async function localExclusions(rules?: BookmarkExclusion[]): Promise<LocalExclusions> {
  const [raw, stored] = await Promise.all([
    browser.bookmarks.getTree(),
    rules ? Promise.resolve(rules) : getBookmarkExclusions(),
  ]);
  return {
    rules: stored,
    part: partitionExcluded(raw.map((node) => mapNode(node, 0)), stored, { byId: true }),
    roots: raw[0]?.children ?? [],
  };
}

/**
 * A peer's tree without anything that would land in what this device keeps to itself (#54).
 *
 * A peer running the same extension has the same folder, and the merge, which matches
 * folders by title, would otherwise fill the excluded folder here with the peer's copy. The
 * peer's roots are named after the LOCAL roots they merge into, so the paths compare.
 */
function withoutExcluded(tree: SyncBookmark[], local: LocalExclusions): SyncBookmark[] {
  if (!local.rules.length) return tree;
  const other = defaultOtherRootId(local.roots);
  return partitionExcluded(tree, peerRules(local.rules, local.part), {
    byId: false,
    rootKeyOf: (root, i) => {
      const id = matchLocalRootEx(root, local.roots, i).id ?? other;
      const mapped = local.roots.find((r) => r.id === id);
      return mapped ? rootKey(mapped) : rootKey(root);
    },
  }).tree;
}

/** The folders a peer's path-keyed logs must leave alone (#54). */
function excludedFolderPaths(local: LocalExclusions): string[][] {
  return peerRules(local.rules, local.part).filter((r) => !r.url).map((r) => r.path);
}

// `depth` exists only to spot the ROOTS — the virtual root's own children — so each one
// can carry its kind to the peer. It is NOT an array index: this used to be called as
// `tree.map(mapNode)`, which would have handed the index to a second parameter.
function mapNode(node: BookmarkNode, depth: number): SyncBookmark {
  // A root travels with its resolved kind, so the receiver never has to re-derive it from
  // an id that only meant something on this profile. Edge 142 renumbered every bookmark id
  // (crbug 456225717), so the Favorites bar stopped being "1" and a peer had nothing left
  // to match on — the whole tree landed in "Other favorites" (#66).
  const kind = depth === 1 ? rootKindOf(node) : undefined;
  return {
    id: node.id,
    parentId: node.parentId ?? null,
    title: node.title,
    url: node.url,
    // Stable fallback (not Date.now()) so an unchanged tree exports to an identical
    // payload/checksum every time — the root node carries no dateAdded, and a moving
    // value there would defeat upload de-dup and cross-device checksum matching.
    dateAdded: node.dateAdded ?? 0,
    ...(kind ? { rootKind: kind } : {}),
    // NOTE: node.dateGroupModified is deliberately NOT synced — it's a per-folder
    // local mod-time that differs across devices for the same logical tree, so
    // including it only churned the payload/checksum. Nothing in the merge reads it.
    children: node.children?.map((child) => mapNode(child, depth + 1)),
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

/** Did this device record the deletion? See `Tombstone.own` — an unflagged record is
 *  a pre-1.3.2 one and counts as ours. */
export function isOwnTombstone(t: Tombstone): boolean {
  return t.own !== false;
}

/** Re-stamp a peer's log as NOT ours, so folding it in can never make this device a
 *  source of a deletion it did not make. */
export function asForeignTombstones(list: Tombstone[]): Tombstone[] {
  return list.map((t) => ({ url: t.url, deletedAt: t.deletedAt, own: false }));
}

export function gcTombstones(list: Tombstone[]): Tombstone[] {
  const cutoff = Date.now() - TOMBSTONE_TTL_MS;
  const byUrl = new Map<string, { deletedAt: number; own: boolean }>();
  for (const t of list) {
    if (t.deletedAt < cutoff) continue;
    const held = byUrl.get(t.url);
    // Newest time wins, and ownership is sticky: our own deletion of a URL a peer also
    // deleted stays ours, whichever copy carries the later timestamp.
    byUrl.set(t.url, {
      deletedAt: Math.max(held?.deletedAt ?? 0, t.deletedAt),
      own: (held?.own ?? false) || isOwnTombstone(t),
    });
  }
  return [...byUrl].map(([url, { deletedAt, own }]) => ({ url, deletedAt, own }));
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

/** A folder log's key: the path, and the bookmark that tells the folder from same-named
 *  siblings when it has any (see twinMark). Two of them in one parent are two folders. */
function markedKey(path: string[], holds: string | undefined): string {
  return holds ? `${folderPathKey(path)}\u0001${holds}` : folderPathKey(path);
}

function folderMoveKey(r: FolderMoveRecord): string {
  return markedKey(r.path, r.holds);
}

function folderRenameKey(r: FolderRenameRecord): string {
  return markedKey([...r.path, r.from], r.holds);
}

export function toFolderMoveMap(list: FolderMoveRecord[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of list) {
    const k = folderMoveKey(r);
    m.set(k, Math.max(m.get(k) ?? 0, r.at));
  }
  return m;
}

export function gcFolderMoves(list: FolderMoveRecord[]): FolderMoveRecord[] {
  const cutoff = Date.now() - TOMBSTONE_TTL_MS;
  const byPath = new Map<string, FolderMoveRecord>();
  for (const r of list) {
    if (r.at < cutoff) continue;
    const k = folderMoveKey(r);
    const existing = byPath.get(k);
    if (!existing || r.at > existing.at) byPath.set(k, r); // keep the newest per path
  }
  return [...byPath.values()];
}

export function mergeFolderMoveLists(a: FolderMoveRecord[], b: FolderMoveRecord[]): FolderMoveRecord[] {
  return gcFolderMoves([...a, ...b]);
}

// ─── Titles (rename log — same TTL/dedup shape as the move logs) ────────────
//
// The merge had three verbs — CREATE, MOVE, REMOVE — and no UPDATE, so once a peer's
// bookmark matched a local URL the merge considered it satisfied and never compared
// titles. Renaming a bookmark therefore reached every other device's packet and was
// discarded on arrival. These two logs supply the one thing that was missing: a
// timestamp, so there is a basis for deciding whose title is newer.

export function toTitleMap(list: TitleRecord[]): Map<string, TitleRecord> {
  const m = new Map<string, TitleRecord>();
  for (const r of list) {
    const k = canonicalUrlKey(r.url);
    const existing = m.get(k);
    if (!existing || r.at > existing.at) m.set(k, r);
  }
  return m;
}

export function gcTitles(list: TitleRecord[]): TitleRecord[] {
  const cutoff = Date.now() - TOMBSTONE_TTL_MS;
  return [...toTitleMap(list.filter((r) => r.at >= cutoff)).values()];
}

export function mergeTitleLists(a: TitleRecord[], b: TitleRecord[]): TitleRecord[] {
  return gcTitles([...a, ...b]);
}

// ─── Folder renames (path-keyed operation log) ──────────────────────────────

export function gcFolderRenames(list: FolderRenameRecord[]): FolderRenameRecord[] {
  const cutoff = Date.now() - TOMBSTONE_TTL_MS;
  // Keyed by parent path + the OLD name, so two renames of the same folder collapse to
  // the newest, while renaming two different folders in one parent both survive. Two that
  // shared the old name are told apart by the bookmark each record carries (#51).
  const byKey = new Map<string, FolderRenameRecord>();
  for (const r of list) {
    if (r.at < cutoff) continue;
    const k = folderRenameKey(r);
    const existing = byKey.get(k);
    if (!existing || r.at > existing.at) byKey.set(k, r);
  }
  return [...byKey.values()];
}

export function mergeFolderRenameLists(
  a: FolderRenameRecord[], b: FolderRenameRecord[]
): FolderRenameRecord[] {
  return gcFolderRenames([...a, ...b]);
}

// ─── Folder deletions (path-keyed, same TTL as the tombstones they accompany) ──

export function gcFolderDeletes(list: FolderDeleteRecord[]): FolderDeleteRecord[] {
  const cutoff = Date.now() - TOMBSTONE_TTL_MS;
  const byPath = new Map<string, FolderDeleteRecord>();
  for (const r of list) {
    if (r.at < cutoff) continue;
    const k = folderPathKey(r.path);
    const held = byPath.get(k);
    // Newest time wins and ownership is sticky, exactly as for tombstones.
    byPath.set(k, {
      path: r.path,
      at: Math.max(held?.at ?? 0, r.at),
      own: (held?.own ?? false) || r.own !== false,
    });
  }
  return [...byPath.values()];
}

export function mergeFolderDeleteLists(a: FolderDeleteRecord[], b: FolderDeleteRecord[]): FolderDeleteRecord[] {
  return gcFolderDeletes([...a, ...b]);
}

/** Is `path` the deleted folder itself, or somewhere inside it? */
function pathWithin(path: string[], deleted: string[]): boolean {
  return deleted.length <= path.length && deleted.every((segment, i) => segment === path[i]);
}

// ─── Appearances (when a bookmark really arrived here, see AppearedRecord) ──

// A bookmark the user creates is stamped "now", so its dateAdded already says when it
// appeared and there is nothing to record. One stamped more than this far in the past came
// from an import that kept its original date.
const APPEARED_SLACK_MS = 60_000;

export function gcAppeared(list: AppearedRecord[]): AppearedRecord[] {
  const cutoff = Date.now() - TOMBSTONE_TTL_MS;
  const byUrl = new Map<string, AppearedRecord>();
  for (const r of list) {
    if (r.at < cutoff) continue;
    const k = canonicalUrlKey(r.url);
    const held = byUrl.get(k);
    if (!held || r.at > held.at) byUrl.set(k, r);
  }
  return [...byUrl.values()];
}

/** canonical url → when it last appeared here. */
function toAppearedMap(list: AppearedRecord[]): Map<string, number> {
  return new Map(gcAppeared(list).map((r) => [canonicalUrlKey(r.url), r.at]));
}

/** The tree as peers should read it: a bookmark's `dateAdded` is no older than the moment
 *  it appeared on this device. That is the number a peer holding a deletion compares
 *  against before it takes the bookmark back. */
function withAppearance(tree: SyncBookmark[], appeared: Map<string, number>): SyncBookmark[] {
  if (!appeared.size) return tree;
  const walk = (n: SyncBookmark): SyncBookmark => {
    if (n.url) {
      const at = appeared.get(canonicalUrlKey(n.url));
      return at !== undefined && at > n.dateAdded ? { ...n, dateAdded: at } : n;
    }
    return n.children ? { ...n, children: n.children.map(walk) } : n;
  };
  return tree.map(walk);
}

// ─── Creations (what the browser kept of a merge's creates, see CreatedRecord) ──

// How long a create has to survive before a merge that finds it in place stops watching it.
// The merge right after is usually the next peer in the same sync, milliseconds later, and a
// browser that rewrites the URL on its own schedule may not have got to it yet.
const CREATED_CONFIRM_MS = 10 * 60 * 1000;

/** canonical peer url → the newest record for it. */
function toCreatedMap(list: CreatedRecord[]): Map<string, CreatedRecord> {
  const m = new Map<string, CreatedRecord>();
  for (const r of list) {
    const k = canonicalUrlKey(r.url);
    const held = m.get(k);
    if (!held || r.at > held.at) m.set(k, r);
  }
  return m;
}

/** URLs present anywhere in the CURRENT local tree (called after a mutation). */
async function localUrlSet(): Promise<Set<string>> {
  return new Set(flattenNodes(await exportBookmarks()).filter((n) => n.url).map((n) => n.url as string));
}

/**
 * A removed node together with everything that was inside it.
 *
 * Chromium hands onRemoved the whole subtree of a removed folder. Firefox hands it the
 * folder ALONE: no `children` on the node, and no event at all for anything inside it,
 * because it skips every `isDescendantRemoval` (browser/components/extensions/parent/
 * ext-bookmarks.js). So on Firefox a deleted folder recorded no deletion for its bookmarks,
 * and the next merge put them straight back from any peer that still had them, folder and
 * all: delete `Reading`, sync, and `Merged +10` brings it back.
 *
 * The last synced snapshot (konode_bm_cache) still holds the folder under the same id with
 * its contents, and it is exactly what the peers can hand back, so that is what gets
 * recorded. A bookmark added since that snapshot is not in it, but the fast-path sync
 * refreshes it about a second after any change, and a bookmark this device has not
 * published yet is not in a peer's file to come back from.
 */
async function withRemovedContents(node: BookmarkNode): Promise<BookmarkNode> {
  if (node.url || node.children) return node;
  const cache = await getBookmarkCache<SyncBookmark[]>();
  const cached = cache ? flattenNodes(cache).find((n) => n.id === node.id) : undefined;
  return (cached as BookmarkNode | undefined) ?? node;
}

/** Record tombstones for every URL in a removed bookmark/folder subtree — but only
 *  for URLs whose LAST local copy was just removed. Deleting one of several
 *  identical-URL bookmarks must NOT tombstone the URL: the tombstone is URL-keyed,
 *  so it would delete every copy on every peer (and the surviving local copy, being
 *  older than the tombstone, wouldn't re-propagate → the devices diverge). */
async function recordRemovedTombstones(node: BookmarkNode, skip?: Set<string>): Promise<void> {
  if (importing) return;
  const urls: string[] = [];
  // `skip`: what this device keeps to itself (#54). Deleting a synced folder that holds an
  // excluded one must not tell the peers to delete their copies of what was never theirs.
  const walk = (n: BookmarkNode) => {
    if (skip?.has(n.id)) return;
    if (n.url) urls.push(n.url);
    n.children?.forEach(walk);
  };
  walk(await withRemovedContents(node));
  if (!urls.length) return;
  const remaining = await localUrlSet();
  const gone = [...new Set(urls)].filter((url) => !remaining.has(url));
  if (!gone.length) return; // every removed URL still has another local copy
  const now = Date.now();
  // Serialized append: Chrome fires one onRemoved per removed node, so a multi-select
  // delete runs several of these at once. A get/set pair let them read the same list
  // and overwrite each other — only one deletion was recorded and the rest came back
  // from a peer on the next merge.
  await updateTombstones((current) =>
    mergeTombstoneLists(current, gone.map((url) => ({ url, deletedAt: now, own: true })))
  );
  logRecordedDeletions(gone.length);
}

/**
 * How long the Activity line for recorded deletions waits for the burst to end: the same
 * quiet second the fast-path sync waits for (BOOKMARK_DEBOUNCE_MS in the service worker).
 */
const DELETION_LOG_QUIET_MS = 1000;
let deletionsToLog = 0;
let deletionLogTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Say how many deletions were recorded, once per burst.
 *
 * The browser fires onRemoved once per node, so selecting 25 bookmarks and pressing Delete
 * wrote 25 identical `Recorded 1 deletion(s)` events in the same second, and a 200-bookmark
 * cleanup filled the whole 200-entry log with them, evicting everything a bug report would
 * need. The tombstones are still written per event, because each must be on disk before the
 * sync that publishes it. Only the line waits, and then gives the total.
 */
function logRecordedDeletions(n: number): void {
  deletionsToLog += n;
  if (deletionLogTimer) clearTimeout(deletionLogTimer);
  deletionLogTimer = setTimeout(() => {
    deletionLogTimer = null;
    const total = deletionsToLog;
    deletionsToLog = 0;
    logger.event("Tombstones", `Recorded ${total} deletion(s)`);
  }, DELETION_LOG_QUIET_MS);
}

/** Test seam: drop a burst still waiting for its line, so one test's cannot reach the next. */
export function resetDeletionLog(): void {
  if (deletionLogTimer) clearTimeout(deletionLogTimer);
  deletionLogTimer = null;
  deletionsToLog = 0;
}

/**
 * Record that a bookmark appeared here with an older date than now (#27).
 *
 * Restoring from the browser's own bookmark export brings bookmarks back with the date they
 * were first created, months before the deletion being undone, so the next merge read them
 * as older than the tombstone and deleted them again, for as long as the tombstone lived.
 */
async function recordAppeared(node: BookmarkNode): Promise<void> {
  if (importing || !node.url) return;
  const now = Date.now();
  if (now - (node.dateAdded ?? now) < APPEARED_SLACK_MS) return;
  const url = node.url;
  await updateAppeared((current) => gcAppeared([...current, { url, at: now }]));
}

/**
 * Record that a FOLDER was deleted, so a device that loses its bookmarks loses the folder
 * too (#26).
 *
 * The tombstones recorded alongside this say the bookmarks went. Nothing said the folder
 * did, so every receiver removed the bookmarks and kept the folder as an empty shell, and
 * since empty folders are never synced, nothing could ever clean one up. The path is built
 * from the PARENT: by the time this runs the folder itself is gone.
 */
async function recordRemovedFolder(parentId: string, node: BookmarkNode): Promise<void> {
  if (importing || node.url) return;
  const parentPath = await folderPath(parentId);
  if (!parentPath) return;
  const path = [...parentPath, node.title];
  // Deleting one of two same-named folders leaves a folder at this path, and publishing the
  // deletion would take the survivor from every peer whose copy of it ends up empty.
  const localRoots = (await browser.bookmarks.getTree())[0]?.children ?? [];
  if (await resolveFolderPath(path, localRoots)) return;
  const now = Date.now();
  await updateFolderDeletes((current) => mergeFolderDeleteLists(current, [{ path, at: now, own: true }]));
  logger.info("Tombstones", "Recorded a folder deletion");
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
  await updateTombstones((current) => mergeTombstoneLists(current, [{ url: oldUrl, deletedAt: now, own: true }]));
  logger.event("Tombstones", "Recorded a URL-change deletion");
}

/**
 * Record a rename so it can reach the other devices.
 *
 * A bookmark is keyed by its URL, which the rename doesn't change — a plain LWW record.
 * A folder has no such key, so the OLD title has to be captured here, from the last
 * synced snapshot (konode_bm_cache), which is exactly the state the peers still hold.
 * recordUrlChange already reads the cache this way for the same reason.
 */
async function recordTitleChange(id: string, newTitle: string | undefined): Promise<void> {
  if (importing || newTitle === undefined) return;
  let node: BookmarkNode | undefined;
  try { [node] = await browser.bookmarks.get(id); } catch { return; }
  if (!node) return;
  const now = Date.now();

  if (node.url) {
    await updateTitles((current) => mergeTitleLists(current, [{ url: node!.url!, title: newTitle, at: now }]));
    logger.info("Titles", "Recorded a bookmark rename");
    return;
  }

  // A folder. Its identity is its path, so we need what it was called BEFORE.
  const cache = await getBookmarkCache<SyncBookmark[]>();
  const oldTitle = cache ? flattenNodes(cache).find((n) => n.id === id)?.title : undefined;
  // An unnamed folder's old title is "", and that is a title (#51): testing it for truth
  // meant renaming an unnamed folder never reached the other devices.
  if (oldTitle === undefined || oldTitle === newTitle) return;
  if (!node.parentId) return;
  const parentPath = await folderPath(node.parentId);
  if (!parentPath) return;
  const holds = await twinMark(id, oldTitle, node.parentId, cache);
  await updateFolderRenames((current) =>
    mergeFolderRenameLists(current, [{ path: parentPath, from: oldTitle, to: newTitle, at: now, ...(holds ? { holds } : {}) }])
  );
  logger.info("Titles", "Recorded a folder rename");
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
  await updateMoves((current) => mergeMoveLists(current, urls.map((url) => ({ url, at: now }))));
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
/**
 * The profile's real roots, by id.
 *
 * Which nodes are roots is a question about the TREE, not about a node's id or title: on a
 * renumbered profile (Edge 142) a root's id matches no table, while a folder the user named
 * "Favorites bar" matches the title table perfectly — and typing that one as a root
 * truncates every path through it. The tree's own top level settles it, on every engine.
 */
async function localRootsById(): Promise<Map<string, BookmarkNode>> {
  const roots = (await browser.bookmarks.getTree())[0]?.children ?? [];
  return new Map(roots.map((r) => [r.id, r as BookmarkNode] as const));
}

async function folderPath(id: string): Promise<string[] | null> {
  const roots = await localRootsById();
  const path: string[] = [];
  let currentId: string | undefined = id;
  // Bound the walk so a malformed parent chain can't loop forever.
  for (let hops = 0; hops < 64 && currentId; hops++) {
    const root = roots.get(currentId);
    if (root) {
      // Reached a root. Its kind comes from the engine's folderType where there is one,
      // so it survives renumbering; an unmappable root fails safe, as before.
      const kind = rootKindOf(root);
      return kind ? [kind, ...path] : null;
    }
    let node: BookmarkNode | undefined;
    try { [node] = await browser.bookmarks.get(currentId); } catch { return null; }
    if (!node) return null;
    path.unshift(node.title);
    currentId = node.parentId;
  }
  return null;
}

/** Every bookmark under `nodes`, by canonical url. */
function urlKeysIn(nodes: SyncBookmark[]): Set<string> {
  return new Set(flattenNodes(nodes).filter((n) => n.url).map((n) => canonicalUrlKey(n.url as string)));
}

/**
 * A bookmark that tells folder `id` apart from its same-named siblings, for the path-keyed
 * folder logs (#51), or undefined when no sibling under `parentId` is called `title`.
 *
 * A rename or a reposition is filed under the folder's path, and with several folders of one
 * name in a parent that path names all of them: the receiver took the first, so renaming the
 * second unnamed folder renamed the first one everywhere else. A record for such a folder
 * carries one of its bookmarks, and the receiver acts on the folder that holds it.
 *
 * Taken from the last synced snapshot, which is what the peers hold, and only among what the
 * folder still holds, since the receiver has to find it in there. The smallest, so that two
 * devices renaming the same folder mark it alike and the newer rename wins as for any folder.
 */
async function twinMark(
  id: string, title: string, parentId: string, cache?: SyncBookmark[] | null,
): Promise<string | undefined> {
  try {
    const siblings = await browser.bookmarks.getChildren(parentId);
    if (!siblings.some((s) => !s.url && s.id !== id && s.title === title)) return undefined;
    const synced = flattenNodes((cache ?? await getBookmarkCache<SyncBookmark[]>()) ?? []).find((n) => n.id === id);
    if (!synced) return undefined;
    const now = urlKeysIn((await browser.bookmarks.getSubTree(id)).map(mapNode));
    return [...urlKeysIn([synced])].filter((k) => now.has(k)).sort()[0];
  } catch {
    return undefined;
  }
}

/**
 * Which of `candidates` a folder record marked with a bookmark means (see twinMark): the one
 * holding it, under any of `keys`. None when only another of `folders` holds it, which is the
 * same folder under a name it has since been given here, so the record has been applied. And
 * none when no folder holds it and there is more than one candidate: nothing says which.
 */
async function markedFolder(
  folders: BookmarkNode[], candidates: BookmarkNode[], keys: string[],
): Promise<BookmarkNode | undefined> {
  const holds = async (f: BookmarkNode): Promise<boolean> => {
    const held = urlKeysIn((await browser.bookmarks.getSubTree(f.id)).map(mapNode));
    return keys.some((k) => held.has(k));
  };
  for (const c of candidates) if (await holds(c)) return c;
  for (const f of folders) if (!candidates.includes(f) && await holds(f)) return undefined;
  return candidates.length === 1 ? candidates[0] : undefined;
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
  const holds = await twinMark(id, node.title, moveInfo.parentId);
  const now = Date.now();
  await updateFolderMoves((current) =>
    mergeFolderMoveLists(current, [{ path, index: moveInfo.index, at: now, prev, next, ...(holds ? { holds } : {}) }])
  );
  logger.info("Moves", "Recorded a folder reposition");
}

/** Bookmark sync payload: live tree + this device's (pruned) deletion log. */
export async function exportBookmarkPayload(): Promise<BookmarkPayload> {
  // GC each log through the SAME serialized path the listeners append on. A bookmark
  // event landing mid-export would otherwise read the pre-GC list and write it back —
  // either undoing the prune or dropping the event's own record, depending on which
  // write happened to land last. Nothing here is exempt from the burst just because it
  // runs inside a sync: `importing` only suppresses the recorders during an IMPORT.
  const [tree, gced, gcedMoves, gcedFolderMoves, gcedTitles, gcedRenames, gcedFolderDeletes, gcedAppeared, createdRecords] = await Promise.all([
    exportBookmarks(),
    updateTombstones(gcTombstones),
    updateMoves(gcMoves),
    updateFolderMoves(gcFolderMoves),
    updateTitles(gcTitles),
    updateFolderRenames(gcFolderRenames),
    updateFolderDeletes(gcFolderDeletes),
    updateAppeared(gcAppeared),
    getCreated(),
  ]);
  // Snapshot the current (full) tree so a later URL edit can find the replaced
  // url by id and tombstone it (see recordUrlChange). This is the state peers hold.
  await setBookmarkCache(tree);
  // A bookmark this browser keeps under another URL than a peer gave it goes out under the
  // peer's URL (#41). Published as kept, `neo://newtab/` reached the Chrome peer as a
  // bookmark of its own, a dead link there, and since that peer's tree then listed the kept
  // form, deleting `chrome://newtab/` on it no longer took the copy here.
  const forms = peerForms(createdRecords);
  const asPeer = <T extends { url: string }>(r: T): T => {
    const url = forms.get(canonicalUrlKey(r.url));
    return url ? { ...r, url } : r;
  };
  const asPeerMark = <T extends { holds?: string }>(r: T): T => {
    const url = r.holds ? forms.get(r.holds) : undefined;
    return url ? { ...r, holds: canonicalUrlKey(url) } : r;
  };
  // Don't sync empty folders — a folder carries no tombstone, so leaving empty
  // folders in the payload is what made a deleted folder resurrect from a peer.
  return {
    tree: inPeerForm(withAppearance(pruneEmptyFolders(tree), toAppearedMap(gcedAppeared)), forms),
    tombstones: publishableTombstones(gced, tree, forms), moves: gcedMoves.map(asPeer),
    folderMoves: gcedFolderMoves.map(asPeerMark), titles: gcedTitles.map(asPeer), folderRenames: gcedRenames.map(asPeerMark),
    folderDeletes: publishableFolderDeletes(gcedFolderDeletes, tree),
  };
}

/** canonical kept url → the URL the peer gave us, for every bookmark this browser keeps under
 *  another URL (#41). Two peer URLs kept as one (`chrome://newtab` and `chrome://newtab/`)
 *  go out as the newer. */
function peerForms(records: CreatedRecord[]): Map<string, string> {
  const byKept = new Map<string, CreatedRecord>();
  for (const r of records) {
    if (typeof r.kept !== "string") continue;
    const k = canonicalUrlKey(r.kept);
    if (k === canonicalUrlKey(r.url)) continue;
    const held = byKept.get(k);
    if (!held || r.at > held.at) byKept.set(k, r);
  }
  return new Map([...byKept].map(([k, r]) => [k, r.url]));
}

/** The tree with every kept URL replaced by the one the peer gave us (see peerForms). */
function inPeerForm(tree: SyncBookmark[], forms: Map<string, string>): SyncBookmark[] {
  if (!forms.size) return tree;
  const walk = (n: SyncBookmark): SyncBookmark => {
    if (n.url) {
      const url = forms.get(canonicalUrlKey(n.url));
      return url ? { ...n, url } : n;
    }
    return n.children ? { ...n, children: n.children.map(walk) } : n;
  };
  return tree.map(walk);
}

/**
 * The folder deletions this device may ask of the others, by the same two rules as
 * `publishableTombstones`: only our own, and never a folder our tree still has, because a
 * folder the user has since recreated was not deleted as far as anyone else should hear.
 */
function publishableFolderDeletes(records: FolderDeleteRecord[], tree: SyncBookmark[]): FolderDeleteRecord[] {
  const held = new Set<string>();
  const walk = (nodes: SyncBookmark[], path: string[]): void => {
    for (const n of nodes) {
      if (n.url) continue;
      const here = [...path, n.title];
      held.add(folderPathKey(here));
      walk(n.children ?? [], here);
    }
  };
  for (const root of tree[0]?.children ?? []) {
    const kind = rootKindOf(root);
    if (kind) walk(root.children ?? [], [kind]);
  }
  return records
    .filter((r) => r.own !== false && !held.has(folderPathKey(r.path)))
    .map((r) => ({ path: r.path, at: r.at }));
}

/**
 * Which deletions this device is entitled to ask of the others.
 *
 * Two rules, and the second one is what a device already carrying a poisoned log needs.
 *
 * 1. Only deletions WE made. A merge folds every peer's log into ours so a stale peer
 *    can't resurrect what someone deleted; that belongs in local storage, not in our
 *    file. Every device reads every peer's file directly, so a relay was never needed
 *    for a deletion to arrive — all it added was a second device saying the same thing.
 *
 * 2. Never a URL we still hold. A packet that advertises a bookmark and asks for its
 *    deletion in the same breath is self-contradictory, and the receiver believed the
 *    deletion. This is the rule that catches the pre-1.3.2 records, which carry no
 *    provenance and are otherwise indistinguishable from our own (#31).
 *
 * The stored log keeps everything either way: it is what suppresses a re-add from a peer
 * that hasn't caught up yet, and that is a question about OUR tree, not about theirs.
 *
 * A bookmark this browser keeps under another URL (#41, see peerForms) is held, and deleted,
 * under both: the peers know it by the URL they gave us, and one may still carry the kept
 * form from before the tree was published in theirs.
 */
function publishableTombstones(
  tombstones: Tombstone[], tree: SyncBookmark[], forms: Map<string, string> = new Map(),
): Tombstone[] {
  const held = new Set<string>();
  for (const n of flattenNodes(tree)) {
    if (!n.url) continue;
    const key = canonicalUrlKey(n.url);
    held.add(key);
    const peer = forms.get(key);
    if (peer) held.add(canonicalUrlKey(peer));
  }
  const out: Tombstone[] = [];
  for (const t of tombstones) {
    if (!isOwnTombstone(t)) continue;
    const key = canonicalUrlKey(t.url);
    const peer = forms.get(key);
    for (const url of peer ? [t.url, peer] : [t.url]) {
      // `own` is local bookkeeping. Sending it would let a peer read our provenance as
      // theirs when they fold the list in, which is precisely the confusion it exists to end.
      if (!held.has(canonicalUrlKey(url))) out.push({ url, deletedAt: t.deletedAt });
    }
  }
  return out;
}

/** Normalize a parsed bookmark payload (supports the legacy bare-array format). */
export function normalizePayload(payload: unknown): BookmarkPayload {
  const empty = { tombstones: [], moves: [], folderMoves: [], titles: [], folderRenames: [], folderDeletes: [] };
  if (Array.isArray(payload)) return { tree: payload as SyncBookmark[], ...empty };
  const p = (payload ?? {}) as Partial<BookmarkPayload>;
  // Every log is optional: a peer on an older build sends none of them, and must
  // keep working rather than being read as "everything was deleted/renamed".
  return {
    tree: p.tree ?? [], tombstones: p.tombstones ?? [], moves: p.moves ?? [],
    folderMoves: p.folderMoves ?? [], titles: p.titles ?? [], folderRenames: p.folderRenames ?? [],
    folderDeletes: p.folderDeletes ?? [],
  };
}

/**
 * What a bookmark payload HOLDS, as a string two devices agree on when their bookmarks do
 * (#34): one line per bookmark, its folder path, canonical URL and title, sorted.
 *
 * Manual conflict resolution compared the transport checksum, and for bookmarks that covers
 * much more than the bookmarks: this device's ids, every `dateAdded` (a bookmark that arrives
 * from a peer is stamped with the moment it arrived, since `bookmarks.create` takes no date),
 * and the deletion, move and rename logs, which are per device by definition. So two
 * devices never matched, even with the same tree on screen, and Manual asked about every
 * pair on first contact, and again whenever a peer's payload moved for any reason at all.
 *
 * Left out on purpose, besides those: sibling ORDER, which the merge does not converge
 * across browsers (TODO, "content converges, order does not"), so counting it would ask
 * forever about something neither answer fixes; and duplicates, for the same reason, since
 * the merge keys presence by URL. Roots are matched by KIND, as matchLocalRootEx matches
 * them, so a Chrome "Bookmarks bar" and a Firefox toolbar under any localized title are one
 * place, and Firefox's Bookmarks Menu, which merges into Other bookmarks on a browser that
 * has no menu, counts as Other bookmarks here too.
 *
 * Compare what devices PUBLISH (exportBookmarkPayload), not the raw local tree: a browser
 * that keeps a bookmark under another URL (#41) publishes it in the peer's form.
 *
 * It is not a replacement for the transport checksum, which `uploadIfChanged` and the E2EE
 * dedup need over the exact bytes. It answers a different question.
 */
export function bookmarkContent(payload: unknown): string {
  const { tree } = normalizePayload(payload);
  // tree[0] is the virtual root and its children the real roots; a bare list of roots too.
  const roots = tree[0]?.children ?? tree;
  const lines = new Set<string>();
  roots.forEach((root, i) => {
    // Through rootKindOf, or two devices never agree on this hash: an Edge whose roots
    // were renumbered answered to no kind and keyed its lines "root:favorites bar" while
    // the same tree on Chrome keyed them "bar".
    const kind = rootKindOf(root);
    const top = kind === "menu" ? "other" : kind ?? `root:${root.title?.trim().toLowerCase() || i}`;
    const walk = (nodes: SyncBookmark[] | undefined, path: string[]): void => {
      for (const n of nodes ?? []) {
        if (n.url) lines.add([...path, canonicalUrlKey(n.url), n.title ?? ""].join("\u0000"));
        else walk(n.children, [...path, n.title ?? ""]);
      }
    };
    walk(root.children, [top]);
  });
  return [...lines].sort().join("\n");
}

// ─── Write (import from remote) ──────────────────────────────────────────

/**
 * What the mass-delete guard refused, and the arithmetic behind it.
 *
 * The count alone was not enough to act on: the popup could say "48 bookmarks" but not
 * what it was 48 *of*, and the user has to know that before deciding whether to wave it
 * through. Carrying the cap and the local total means the notice can say "48 of your 49",
 * and it saves the sync engine recomputing numbers the merge already had in hand.
 */
export interface BulkDeleteBlock {
  /** Local bookmarks the guard refused to remove this merge, each URL once. */
  blocked: number;
  /** The ceiling it exceeded, counted against the tree as it stood before `recent`. */
  cap: number;
  /** Bookmarks present locally when the merge ran, each URL once. */
  localTotal: number;
  /** The configured percentage the cap came from. */
  pct: number;
  /** What other devices' deletions already removed here within the window, which counts
   *  toward the cap together with `blocked` (#41). */
  recent: number;
}

/**
 * How far back the mass-delete guard adds up what peers removed here (#41).
 *
 * A day, because the gap it closes is a deletion arriving in pieces: every piece sails under
 * the cap on its own, whether the pieces are one device cleaning up folder by folder, several
 * devices each asking for part of the tree, or something going wrong a sync at a time. Long
 * enough to see those as one deletion, short enough that ordinary tidying on another device
 * over the weeks never adds up to a false alarm.
 */
const PEER_REMOVAL_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function importBookmarks(
  payload: unknown,
  strategy: "merge" | "replace" = "merge",
  conflictStrategy: ConflictStrategy = "lww",
  deletePercent = 60,
  // The user's approval for a blocked deletion, in bookmarks, or 0 for none. Passed in
  // rather than read from storage here, because its LIFETIME is a property of the sync,
  // not of one merge: the engine reads it once per sync and clears it as it reads. See
  // the note on `bulkApprovedThisSync` in sync-engine.ts for why that matters.
  approvedFor = 0,
  // Called when the mass-delete guard blocks a peer's deletions (recovery signal).
  onBulkBlocked?: (info: BulkDeleteBlock) => void
): Promise<void> {
  assertDataTypeApi("bookmarks");
  const normalized = normalizePayload(payload);
  const { tombstones: remoteTombstones, moves: remoteMoves = [], titles: remoteTitles = [] } = normalized;
  let {
    tree, folderMoves: remoteFolderMoves = [], folderRenames: remoteFolderRenames = [],
    folderDeletes: remoteFolderDeletes = [],
  } = normalized;
  // What this device keeps to itself (#54) is taken out of the peer's packet before anything
  // reads it: its copy of an excluded folder, and every folder operation that would reach one.
  // URL-keyed logs need nothing: the merge never sees an excluded bookmark to act on.
  // Read the tree only when something is excluded: most devices exclude nothing, and the
  // merge reads it again anyway.
  const rules = await getBookmarkExclusions();
  const local = rules.length ? await localExclusions(rules) : null;
  if (local) {
    tree = withoutExcluded(tree, local);
    const folders = excludedFolderPaths(local);
    const out = (path: string[]) => folderPathExcluded(path, folders);
    remoteFolderMoves = remoteFolderMoves.filter((r) => !out(r.path));
    remoteFolderRenames = remoteFolderRenames.filter((r) => !out([...r.path, r.from]) && !out([...r.path, r.to]));
    remoteFolderDeletes = remoteFolderDeletes.filter((r) => !out(r.path));
  }
  importing = true;
  try {
    // Capture our own deletions/moves before folding in the peer's, so the merge
    // can compare "mine vs theirs" (matters for prefer-* and move LWW). Then
    // persist the merged logs so this device propagates them onward.
    const logs: MergeLogs = {
      tombstones: { local: await getTombstones(), remote: remoteTombstones },
      moves: { local: await getMoves(), remote: remoteMoves },
      folderMoves: { local: await getFolderMoves(), remote: remoteFolderMoves },
      titles: { local: await getTitles(), remote: remoteTitles },
      folderRenames: { local: await getFolderRenames(), remote: remoteFolderRenames },
      folderDeletes: { remote: remoteFolderDeletes },
    };
    // Folded in as the PEER's, never as ours. Keeping them is what stops a stale peer
    // resurrecting a bookmark someone else deleted; claiming them is what turned a single
    // refused deletion into every device demanding it of every other one (#31).
    await setTombstones(
      mergeTombstoneLists(logs.tombstones.local, asForeignTombstones(logs.tombstones.remote))
    );
    await setMoves(mergeMoveLists(logs.moves.local, logs.moves.remote));
    await setFolderMoves(mergeFolderMoveLists(logs.folderMoves.local, logs.folderMoves.remote));
    await setTitles(mergeTitleLists(logs.titles.local, logs.titles.remote));
    await setFolderRenames(mergeFolderRenameLists(logs.folderRenames.local, logs.folderRenames.remote));

    if (strategy === "replace") {
      await clearAndImport(tree, local?.part.excludedIds);
    } else {
      await mergeBookmarks(tree, logs, conflictStrategy, deletePercent, approvedFor, onBulkBlocked, local?.part.excludedIds);
    }
  } finally {
    importing = false;
  }
}

async function clearAndImport(tree: SyncBookmark[], excluded: Set<string> = new Set()): Promise<void> {
  // The remote tree: tree[0] is the virtual root, tree[0].children are the real roots.
  const remoteRoots = tree[0]?.children ?? tree;

  // Guard: never wipe local bookmarks for an empty or malformed remote payload
  // (a corrupt/tampered file or a transient empty read must not destroy data).
  const hasRemoteContent = remoteRoots.some((r) => (r?.children?.length ?? 0) > 0);
  if (!hasRemoteContent) {
    logger.warn("clearAndImport", "Remote bookmark tree is empty/invalid, skipping destructive replace");
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

  // Clear all children from each local root folder, except what this device keeps to itself
  // (#54) and the folders on the way to it, which stay standing for the restore to fill.
  const holdsExcluded = (n: BookmarkNode): boolean =>
    excluded.size > 0 && (n.children ?? []).some((c) => excluded.has(c.id) || holdsExcluded(c));
  const kept = new Set<string>();
  const clear = async (nodes: BookmarkNode[]): Promise<void> => {
    for (const child of nodes) {
      if (excluded.has(child.id)) continue;
      if (!child.url && holdsExcluded(child)) {
        kept.add(child.id);
        await clear(child.children ?? []);
        continue;
      }
      try {
        await browser.bookmarks.removeTree(child.id);
      } catch { /* system folders may be protected */ }
    }
  };
  for (const root of localRoots) {
    if (root.children) await clear(root.children);
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
      await restoreNode(child, localRootId, kept);
    }
  }

  logger.event("clearAndImport", "Bookmark structure restored from remote");
}

async function restoreNode(
  node: SyncBookmark,
  parentId: string,
  // Folders the clear left standing because something excluded is inside (#54). The restore
  // fills them rather than making a second folder of the same name beside each.
  kept: Set<string> = new Set(),
): Promise<void> {
  try {
    if (node.url) {
      await browser.bookmarks.create({
        parentId,
        title: node.title,
        url: node.url,
      });
    } else {
      const standing = kept.size
        ? (await browser.bookmarks.getChildren(parentId)).find((c) => !c.url && c.title === node.title && kept.has(c.id))
        : undefined;
      const folder = standing ?? await browser.bookmarks.create({
        parentId,
        title: node.title,
      });
      for (const child of node.children ?? []) {
        await restoreNode(child, folder.id, kept);
      }
    }
  } catch (err) {
    logger.error(`Bookmark restore: ${node.title}`, err);
  }
}

/**
 * Every change log the merge compares, as ONE named parameter.
 *
 * These used to be six positional arguments in local/remote pairs, so adding a log meant
 * threading two more parameters through in exactly the right order — and getting the
 * order wrong would type-check perfectly while silently comparing the wrong sides. The
 * next log is now a single field.
 */
interface MergeLogs {
  tombstones: { local: Tombstone[]; remote: Tombstone[] };
  moves: { local: MoveRecord[]; remote: MoveRecord[] };
  folderMoves: { local: FolderMoveRecord[]; remote: FolderMoveRecord[] };
  titles: { local: TitleRecord[]; remote: TitleRecord[] };
  folderRenames: { local: FolderRenameRecord[]; remote: FolderRenameRecord[] };
  // No `local` side: the only question these answer is whether the peer whose tombstones
  // just emptied a folder meant the folder to go too, and that is in the peer's packet.
  folderDeletes: { remote: FolderDeleteRecord[] };
}

async function mergeBookmarks(
  remoteTree: SyncBookmark[],
  logs: MergeLogs,
  strategy: ConflictStrategy,
  deletePercent = 60,
  approvedFor = 0,
  onBulkBlocked?: (info: BulkDeleteBlock) => void,
  // What this device keeps to itself (#54). The peer's tree has been pruned of it already;
  // this is the backstop for the folder lookups below, which match by title alone and must
  // never hand back an excluded folder to write into.
  excluded: Set<string> = new Set(),
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

  // The profile's roots, read once. Step A needs to know which ids are roots — never a
  // shell to prune — and the root matching further down needs the roots themselves.
  // "Is this a root?" is a question about the TREE: on a renumbered profile (Edge 142,
  // crbug 456225717) a root's id matches no table, and a folder the user named "Favorites
  // bar" matches the title table, so neither id nor title can answer it.
  const localRoots = (await browser.bookmarks.getTree())[0]?.children ?? [];
  const localRootIds = new Set(localRoots.map((r) => r.id));

  // Index local URL bookmarks (ids + when each canonical URL last appeared here). That is
  // the newest dateAdded, or later if an import kept an older date than the moment the
  // bookmark actually arrived (#27): a restore from a browser backup is the user's newest
  // intent however old the dates it brings back.
  const localFlat = flattenNodes(await exportBookmarks()).filter((n) => n.url);
  const appeared = toAppearedMap(await getAppeared());
  const localByUrl = new Map<string, { ids: string[]; dateAdded: number }>();
  for (const n of localFlat) {
    if (!n.url) continue;
    const key = canonicalUrlKey(n.url);
    const e = localByUrl.get(key) ?? { ids: [], dateAdded: appeared.get(key) ?? 0 };
    e.ids.push(n.id);
    e.dateAdded = Math.max(e.dateAdded, n.dateAdded ?? 0);
    localByUrl.set(key, e);
  }

  const localDel = canonMap(toDeletedMap(logs.tombstones.local));
  const remoteDel = canonMap(toDeletedMap(logs.tombstones.remote));
  const localMoveAt = canonMap(toMoveMap(logs.moves.local));
  const remoteMoveAt = canonMap(toMoveMap(logs.moves.remote));
  const localTitleAt = toTitleMap(logs.titles.local);
  const remoteTitleAt = toTitleMap(logs.titles.remote);
  const remoteAdd = new Map<string, number>();
  for (const n of flattenNodes(remoteTree)) {
    if (n.url) remoteAdd.set(canonicalUrlKey(n.url), Math.max(remoteAdd.get(canonicalUrlKey(n.url)) ?? 0, n.dateAdded ?? 0));
  }

  // What earlier merges created here and what the browser kept of it (#41). A browser that
  // stores a different URL than it was handed (Norton Neo: `chrome://newtab/` becomes
  // `neo://newtab/`) holds the peer's bookmark under a key the peer never sends, so every
  // lookup below that asks "do we have this" has to ask under both.
  const mergeStart = Date.now();
  const created = toCreatedMap(await getCreated());
  let createdDirty = false;
  /** The key of the copy this browser keeps in place of the peer's `key`, if it differs. */
  const keptKey = (key: string): string | undefined => {
    const kept = created.get(key)?.kept;
    const k = typeof kept === "string" ? canonicalUrlKey(kept) : undefined;
    return k !== key ? k : undefined;
  };
  /** Every key this device may hold the peer's `key` under. */
  const localKeys = (key: string): string[] => {
    const kept = keptKey(key);
    return kept ? [key, kept] : [key];
  };
  /** The other way round: the peer keys this browser keeps under a kept `key`. */
  const peerKeysOf = new Map<string, string[]>();
  for (const key of created.keys()) {
    const kept = keptKey(key);
    if (kept) peerKeysOf.set(kept, [...(peerKeysOf.get(kept) ?? []), key]);
  }
  /** The newest time any of `keys` has in `m`, or undefined when none has one. */
  const newest = (m: Map<string, number>, keys: string[]): number | undefined => {
    let at: number | undefined;
    for (const k of keys) {
      const v = m.get(k);
      if (v !== undefined) at = Math.max(at ?? 0, v);
    }
    return at;
  };
  /** Has anyone, here or on the peer, deleted `key` at or after `at`? */
  const deletedSince = (key: string, at: number): boolean =>
    Math.max(localDel.get(key) ?? 0, remoteDel.get(key) ?? 0) >= at;

  // ── Step A: apply the peer's deletions to local ──
  // prefer-local never deletes local. prefer-remote and lww both honor a peer
  // deletion, but never destroy a local add that is STRICTLY NEWER than the
  // tombstone — a fresh re-add always survives an older deletion (a re-add is the
  // user's newer intent). prefer-remote still differs from lww on the add/move
  // side (it adopts the peer's placement); only the delete side is guarded here.
  const toRemove: string[] = [];
  // Which local URL each queued id belongs to. The guard counts URLs, not ids: a bookmark
  // held here in 3,000 copies (#41, Norton Neo) is one bookmark to delete, not 3,000.
  const keyOfId = new Map<string, string>();
  if (strategy !== "prefer-local") {
    // Two tombstones can reach one local copy now (the peer's form and the kept form), and
    // removing an id twice would throw and count it twice against the guard.
    const queued = new Set<string>();
    for (const [url, dAt] of remoteDel) {
      // Our copy may be the one the browser keeps under another URL (#41).
      const kept = keptKey(url);
      const loc = localByUrl.get(url) ?? (kept ? localByUrl.get(kept) : undefined);
      if (!loc) continue;
      // The peer is asking us to delete something its own tree still advertises. Whatever
      // that is, it is not a deletion: either they re-added it, or they are relaying a log
      // they picked up from someone else (which is what every pre-1.3.2 device does). We
      // can see the contradiction in the packet in front of us, so we don't need them to
      // be fixed first — this is the half of #31 that protects a device on its own.
      if (remoteAdd.has(url)) continue;
      // The same contradiction in the kept form: a peer still listing that copy has not
      // deleted the bookmark.
      if (kept && !localByUrl.has(url) && remoteAdd.has(kept)) continue;
      // And its mirror image: the peer deleted its copy of the kept form while its tree still
      // lists the URL it gave us. That copy reached it from here before the tree went out in
      // the peer's form, a dead link over there, and the bookmark itself is still on the peer.
      if ((peerKeysOf.get(url) ?? []).some((k) => remoteAdd.has(k))) continue;
      if (loc.dateAdded <= dAt) {
        const key = localByUrl.has(url) ? url : (kept as string);
        for (const id of loc.ids) {
          if (!queued.has(id)) { queued.add(id); toRemove.push(id); keyOfId.set(id, key); }
        }
      }
    }
  }
  // Safety: refuse a mass-delete from a corrupt/oversized tombstone log. The
  // threshold is user-configurable (Settings → Device → Safety, default 60%): a floor
  // of 20 keeps small trees from tripping it, and a normal bulk cleanup up to the
  // percentage still propagates.
  //
  // The percentage alone cannot answer every case, which is why the approval exists:
  // the slider stops at 95%, so a peer clearing nearly its whole tree was blocked at
  // every setting and the warning never cleared (#18).
  //
  // `approvedFor` is a plain argument, and this function neither reads nor clears the
  // stored latch. It used to do both, gated on being over the cap to save a storage read
  // — and that gate was the bug. A merge that never went over the cap never cleared the
  // latch, so an approval armed for a sync that then failed to reach an over-cap merge
  // (the backend was down, or the peer had restored its bookmarks in the meantime) stayed
  // armed indefinitely, and cashed out silently against an unrelated deletion weeks later,
  // with no restore point and nothing in the log. The lifetime belongs to the sync, which
  // is the only scope that can say when the approval has had its chance.
  //
  // Two gaps, found looking for how #41's Chrome emptied with the guard on. It counted
  // bookmark NODES, so a pile of duplicates inflated the tree it measured against: a device
  // holding 3,000 copies of one New Tab bookmark could lose every other bookmark and stay
  // under 60%. It now counts each URL once, on both sides of the comparison. And it judged
  // each merge alone, so a deletion that arrived in pieces passed piece by piece. It now
  // adds what peers removed here within PEER_REMOVAL_WINDOW_MS, and measures the total
  // against the tree as it stood before those removals. A URL that is back (a restore, a
  // re-add) no longer counts as gone.
  const pct = deletePercent > 0 ? deletePercent : 60;
  const asked = new Set(keyOfId.values()).size;
  const windowStart = mergeStart - PEER_REMOVAL_WINDOW_MS;
  const removals = await getPeerRemovals();
  const recentGone = new Set<string>();
  for (const r of removals) if (r.at > windowStart && !localByUrl.has(r.url)) recentGone.add(r.url);
  const before = localByUrl.size + recentGone.size;
  const cap = Math.max(20, Math.floor((before * pct) / 100));
  // `asked > 0`: with nothing to delete there is nothing to hold back, even when the window
  // alone is over a cap the user has since lowered.
  const overCap = asked > 0 && asked + recentGone.size > cap;
  // Honoured only for a deletion no larger than the one the user actually saw. Anything
  // bigger arrived after they decided, and has not been approved by anyone.
  const approved = overCap && approvedFor > 0 && asked <= approvedFor;
  // What the removal loop ACTUALLY did. The summary below used to report
  // `toRemove.length`, which is what the peer asked for: a blocked merge logged
  // "-48" directly above the warning saying those 48 were refused (#19). It also
  // counts a remove() that threw, which the old number quietly included.
  let removed = 0;
  // The folder each removed bookmark sat in. A folder this loop empties is a candidate shell
  // for Step D, which decides whether the folder itself was meant to go (#26).
  const parentOf = new Map(localFlat.map((n) => [n.id, n.parentId]));
  const emptiedByDeletion = new Set<string>();
  // The URLs this merge actually took out, for the window.
  const removedKeys = new Set<string>();
  if (overCap && !approved) {
    // Console only, on every cycle. The RETAINED warning is written once per incident
    // by the sync engine (recordBlockedDeletion), because the guard re-evaluates the
    // same peer deletions every sync: warning from here wrote one identical pair a
    // minute into the Activity log and evicted the entry the banner points at (#20).
    const why = recentGone.size
      ? `${asked + recentGone.size} of ${before} with the ${recentGone.size} that peers removed in the last day; cap ${cap}, ${pct}%`
      : `cap ${cap}, ${pct}% of ${localByUrl.size}`;
    logger.info("mergeBookmarks", `Skipped deleting ${asked} bookmarks (${why}): exceeds the mass-delete guard`);
    onBulkBlocked?.({ blocked: asked, cap, localTotal: localByUrl.size, pct, recent: recentGone.size });
  } else {
    for (const id of toRemove) {
      try {
        await browser.bookmarks.remove(id);
        removed++;
        removedKeys.add(keyOfId.get(id) as string);
        const parent = parentOf.get(id);
        if (parent && !localRootIds.has(parent)) emptiedByDeletion.add(parent);
      } catch (err) {
        logger.error("Bookmark delete (tombstone)", err);
      }
    }
    if (approved) {
      logger.event("mergeBookmarks", `Applied ${removed} bookmark deletions you approved (over the ${pct}% guard).`);
    }
  }
  // Keep the window. An approval starts it over: the user was shown the total, the removals
  // before it included, and said yes to it, so none of it may count against the next piece.
  // Written only when something changed, since this runs once per peer on every sync.
  if (approved) {
    if (removals.length) await updatePeerRemovals(() => []);
  } else if (removedKeys.size || removals.some((r) => r.at <= windowStart)) {
    await updatePeerRemovals((current) => [
      ...current.filter((r) => r.at > windowStart && !removedKeys.has(r.url)),
      ...[...removedKeys].map((url) => ({ url, at: mergeStart })),
    ]);
  }

  // ── Step B: fold the remote tree in (folders preserved). For each URL: add it
  //    if missing (unless a deletion suppresses it), or — if already local — move
  //    it to the peer's folder when the peer's placement wins (move LWW). The
  //    placement map is the CURRENT local parent per URL, read after deletions. ──
  // url → current local {id, parent, index-within-parent}, so we can detect both
  // a folder change and a reorder, and skip a move that's already in the right spot.
  // Keyed by canonical url (see canonMap above) so lookups from the remote tree
  // match regardless of bare-origin trailing-slash differences between engines.
  const placement = new Map<string, { id: string; parentId: string | null; index: number; title: string }>();
  const indexLocal = (nodes: SyncBookmark[]): void => {
    nodes.forEach((n, i) => {
      const k = n.url ? canonicalUrlKey(n.url) : undefined;
      // `title` rides along so the rename check below needs no extra bookmarks.get per
      // matched bookmark — the nodes are already in hand.
      if (k && !placement.has(k)) placement.set(k, { id: n.id, parentId: n.parentId, index: i, title: n.title });
      if (n.children) indexLocal(n.children);
    });
  };
  indexLocal(await exportBookmarks());
  const suppressedByDeletion = (url: string): boolean => {
    // A deletion of the copy the browser keeps in the bookmark's place counts as well (#41):
    // that copy is the one the user sees and deletes here, and the peer's form must not
    // bring it back.
    const keys = localKeys(canonicalUrlKey(url));
    const key = keys[0];
    const lAt = newest(localDel, keys);
    const rAt = newest(remoteDel, keys);
    if (strategy === "prefer-local") return lAt !== undefined;   // honor only our deletions
    if (strategy === "prefer-remote") return rAt !== undefined;  // honor the peer's deletions
    const newestDel = Math.max(lAt ?? 0, rAt ?? 0);              // lww
    return newestDel > 0 && newestDel >= (remoteAdd.get(key) ?? 0);
  };
  /**
   * Which title wins for a bookmark we already have.
   *
   * Only ever acts on a RECORDED rename. Two bookmarks can differ in title with neither
   * side having renamed anything (one device typed it differently when the page was
   * bookmarked), and overwriting on that basis would make the two devices trade titles
   * back and forth every cycle. No record on either side means nobody renamed anything,
   * so there is nothing to propagate.
   */
  const winningTitle = (url: string, currentTitle: string): string | null => {
    const key = canonicalUrlKey(url);
    const rt = remoteTitleAt.get(key);
    if (!rt) return null;
    if (strategy === "prefer-local") return null;
    // A rename made here was recorded under the URL the browser keeps (#41).
    const localAt = Math.max(0, ...localKeys(key).map((k) => localTitleAt.get(k)?.at ?? 0));
    if (strategy !== "prefer-remote" && rt.at <= localAt) return null;
    return rt.title === currentTitle ? null : rt.title;
  };

  const shouldMove = (url: string): boolean => {
    if (strategy === "prefer-local") return false;               // local placement wins
    if (strategy === "prefer-remote") return true;               // peer placement wins
    const key = canonicalUrlKey(url);
    // lww: newer move wins. A move made here was recorded under the URL the browser keeps (#41).
    return (remoteMoveAt.get(key) ?? 0) > (newest(localMoveAt, localKeys(key)) ?? 0);
  };

  const otherId = defaultOtherRootId(localRoots);
  if (!otherId) {
    logger.warn("mergeBookmarks", "No writable root folder found");
    return;
  }

  let renamedFolders = 0;

  // ── Step 0: apply the peer's folder RENAMES, before anything matches on a title.
  //    A folder has no cross-device id — its identity is its path — so a rename is
  //    recorded as an operation (from → to) and replayed here. It has to run before the
  //    fold, or the fold matches folders by their OLD names and creates a duplicate
  //    alongside the renamed one.
  if (strategy !== "prefer-local") {
    // Our own renames of the same folder, so LWW has something to compare against.
    const localRenameByKey = new Map<string, FolderRenameRecord>();
    for (const r of logs.folderRenames.local) localRenameByKey.set(folderRenameKey(r), r);

    for (const r of logs.folderRenames.remote) {
      const mine = localRenameByKey.get(folderRenameKey(r));
      if (strategy !== "prefer-remote" && mine && mine.at >= r.at) continue; // ours is newer
      try {
        const parentId = await resolveFolderPath(r.path, localRoots);
        if (!parentId) continue; // path doesn't exist here — fail safe, same as Step C
        const folders = (await browser.bookmarks.getChildren(parentId)).filter((c) => !c.url && !excluded.has(c.id));
        // If we renamed it too and the peer's is newer, the folder is sitting under OUR
        // new name, not under `from` — look for that as well, or the peer's newer rename
        // would silently find nothing and be lost.
        const candidates = [
          ...folders.filter((c) => c.title === r.from),
          ...(mine ? folders.filter((c) => c.title === mine.to) : []),
        ];
        // One of several folders called `from` (#51): the one holding the bookmark it names.
        const target = r.holds
          ? await markedFolder(folders, candidates, localKeys(canonicalUrlKey(r.holds)))
          : candidates[0];
        if (!target || target.title === r.to) continue;
        await browser.bookmarks.update(target.id, { title: r.to });
        renamedFolders++;
      } catch (err) {
        logger.error(`Folder rename: ${r.from}`, err);
      }
    }
  }

  let added = 0;
  let moved = 0;
  let renamed = 0;
  const addedUrls = new Set<string>();
  // Folders a cross-parent bookmark move emptied on THIS device — the receiver
  // relocated the bookmarks (URL move-log) but the folder they left behind is a
  // shell. Cleaned up after the fold (bottom-up), never touching user-empty
  // folders (only ids WE moved a bookmark out of).
  const emptiedParents = new Set<string>();
  // Local folders a peer folder has been matched to in this merge (see sameTitleFolder).
  const claimedFolders = new Set<string>();

  // Create folders LAZILY — a folder is only materialized when a descendant
  // bookmark is actually added/moved under it (`ensureParent` walks up and creates
  // the chain on demand, memoized). This stops an empty folder from resurrecting
  // from a peer: when a folder's bookmarks are all deleted/tombstoned (folders carry
  // no tombstone of their own), nothing triggers its creation, so it stays gone.
  // `index` = the node's position among its siblings in the REMOTE tree, so adds
  // and moves land at the peer's position instead of always at the end of the folder.
  const mergeNode = async (
    node: SyncBookmark, ensureParent: () => Promise<string>, siblings: SyncBookmark[], index: number,
    rootConfident: boolean,
  ): Promise<void> => {
    // The peer's previous sibling is the anchor, and so is WHICH of its name it is: a parent
    // can hold several folders of one name (#51). Counted only for an add or a move, which
    // walk the siblings anyway: every node of a folder of thousands, on every sync, is not.
    const prevKey = index > 0 ? siblingKey(siblings[index - 1]) : undefined;
    const prevNth = (): number => (index > 0 ? keyOrdinal(siblings, index - 1, siblingKey) : 0);
    if (node.url) {
      // Match on the canonical key (bare-origin trailing-slash differs by engine),
      // but create/move with the node's original url below.
      const urlKey = canonicalUrlKey(node.url);
      if (addedUrls.has(urlKey)) return;
      // The browser may keep this bookmark under another URL (#41), and that copy is it.
      const kept = keptKey(urlKey);
      // Including a copy this merge has just made, for a peer that holds the kept form too.
      // `placement` predates the fold, so without this the order of the peer's tree decided
      // whether a second copy was made.
      if (kept && addedUrls.has(kept)) return;
      const loc = placement.get(urlKey) ?? (kept ? placement.get(kept) : undefined);
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
            const target = await anchoredIndex(targetId, loc.id, prevKey, index, prevNth());
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
              if (from && from !== targetId && !localRootIds.has(from)) emptiedParents.add(from);
            }
          } catch (err) {
            logger.error(`Bookmark move: ${node.title}`, err);
          }
        }
        const newTitle = winningTitle(node.url, loc.title);
        if (newTitle !== null) {
          // The merge had CREATE, MOVE and REMOVE but no UPDATE: once a peer's bookmark
          // matched a local URL it was considered satisfied and returned right here, so a
          // rename travelled in every packet and was discarded on arrival by every device.
          try {
            await browser.bookmarks.update(loc.id, { title: newTitle });
            renamed++;
          } catch (err) {
            logger.error(`Bookmark rename: ${node.url}`, err);
          }
        }
        return; // present → never add a duplicate
      }
      if (suppressedByDeletion(node.url)) return;
      // We created this before, it is not here, and nobody has deleted it since, nor has the
      // peer added it again. The browser did not keep what it was given, and creating it again
      // would only repeat that on every sync, which is how one bookmark became thousands (#41).
      const rec = created.get(urlKey);
      if (rec && typeof rec.kept !== "string"
        && (remoteAdd.get(urlKey) ?? 0) <= rec.at && !deletedSince(urlKey, rec.at)) {
        if (rec.kept === undefined) {
          created.set(urlKey, { ...rec, kept: null });
          createdDirty = true;
          logger.event("mergeBookmarks", `This browser did not keep ${node.url}, so it is no longer added again on every sync`);
        }
        return;
      }
      try {
        const parentId = await ensureParent();
        // Resolve the position against the LOCAL parent (same anchor-then-clamp rule
        // as the move path). Passing the peer's raw index made the browser reject the
        // create whenever the local parent was smaller — and the catch below turned
        // that into a bookmark that silently never appeared, on every sync.
        const at = placementIndex(await browser.bookmarks.getChildren(parentId), prevKey, index, prevNth());
        const made = await browser.bookmarks.create({ parentId, index: at, title: node.title, url: node.url });
        addedUrls.add(urlKey);
        added++;
        // What the browser actually stored. A different URL is one this merge would never
        // find again under the peer's, so remember the pair (#41).
        const madeUrl = made?.url && canonicalUrlKey(made.url) !== urlKey ? made.url : undefined;
        if (madeUrl) {
          addedUrls.add(canonicalUrlKey(madeUrl));
          logger.event("mergeBookmarks", `This browser keeps ${node.url} as ${madeUrl}, so the two are now treated as one bookmark`);
        }
        created.set(urlKey, madeUrl ? { url: node.url, at: Date.now(), kept: madeUrl } : { url: node.url, at: Date.now() });
        createdDirty = true;
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
        const existing = await sameTitleFolder(node, siblings, children, excluded, claimedFolders);
        // Same anchor-then-clamp as the bookmark add — `children` is already in hand,
        // so this costs nothing. Unclamped, a folder at a peer index past the local
        // parent's end failed to create, and the rejection surfaced (confusingly) as
        // an error against its first child, which then went missing too.
        if (existing) {
          folderId = existing;
        } else {
          folderId = (await browser.bookmarks.create({
            parentId,
            index: placementIndex(children, prevKey, index, prevNth()),
            title: node.title,
          })).id;
          claimedFolders.add(folderId);
        }
        return folderId;
      };
      const kids = node.children ?? [];
      for (let i = 0; i < kids.length; i++) {
        await mergeNode(kids[i], ensureThis, kids, i, rootConfident);
      }
    }
  };

  // ── Step C: apply folder REPOSITIONS (path-keyed LWW). A folder reordered among
  //    its siblings on a peer carries no URL, so Step B never touches its position —
  //    replay the peer's folder-move here. Placement is ANCHOR-based: position the
  //    folder immediately after the peer's `prev` sibling (or before `next`),
  //    identified by url/title so it maps across devices with different local
  //    siblings; the absolute `index` is only a last-resort fallback. Path
  //    resolution fails safe (skips) when the root kind or a path segment is absent,
  //    so no confidence gate is needed.
  //
  //    It runs TWICE: before the fold, for the folders already here, and after it, for
  //    the ones the fold made and for anything the fold moved out from under an anchor.
  //    Only after, it let Prefer Remote place the loose bookmarks a peer had moved a folder
  //    in front of against that folder's OLD position: the fold re-places every bookmark
  //    there, s0's anchor was the folder still at the end of the bar here, so s0, s1 and s2
  //    followed it to the end, and the late reposition then put the folder in front of them
  //    (QA AX 4, found headless; the same on 1.4.0). A folder already in place is left
  //    alone, so the second pass costs nothing where the first one did the work. ──
  const localFolderMoveAt = toFolderMoveMap(logs.folderMoves.local);
  let folderMoved = 0;
  const applyFolderRepositions = async (): Promise<void> => {
    for (const rec of logs.folderMoves.remote) {
      const winsLWW = strategy === "prefer-local" ? false
        : strategy === "prefer-remote" ? true
        : rec.at > (localFolderMoveAt.get(folderMoveKey(rec)) ?? 0);
      if (!winsLWW) continue;
      let folderId: string | null | undefined;
      if (rec.holds && rec.path.length > 1) {
        // One of several folders of this name (#51): the one holding the bookmark it names.
        const parentId = await resolveFolderPath(rec.path.slice(0, -1), localRoots);
        const folders = parentId
          ? (await browser.bookmarks.getChildren(parentId).catch(() => [] as BookmarkNode[])).filter((c) => !c.url && !excluded.has(c.id))
          : [];
        const title = rec.path[rec.path.length - 1];
        folderId = (await markedFolder(folders, folders.filter((c) => c.title === title), localKeys(canonicalUrlKey(rec.holds))))?.id;
      } else {
        folderId = await resolveFolderPath(rec.path, localRoots);
      }
      if (!folderId || excluded.has(folderId)) continue;
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
  };
  await applyFolderRepositions();
  // The fold reads where each bookmark sits from `placement`, taken before this pass. A folder
  // it moved shifted its siblings' indexes, and a stale snapshot would "move" a bookmark to the
  // place it already holds and count it in the Activity line.
  if (folderMoved > 0) {
    placement.clear();
    indexLocal(await exportBookmarks());
  }

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
      await mergeNode(kids[i], () => Promise.resolve(targetRootId), kids, i, rootConfident);
    }
  }

  // Step C again, now that the fold has made what was missing (see above).
  await applyFolderRepositions();

  // ── Step D: prune the shells this merge left. Two kinds, on different evidence:
  //    - a folder a cross-parent MOVE emptied (see emptiedParents): its bookmarks went
  //      somewhere else, so what stays behind is a shell by construction;
  //    - a folder the peer's DELETIONS emptied (#26), which goes only when something says
  //      the folder itself was meant to: the peer recorded deleting it (or a folder above
  //      it), or the user approved this deletion. Without either, the peer may have kept
  //      the folder on purpose, and emptying it is not the same thing as deleting it.
  //    Bottom-up: removing an empty folder can empty its parent, so the parent is queued
  //    with the same reason and has to meet the same test. ──
  const peerDeletedFolder = async (id: string, dateAdded: number | undefined): Promise<boolean> => {
    if (!logs.folderDeletes.remote.length) return false;
    const path = await folderPath(id);
    if (!path) return false;
    // A folder created here after the peer's deletion is a different folder that happens to
    // share the path, and it stays.
    return logs.folderDeletes.remote.some((r) => pathWithin(path, r.path) && (dateAdded ?? 0) <= r.at);
  };
  // A third kind: a folder an EARLIER merge emptied here and had to leave standing, because
  // the peer had not recorded deleting it then (see KeptShellRecord). Nothing in this merge
  // empties it, so neither list above holds it, and no later merge ever would: empty a folder
  // on one device, sync, then delete the empty folder there, and this device kept its copy
  // for good. Only folders a merge emptied qualify. An empty folder made here was never
  // synced, and a peer's record for the same path says nothing about it.
  // Its own reason, because the approval must not reach it: `approved` covers the deletion
  // the user was shown, not a folder some earlier cycle emptied.
  const kept = await getKeptShells();
  const nowKept = new Set<string>(); // shells this merge leaves standing
  const pruned = new Set<string>();  // folders this merge removed
  let shells = 0;
  const queue: Array<{ id: string; reason: "move" | "delete" | "recorded" }> = [
    ...[...emptiedParents].map((id) => ({ id, reason: "move" as const })),
    ...[...emptiedByDeletion].map((id) => ({ id, reason: "delete" as const })),
    ...(logs.folderDeletes.remote.length ? kept : []).map(({ id }) => ({ id, reason: "recorded" as const })),
  ];
  // No "seen" set: a folder that still had a child when it came up must be looked at again
  // once that child is pruned, and the queue only grows on a removal, so it always ends.
  while (queue.length) {
    const { id, reason } = queue.shift()!;
    if (localRootIds.has(id)) continue; // never remove a root
    try {
      const [node] = await browser.bookmarks.get(id);
      if (!node || node.url) continue; // gone already, or not a folder
      const children = await browser.bookmarks.getChildren(id);
      if (children.length > 0) continue;
      if (reason === "delete" && !approved && !(await peerDeletedFolder(id, node.dateAdded))) {
        nowKept.add(id);
        continue;
      }
      if (reason === "recorded" && !(await peerDeletedFolder(id, node.dateAdded))) continue;
      await browser.bookmarks.remove(id);
      pruned.add(id);
      shells++;
      if (node.parentId) queue.push({ id: node.parentId, reason });
    } catch { /* concurrently removed — ignore */ }
  }

  // Remember what this merge left standing, and forget what is no longer a shell of ours:
  // pruned, gone, or given something back. Refilled, the folder is the user's again, and a
  // peer's record must not take it once they empty it themselves.
  const tracked = new Map<string, number>(kept.map((r) => [r.id, r.at]));
  for (const id of nowKept) if (!tracked.has(id)) tracked.set(id, Date.now());
  if (tracked.size) {
    const survivors: KeptShellRecord[] = [];
    for (const [id, at] of tracked) {
      if (pruned.has(id)) continue;
      try {
        const [node] = await browser.bookmarks.get(id);
        if (!node || node.url) continue;
        if ((await browser.bookmarks.getChildren(id)).length) continue;
        survivors.push({ id, at });
      } catch { /* gone */ }
    }
    if (survivors.length !== kept.length || survivors.some((r, i) => r.id !== kept[i].id)) {
      await updateKeptShells(() => survivors);
    }
  }

  // Settle what earlier merges created (#41). A create that is still here under the URL it was
  // given has stuck, and one somebody deleted since is the tombstones' business. Neither needs
  // watching any longer. A create that vanished stops mattering once its peer has had 90 days
  // to offer it again, the tombstone TTL. The pair the browser keeps under another URL does
  // not expire: that is how this browser stores it, and forgetting it restarts the copies.
  if (created.size) {
    const here = new Set(
      flattenNodes(await exportBookmarks()).filter((n) => n.url).map((n) => canonicalUrlKey(n.url as string))
    );
    const now = Date.now();
    for (const [key, r] of created) {
      if (r.at >= mergeStart) continue; // this merge made it; the next one checks it
      const stuck = here.has(key) && now - r.at >= CREATED_CONFIRM_MS;
      const expired = typeof r.kept !== "string" && now - r.at > TOMBSTONE_TTL_MS;
      if (stuck || expired || deletedSince(key, r.at)) {
        created.delete(key);
        createdDirty = true;
      }
    }
  }
  if (createdDirty) await updateCreated(() => [...created.values()]);

  // The most informative line about what a sync actually DID to the tree, so it belongs
  // in the user's Activity log — but only when it changed something. Every idle cycle
  // logging "+0 / -0 / moved 0" is exactly the noise that used to evict the warnings.
  const summary = `Merged +${added} / -${removed} / moved ${moved} / renamed ${renamed}+${renamedFolders} / folders ${folderMoved} / shells ${shells} (folders preserved)`;
  if (added || removed || moved || renamed || renamedFolders || folderMoved || shells) logger.event("mergeBookmarks", summary);
  else logger.info("mergeBookmarks", summary);
}

/** Resolve a browser-agnostic folder path (`[rootKind, …titles]`) to a local
 *  folder id, or null if the root kind or any path segment is missing locally. */
async function resolveFolderPath(path: string[], localRoots: BookmarkNode[]): Promise<string | null> {
  // A bare [rootKind] resolves to the root itself. The old guard rejected it because the
  // only caller was the folder-reposition step, whose paths always carry the folder own
  // title and so are never shorter than two — but a RENAME is keyed by its parent path,
  // and a folder sitting directly in the bookmarks bar has exactly ["bar"] as its parent.
  // Rejecting that silently dropped the most common rename there is.
  if (path.length < 1) return null;
  const [segment, ...titles] = path;
  const kind = asRootKind(segment);
  if (!kind) return null;
  const root = findLocalRootByKind(localRoots, kind);
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

/**
 * The local folder among `children` that the peer's folder `node` fills, or undefined to make
 * a new one (#51).
 *
 * A folder has no id that crosses devices, so it is found by its title under the same parent.
 * That is enough while the title is unique there, and it is what lets two devices that each
 * have a "Work" folder end up with one. But a parent can hold several folders of one name
 * (unnamed ones, most often), and matching on the title alone poured all of them into the
 * first, on every device the tree reached.
 *
 * So among the local folders of that name it takes the one holding most of `node`'s bookmarks,
 * else one holding none of a same-named sibling's on the peer, else none. `claimed` is what
 * this merge already gave to another folder, so two of the peer's never share one here; the
 * one chosen is added to it.
 */
async function sameTitleFolder(
  node: SyncBookmark,
  siblings: SyncBookmark[],
  children: BookmarkNode[],
  excluded: Set<string>,
  claimed: Set<string>,
): Promise<string | undefined> {
  const candidates = children.filter((c) => !c.url && c.title === node.title && !excluded.has(c.id) && !claimed.has(c.id));
  const twins = siblings.filter((s) => s !== node && !s.url && s.title === node.title);
  let chosen: string | undefined;
  if (candidates.length <= 1 && !twins.length) {
    chosen = candidates[0]?.id; // the title is unique on both sides: nothing to tell apart
  } else {
    const mine = urlKeysIn([node]);
    const theirs = urlKeysIn(twins);
    let best = 0;
    let free: string | undefined;
    for (const c of candidates) {
      // getChildren does not carry grandchildren, and a folder of folders is matched by what
      // is inside those.
      const held = urlKeysIn((await browser.bookmarks.getSubTree(c.id)).map(mapNode));
      let score = 0;
      let twinHeld = false;
      for (const u of held) {
        if (mine.has(u)) score++;
        else if (theirs.has(u)) twinHeld = true;
      }
      if (score > best) { best = score; chosen = c.id; }
      if (!score && !twinHeld && free === undefined) free = c.id;
    }
    chosen ??= free;
  }
  if (chosen) claimed.add(chosen);
  return chosen;
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
async function anchoredIndex(
  parentId: string, movingId: string, prevKey: string | undefined, fallbackIndex: number, prevNth = 0,
): Promise<number> {
  const rest = (await browser.bookmarks.getChildren(parentId)).filter((c) => c.id !== movingId);
  return placementIndex(rest, prevKey, fallbackIndex, prevNth);
}

/** Where to place a node among `siblings` — the pure core shared by the move path
 *  (`anchoredIndex`) and the ADD path in the merge.
 *
 *  Anchored to the peer's previous sibling (`prevKey`) rather than its absolute index,
 *  which doesn't translate when the two devices have different device-local siblings.
 *  The absolute index is the fallback, CLAMPED to `siblings.length`: the browser
 *  rejects `create`/`move` past the child count ("Index out of bounds."), and on the
 *  add path that rejection was swallowed by the caller's catch — so a peer index
 *  larger than the local parent silently dropped the bookmark on every sync. Every
 *  return here is a valid insertion point.
 *
 *  `prevNth` says which of the siblings sharing `prevKey` the anchor is (see nthIndexOf). */
function placementIndex(
  siblings: Array<{ url?: string; title: string }>,
  prevKey: string | undefined,
  fallbackIndex: number,
  prevNth = 0,
): number {
  if (prevKey === undefined) return 0; // peer had it first
  const p = nthIndexOf(siblings.map(siblingKey), prevKey, prevNth);
  if (p >= 0) return p + 1; // immediately after the shared prev sibling
  return Math.min(Math.max(0, fallbackIndex), siblings.length); // anchor absent → clamp
}

/** How many of `nodes` before `i` share its key. */
function keyOrdinal<T>(nodes: T[], i: number, keyOf: (n: T) => string): number {
  const key = keyOf(nodes[i]);
  let n = 0;
  for (let j = 0; j < i; j++) if (keyOf(nodes[j]) === key) n++;
  return n;
}

/** Where the `nth` (from 0) of the entries equal to `key` sits in `keys`; the last of them when
 *  there are fewer, and -1 when there is none. An anchor is a sibling's title or url, and a
 *  parent can hold several folders of one name (#51): after the peer's second "News" folder
 *  means after the second one here too, not after the first. */
function nthIndexOf(keys: string[], key: string, nth: number): number {
  let last = -1;
  let seen = 0;
  for (let i = 0; i < keys.length; i++) {
    if (keys[i] !== key) continue;
    if (seen++ === nth) return i;
    last = i;
  }
  return last;
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

/** A sibling's identity for restore placement: a folder by title, a bookmark by its CANONICAL
 *  url. A restore point is shared by every device, and a browser that keeps a bare origin
 *  without its trailing slash would otherwise never find its neighbour in one that adds it. */
function restoreKey(n: { url?: string; title: string }): string {
  return n.url ? `u:${canonicalUrlKey(n.url)}` : `f:${n.title}`;
}

/**
 * Where a restored node goes among its parent's current `children` (#29): next to the
 * neighbours it had in the snapshot.
 *
 * Right after the node that preceded it, else right before the one that followed it, since
 * both were adjacent to it; failing those, after the nearest earlier neighbour that is here,
 * then before the nearest later one. Only with no neighbour here at all does the snapshot's
 * own index decide, clamped to the parent.
 *
 * A neighbour can be absent although the snapshot has it, and never because it was deleted:
 * a deleted one is in the snapshot too, so the restore has already put it back. It is absent
 * when the restore does not put it back into THIS parent: a folder renamed since (nothing in
 * it is missing, so no folder by the old name is made), a bookmark moved to another folder or
 * also held in one, a restore point taken on a device laid out differently, or a create the
 * browser refused.
 */
function restorePlacement(
  children: Array<{ url?: string; title: string }>, siblings: SyncBookmark[], i: number,
): number {
  const here = children.map(restoreKey);
  const find = (j: number): number =>
    (j >= 0 && j < siblings.length ? nthIndexOf(here, restoreKey(siblings[j]), keyOrdinal(siblings, j, restoreKey)) : -1);
  const prev = find(i - 1);
  if (prev >= 0) return prev + 1;
  const next = find(i + 1);
  if (next >= 0) return next;
  for (let j = i - 2; j >= 0; j--) {
    const p = find(j);
    if (p >= 0) return p + 1;
  }
  for (let j = i + 2; j < siblings.length; j++) {
    const n = find(j);
    if (n >= 0) return n;
  }
  return Math.min(Math.max(0, i), children.length);
}

/** Restore bookmarks from a snapshot tree: re-create every URL that isn't currently
 *  present locally, into its folder path, IGNORING tombstones — the whole point of a
 *  restore point is to bring back deleted bookmarks. Fresh creates get a current
 *  dateAdded, which beats an older peer deletion on the next sync (mergeBookmarks
 *  Step A keeps a local add strictly newer than the tombstone). Local tombstones for
 *  the restored URLs are dropped so this device doesn't immediately re-delete them.
 *  Folders are materialized lazily (only when a restored bookmark lands under them),
 *  so an empty folder from the snapshot isn't recreated. Returns the count added. */
export async function restoreBookmarks(snapshot: SyncBookmark[]): Promise<number> {
  assertDataTypeApi("bookmarks");
  // A restore point taken before a folder was excluded still holds it, and putting it back
  // would only fill the excluded folder with copies of what is already there (#54).
  const rules = await getBookmarkExclusions();
  const local = rules.length ? await localExclusions(rules) : null;
  const tree = local ? withoutExcluded(snapshot, local) : snapshot;
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
    // A bookmark this browser keeps under another URL is here under that one (#41), and
    // restoring the snapshot's form would only add another copy of it.
    const created = toCreatedMap(await getCreated());
    const isPresent = (key: string): boolean => {
      const kept = created.get(key)?.kept;
      return present.has(key) || (typeof kept === "string" && present.has(canonicalUrlKey(kept)));
    };
    let added = 0;
    const claimed = new Set<string>(); // see sameTitleFolder
    const excluded = local?.part.excludedIds ?? new Set<string>();

    // Every create is placed, not appended (#29). A restore is additive, so the parent it
    // fills usually still holds some of its old children, and appending put everything that
    // came back after everything that had survived: a folder that was last on the bar ended
    // up ahead of bookmarks that used to precede it. Each restored node goes next to its
    // neighbours in the snapshot (see restorePlacement), because the snapshot's raw index
    // cannot know about children this parent has gained since.
    const walk = async (
      node: SyncBookmark, ensureParent: () => Promise<string>, siblings: SyncBookmark[], i: number,
    ): Promise<void> => {
      if (node.url) {
        const key = canonicalUrlKey(node.url);
        if (isPresent(key)) return;
        try {
          const parentId = await ensureParent();
          const at = restorePlacement(await browser.bookmarks.getChildren(parentId), siblings, i);
          const made = await browser.bookmarks.create({ parentId, index: at, title: node.title, url: node.url });
          present.add(key);
          // What the browser stored, which may not be what it was given (#41). A snapshot that
          // holds both forms must not restore two copies.
          if (made?.url) present.add(canonicalUrlKey(made.url));
          added++;
        } catch { /* skip invalid url */ }
        return;
      }
      let folderId: string | null = null;
      const ensureThis = async (): Promise<string> => {
        if (folderId) return folderId;
        const parentId = await ensureParent();
        const children = await browser.bookmarks.getChildren(parentId);
        const existing = await sameTitleFolder(node, siblings, children, excluded, claimed);
        if (existing) {
          folderId = existing;
        } else {
          folderId = (await browser.bookmarks.create({ parentId, index: restorePlacement(children, siblings, i), title: node.title })).id;
          claimed.add(folderId);
        }
        return folderId;
      };
      await walkChildren(node.children ?? [], ensureThis);
    };
    const walkChildren = async (kids: SyncBookmark[], ensureParent: () => Promise<string>): Promise<void> => {
      for (let i = 0; i < kids.length; i++) await walk(kids[i], ensureParent, kids, i);
    };

    const roots = tree[0]?.children ?? tree;
    for (let r = 0; r < roots.length; r++) {
      const root = roots[r];
      if (!root) continue;
      const targetRootId = matchLocalRoot(root, localRoots, r) ?? otherId;
      await walkChildren(root.children ?? [], () => Promise.resolve(targetRootId));
    }
    logger.event("Snapshots", `Restored ${added} bookmark(s)`);
    return added;
  } finally {
    importing = false;
  }
}

// ─── Listeners ───────────────────────────────────────────────────────────

export type BookmarkChangeCallback = () => void;

/**
 * The ids the exclusion rules cover right now (#54), kept from one event to the next.
 *
 * An extension filling its excluded folder fires thousands of onCreated in a row, and
 * reading the whole tree for each of them would be its own freeze. So the set is built once
 * and grown as nodes appear inside it, and rebuilt when the rules change or a move may have
 * carried something in or out.
 *
 * It is only ever asked about a node's PARENT. The event that wakes a stopped service worker
 * is often the very one being judged, so the set may well be built after the move or the
 * removal it is asked about, and by then it cannot say where the node itself was. The parent
 * is there on both sides of the event; the node's own rules are checked separately.
 */
let excludedCache: { sig: string; rules: BookmarkExclusion[]; ids: Set<string> } | null = null;

async function excludedNow(): Promise<typeof excludedCache> {
  const rules = await getBookmarkExclusions();
  if (!rules.length) return (excludedCache = null);
  const sig = JSON.stringify(rules);
  if (excludedCache?.sig !== sig) {
    excludedCache = { sig, rules, ids: (await localExclusions(rules)).part.excludedIds };
  }
  return excludedCache;
}

/** Test seam: forget the set, so one test's tree cannot answer for the next one's. */
export function resetExclusionCache(): void {
  excludedCache = null;
}

/** A local folder's path the way the exclusion rules spell it (rootKey first), or null. */
async function exclusionPath(id: string): Promise<string[] | null> {
  // Same question as folderPath, same answer: the tree's own top level. This used to test
  // the id table first, which a renumbered profile's roots fail.
  const roots = await localRootsById();
  const titles: string[] = [];
  let currentId: string | undefined = id;
  for (let hops = 0; hops < 64 && currentId; hops++) {
    const root = roots.get(currentId);
    if (root) return [rootKey(root), ...titles];
    let node: BookmarkNode | undefined;
    try { [node] = await browser.bookmarks.get(currentId); } catch { return null; }
    if (!node || !node.parentId) return null;
    titles.unshift(node.title);
    currentId = node.parentId;
  }
  return null;
}

/** Is (or was) `node` excluded, sitting in `parentId`? Judged from the parent, see above. */
async function excludedUnder(
  ex: NonNullable<typeof excludedCache>, parentId: string | undefined, node: BookmarkNode,
): Promise<boolean> {
  if (parentId && ex.ids.has(parentId)) return true;
  if (!parentId || !mayHaveOwnRule(node, ex.rules)) return false;
  const path = await exclusionPath(parentId);
  return !!path && excludedByOwnRule(node, path, ex.rules);
}

/** Every node in a subtree, as it stands now. */
async function subtreeNodes(id: string): Promise<BookmarkNode[]> {
  try {
    return flattenNodes((await browser.bookmarks.getSubTree(id)) as SyncBookmark[]) as BookmarkNode[];
  } catch {
    return [];
  }
}

/**
 * Something synced was moved into an excluded folder (#54), so for the peers it is gone.
 * Recorded as the deletion it is to them: they still hold it under its old folder, and the
 * next merge would put it straight back here as a second copy outside the excluded one.
 */
async function recordLeftSync(id: string, oldParentId: string): Promise<void> {
  const [node] = await browser.bookmarks.getSubTree(id).catch(() => [] as BookmarkNode[]);
  if (!node) return;
  await recordRemovedTombstones(node);
  await recordRemovedFolder(oldParentId, node);
}

/**
 * Something excluded was moved out into the synced tree (#54). It reaches the peers as new,
 * but it keeps its old dateAdded, and a deletion recorded when it went in would read as
 * newer and remove it again: the same trap a restored backup falls into (#27).
 *
 * Every bookmark in it is recorded, however recently it was saved. `recordAppeared` lets a
 * bookmark dated in the last minute go, since one the user just made needs no record, but
 * here the deletion to outdate can be newer than that: save a bookmark, drag it into the
 * excluded folder and back out within the minute, and its dateAdded was older than the
 * tombstone its trip in left, so every peer refused it for good (QA AT 5, found headless).
 */
async function recordJoinedSync(id: string): Promise<void> {
  const now = Date.now();
  const urls = (await subtreeNodes(id)).filter((n) => n.url).map((n) => n.url as string);
  if (urls.length) await updateAppeared((current) => gcAppeared([...current, ...urls.map((url) => ({ url, at: now }))]));
}

export function registerBookmarkListeners(onChange: BookmarkChangeCallback): void {
  // The background script calls this at the TOP LEVEL, because MV3 requires listeners to
  // be attached on every worker load. So on a browser with no bookmarks API this line
  // threw during module evaluation and took the rest of the file down with it — the
  // extension came up half-built, with whatever had already registered still working.
  // That is the worst possible failure shape: it looks like the extension works.
  if (!eventPresent("bookmarks", "onCreated")) {
    logger.info("BookmarkListeners", "This browser has no bookmarks API — bookmark-change listeners not registered");
    return;
  }
  // A browser event handler is not a promise chain anybody awaits, so a rejection from
  // one of these recorders had nowhere to go: it surfaced as an unhandled rejection in a
  // service worker nobody has a console open on. They are all storage writes, and a
  // storage write that fails is worth a line in the log rather than silence.
  const swallow = (p: Promise<unknown>): void => {
    void p.catch((err) => logger.error("BookmarkListeners", err));
  };
  // Each event first asks whether it is about something this device keeps to itself (#54).
  // Those record nothing and start no sync: an extension rewriting its excluded folder is
  // exactly the storm of events that froze the browser. A merge never writes there, so
  // its own churn (`importing`) skips the question.
  // A storage read that fails is no reason to drop the event: judged as not excluded, it is
  // recorded and synced as it always was.
  const exclusions = () => (importing ? Promise.resolve(null) : excludedNow().catch(() => null));
  browser.bookmarks.onCreated.addListener((id, node) => {
    swallow((async () => {
      const ex = await exclusions();
      // Outside every excluded folder it can still be excluded itself: an extension
      // rebuilding its folder makes a new one at the excluded path.
      if (ex && await excludedUnder(ex, node.parentId, node)) {
        ex.ids.add(id);
        return;
      }
      // An import that keeps each bookmark's original date would otherwise read as months old
      // to the next merge, and a peer's older deletion would undo it (#27).
      swallow(recordAppeared(node));
      onChange();
    })());
  });
  browser.bookmarks.onChanged.addListener((id, changeInfo) => {
    swallow((async () => {
      const ex = await exclusions();
      if (ex) {
        if (ex.ids.has(id)) return;
        // Renamed or re-pointed onto an excluded path or URL: it leaves the sync as a move
        // into an excluded folder does.
        const [node] = await browser.bookmarks.get(id).catch(() => [] as BookmarkNode[]);
        if (node && await excludedUnder(ex, node.parentId, node)) {
          excludedCache = null;
          swallow(browser.bookmarks.getSubTree(id).then(([sub]) => (sub ? recordRemovedTombstones(sub) : undefined)));
          onChange();
          return;
        }
      }
      // A URL edit is a delete(old)+add(new) in the URL-keyed sync model — record a
      // tombstone for the replaced url so a peer doesn't resurrect it as a duplicate.
      swallow(recordUrlChange(id, changeInfo.url));
      // A title edit is the other half of onChanged, and nothing was listening for it:
      // the new title rode along in the tree but the receiver had no way to know it was
      // newer than its own, so it kept the old one. Both renames land here.
      swallow(recordTitleChange(id, changeInfo.title));
      onChange();
    })());
  });
  browser.bookmarks.onMoved.addListener((id, moveInfo) => {
    swallow((async () => {
      const ex = await exclusions();
      if (ex) {
        const [node] = await browser.bookmarks.get(id).catch(() => [] as BookmarkNode[]);
        if (node) {
          const was = await excludedUnder(ex, moveInfo.oldParentId, node);
          const now = await excludedUnder(ex, moveInfo.parentId, node);
          if (was && now) return; // reshuffled inside: nothing syncs
          // In or out, the set no longer describes the tree.
          if (was !== now) excludedCache = null;
          if (now) {
            swallow(recordLeftSync(id, moveInfo.oldParentId));
            onChange();
            return;
          }
          if (was) swallow(recordJoinedSync(id));
        }
      }
      // Record the move (per URL, timestamped) so the new placement propagates.
      swallow(recordMove(id));
      // Also record a folder's own reposition (path-keyed) — a reordered folder has
      // no URL, so recordMove alone can't carry its new index across devices.
      swallow(recordFolderMove(id, moveInfo));
      onChange();
    })());
  });
  browser.bookmarks.onRemoved.addListener((_id, removeInfo) => {
    swallow((async () => {
      const ex = await exclusions();
      let skip: Set<string> | undefined;
      if (ex) {
        if (await excludedUnder(ex, removeInfo.parentId, removeInfo.node)) return;
        // A synced folder going with something excluded inside it.
        if (removeInfo.node.children?.length) {
          const path = await exclusionPath(removeInfo.parentId);
          if (path) skip = excludedInSubtree(removeInfo.node, path, ex.rules);
        }
      }
      // Record a tombstone so the deletion propagates instead of resurrecting.
      swallow(recordRemovedTombstones(removeInfo.node, skip));
      // And, for a folder, that the folder went too, or its shell outlives it everywhere else.
      swallow(recordRemovedFolder(removeInfo.parentId, removeInfo.node));
      onChange();
    })());
  });
  logger.info("BookmarkListeners", "Registered");
}

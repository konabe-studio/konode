// Bookmark snapshots (restore points). A snapshot is a timestamped copy of the
// bookmark tree written to the backend as `konode_snap_bookmarks_<epochms>.json` —
// a name downloadAll's `konode_<type>_` filter never matches, so restore points are
// invisible to normal sync. When E2EE is on the payload is encrypted like a packet.
//
// A small index file (`konode_snap_index.json`) carries the bookmark count per
// snapshot so the UI can show it without reading (and decrypting) every snapshot —
// and without leaking the count into the plaintext filename, which the storage
// provider can read. It lives on the backend so EVERY device sees the counts, not
// just the one that took the snapshot, and it is encrypted whenever E2EE is on.
//
// The backend file LIST stays the source of truth for which snapshots exist; the
// index only annotates them. That split matters twice over: an index entry with no
// file behind it is dropped on read, and pruning works off the file list, so it is
// correct on a device that has never written the index.

import type { IBackend, SyncSettings, SyncBookmark, SnapshotMeta } from "@/lib/types";
export type { SnapshotMeta };
import { exportBookmarkPayload, restoreBookmarks, normalizePayload } from "@/lib/handlers/bookmarks-handler";
import { encrypt, decrypt } from "@/lib/crypto/encryption";
import { browser } from "@/lib/utils/ext";
import { KEYS } from "@/lib/utils/storage";
import { logger } from "@/lib/utils/logger";

const PREFIX = "konode_snap_bookmarks_";
const INDEX_NAME = "konode_snap_index.json";
const MAX_SNAPSHOTS = 10;

interface SnapshotFile {
  version: "1.0";
  created: string; // ISO-8601
  encrypted: boolean;
  payload: string; // JSON BookmarkPayload, optionally encrypted (salt+iv+ct base64)
}

interface IndexFile {
  version: "1.0";
  encrypted: boolean;
  payload: string; // JSON SnapshotMeta[], optionally encrypted
}

const nameFor = (ts: number): string => `${PREFIX}${ts}.json`;

function tsFromName(name: string): number | null {
  const m = name.match(/^konode_snap_bookmarks_(\d+)\.json$/);
  return m ? Number(m[1]) : null;
}

function countUrls(tree: SyncBookmark[]): number {
  let n = 0;
  const walk = (nodes: SyncBookmark[]) => nodes.forEach((x) => { if (x.url) n++; if (x.children) walk(x.children); });
  walk(tree);
  return n;
}

/** Read the shared index. Never throws: a missing, corrupt, or undecryptable index
 *  only costs the counts, so degrade to "no annotations" rather than breaking the
 *  restore-point list (the file list alone still tells us what can be restored). */
async function getIndex(backend: IBackend, settings: SyncSettings): Promise<SnapshotMeta[]> {
  try {
    const raw = await backend.getFile(INDEX_NAME);
    if (!raw) return [];
    const file = JSON.parse(raw) as IndexFile;
    let plain = file.payload;
    if (file.encrypted) {
      if (!settings.encryption_passphrase) return [];
      plain = await decrypt(file.payload, settings.encryption_passphrase);
    }
    const list = JSON.parse(plain);
    return Array.isArray(list) ? (list as SnapshotMeta[]) : [];
  } catch {
    return [];
  }
}

async function putIndex(backend: IBackend, settings: SyncSettings, list: SnapshotMeta[]): Promise<void> {
  const useE2ee = settings.encryption_enabled && !!settings.encryption_passphrase;
  const plain = JSON.stringify(list);
  const file: IndexFile = {
    version: "1.0",
    encrypted: useE2ee,
    payload: useE2ee ? await encrypt(plain, settings.encryption_passphrase as string) : plain,
  };
  await backend.putFile(INDEX_NAME, JSON.stringify(file));
}

/** Merge entries into the shared index, keeping only those that still have a file
 *  on the backend. Read-merge-write rather than overwrite: two devices both taking
 *  snapshots must not drop each other's counts. `live` is the current file list. */
async function mergeIndex(
  backend: IBackend, settings: SyncSettings, add: SnapshotMeta[], live: string[],
): Promise<SnapshotMeta[]> {
  const remote = await getIndex(backend, settings);
  const byName = new Map<string, SnapshotMeta>();
  for (const m of [...remote, ...add]) byName.set(m.name, m); // `add` wins on conflict
  const alive = new Set(live);
  const merged = [...byName.values()]
    .filter((m) => alive.has(m.name))
    .sort((a, b) => b.timestamp - a.timestamp);
  await putIndex(backend, settings, merged);
  return merged;
}

/** Write a snapshot of the current bookmark tree, then prune to the newest N. */
export async function createSnapshot(backend: IBackend, settings: SyncSettings): Promise<SnapshotMeta> {
  const payload = await exportBookmarkPayload();
  const count = countUrls(payload.tree);
  const plain = JSON.stringify(payload);
  const useE2ee = settings.encryption_enabled && !!settings.encryption_passphrase;
  const file: SnapshotFile = {
    version: "1.0",
    created: new Date().toISOString(),
    encrypted: useE2ee,
    payload: useE2ee ? await encrypt(plain, settings.encryption_passphrase as string) : plain,
  };
  // The filename carries the timestamp, so two snapshots in the same millisecond
  // would collide and the second would silently overwrite the first. Step past any
  // name already on the backend instead of losing a restore point.
  const taken = new Set(await backend.listFiles(PREFIX));
  let ts = Date.now();
  while (taken.has(nameFor(ts))) ts++;
  const name = nameFor(ts);
  await backend.putFile(name, JSON.stringify(file));
  const meta: SnapshotMeta = { name, timestamp: ts, count };
  // Prune first so the index write reflects the post-prune file list in one pass.
  const live = await pruneSnapshots(backend);
  await mergeIndex(backend, settings, [meta], [...live, name]);
  logger.info("Snapshots", `Created ${name} (${count} bookmarks)`);
  return meta;
}

/** One-time migration: counts used to live in a device-local index, so the counts for
 *  snapshots taken on THIS device exist nowhere else. Publish them to the shared index
 *  — otherwise upgrading would silently discard them — then drop the legacy key.
 *  Returns the merged index, or null when there was nothing to migrate. */
async function migrateLegacyIndex(
  backend: IBackend, settings: SyncSettings, live: string[],
): Promise<SnapshotMeta[] | null> {
  const r = await browser.storage.local.get(KEYS.LEGACY_SNAPSHOTS);
  const legacy = r[KEYS.LEGACY_SNAPSHOTS] as SnapshotMeta[] | undefined;
  if (legacy === undefined) return null;
  let merged: SnapshotMeta[] | null = null;
  if (Array.isArray(legacy) && legacy.length) {
    merged = await mergeIndex(backend, settings, legacy, live);
    logger.info("Snapshots", `Published ${legacy.length} local snapshot count(s) to the shared index`);
  }
  await browser.storage.local.remove(KEYS.LEGACY_SNAPSHOTS);
  return merged;
}

/** List restore points on the backend, newest first, annotated with known counts. */
export async function listSnapshots(backend: IBackend, settings: SyncSettings): Promise<SnapshotMeta[]> {
  const names = await backend.listFiles(PREFIX);
  const idx = (await migrateLegacyIndex(backend, settings, names))
    ?? (await getIndex(backend, settings));
  const byName = new Map(idx.map((m) => [m.name, m]));
  const metas: SnapshotMeta[] = [];
  for (const name of names) {
    const ts = tsFromName(name);
    if (ts == null) continue;
    // Trust the filename's timestamp over the index — the file list is canonical.
    const known = byName.get(name);
    metas.push(known ? { ...known, name, timestamp: ts } : { name, timestamp: ts });
  }
  return metas.sort((a, b) => b.timestamp - a.timestamp);
}

/** Restore a snapshot: re-add every bookmark it holds that's missing locally. */
export async function restoreSnapshot(backend: IBackend, name: string, settings: SyncSettings): Promise<number> {
  const raw = await backend.getFile(name);
  if (!raw) throw new Error("Snapshot not found on the backend.");
  const file = JSON.parse(raw) as SnapshotFile;
  let plain = file.payload;
  if (file.encrypted) {
    if (!settings.encryption_passphrase) throw new Error("This snapshot is encrypted. Set your passphrase first.");
    plain = await decrypt(file.payload, settings.encryption_passphrase);
  }
  const payload = normalizePayload(JSON.parse(plain));
  return restoreBookmarks(payload.tree);
}

/** Delete snapshot files beyond the newest MAX_SNAPSHOTS, and return the names that
 *  survived. Driven by the BACKEND FILE LIST, not a local index: the old version
 *  pruned whatever this device happened to have recorded, so two devices each
 *  holding fewer than the cap between them pruned nothing and the folder grew
 *  without limit. Ordering comes from the timestamp in the filename. */
export async function pruneSnapshots(backend: IBackend): Promise<string[]> {
  const named = (await backend.listFiles(PREFIX))
    .map((name) => ({ name, ts: tsFromName(name) }))
    .filter((x): x is { name: string; ts: number } => x.ts != null)
    .sort((a, b) => b.ts - a.ts);
  const keep = named.slice(0, MAX_SNAPSHOTS);
  for (const { name } of named.slice(MAX_SNAPSHOTS)) {
    try { await backend.deleteFile(name); } catch { /* best effort — retried next time */ }
  }
  return keep.map((x) => x.name);
}

/** Delete one restore point, then drop it from the shared index. */
export async function deleteSnapshot(backend: IBackend, settings: SyncSettings, name: string): Promise<void> {
  if (tsFromName(name) == null) throw new Error("Not a restore point.");
  await backend.deleteFile(name);
  const live = await backend.listFiles(PREFIX);
  // mergeIndex drops entries with no file behind them, which now includes this one.
  await mergeIndex(backend, settings, [], live);
  logger.info("Snapshots", `Deleted ${name}`);
}

// Bookmark snapshots (restore points). A snapshot is a timestamped copy of the
// bookmark tree written to the backend as `konode_snap_bookmarks_<epochms>.json` —
// a name downloadAll's `konode_<type>_` filter never matches, so restore points are
// invisible to normal sync. When E2EE is on the payload is encrypted like a packet.
//
// A small device-local index (KEYS.SNAPSHOTS) carries the bookmark count per snapshot
// so the UI can show it without reading (and decrypting) every file — and without
// leaking the count into the plaintext filename. The backend file list stays the
// source of truth for which snapshots exist; the index only annotates them.

import type { IBackend, SyncSettings, SyncBookmark, SnapshotMeta } from "@/lib/types";
export type { SnapshotMeta };
import { exportBookmarkPayload, restoreBookmarks, normalizePayload } from "@/lib/handlers/bookmarks-handler";
import { encrypt, decrypt } from "@/lib/crypto/encryption";
import { browser } from "@/lib/utils/ext";
import { KEYS } from "@/lib/utils/storage";
import { logger } from "@/lib/utils/logger";

const PREFIX = "konode_snap_bookmarks_";
const MAX_SNAPSHOTS = 10;

interface SnapshotFile {
  version: "1.0";
  created: string; // ISO-8601
  encrypted: boolean;
  payload: string; // JSON BookmarkPayload, optionally encrypted (salt+iv+ct base64)
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

async function getIndex(): Promise<SnapshotMeta[]> {
  const r = await browser.storage.local.get(KEYS.SNAPSHOTS);
  return (r[KEYS.SNAPSHOTS] as SnapshotMeta[]) ?? [];
}
async function setIndex(list: SnapshotMeta[]): Promise<void> {
  await browser.storage.local.set({ [KEYS.SNAPSHOTS]: list });
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
  const ts = Date.now();
  const name = nameFor(ts);
  await backend.putFile(name, JSON.stringify(file));
  const meta: SnapshotMeta = { name, timestamp: ts, count };
  await setIndex([meta, ...(await getIndex())]);
  await pruneSnapshots(backend);
  logger.info("Snapshots", `Created ${name} (${count} bookmarks)`);
  return meta;
}

/** List restore points on the backend, newest first, annotated with counts we know. */
export async function listSnapshots(backend: IBackend): Promise<SnapshotMeta[]> {
  const [names, idx] = await Promise.all([backend.listFiles(PREFIX), getIndex()]);
  const byName = new Map(idx.map((m) => [m.name, m]));
  const metas: SnapshotMeta[] = [];
  for (const name of names) {
    const ts = tsFromName(name);
    if (ts == null) continue;
    metas.push(byName.get(name) ?? { name, timestamp: ts });
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

/** Delete backend files + index entries beyond the newest MAX_SNAPSHOTS. */
export async function pruneSnapshots(backend: IBackend): Promise<void> {
  const idx = (await getIndex()).sort((a, b) => b.timestamp - a.timestamp);
  const drop = idx.slice(MAX_SNAPSHOTS);
  for (const m of drop) {
    try { await backend.deleteFile(m.name); } catch { /* best effort — GC retries next time */ }
  }
  if (drop.length) await setIndex(idx.slice(0, MAX_SNAPSHOTS));
}

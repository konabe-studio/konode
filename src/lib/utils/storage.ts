import type {
  DataType,
  SyncPacket,
  FolderMoveRecord,
  MoveRecord,
  RemoteExtensionEntry,
  RemoteSessionEntry,
  SyncExtension,
  SyncSettings,
  SyncState,
  Tombstone,
} from "@/lib/types";
import { browser } from "@/lib/utils/ext";
import { inferStore, storeUrlFor } from "@/lib/utils/extensions-match";
import { canonicalUrlKey } from "@/lib/utils/url";

// ─── Device name detection ─────────────────────────────────────────────────

function detectDeviceName(): string {
  const ua = navigator.userAgent;

  // OS detection
  let os = "Device";
  if (ua.includes("Windows NT 10.0")) os = "Windows 11";
  else if (ua.includes("Windows NT 6.3")) os = "Windows 8.1";
  else if (ua.includes("Windows NT 6.1")) os = "Windows 7";
  else if (ua.includes("Windows")) os = "Windows";
  else if (ua.includes("Mac OS X")) os = "Mac";
  else if (ua.includes("Linux")) os = "Linux";
  else if (ua.includes("Android")) os = "Android";
  else if (ua.includes("iPhone") || ua.includes("iPad")) os = "iOS";

  // Browser detection
  let browser = "";
  if ((navigator as any).brave) browser = " · Brave";
  else if (ua.includes("Edg/")) browser = " · Edge";
  else if (ua.includes("Chrome")) browser = " · Chrome";
  else if (ua.includes("Firefox")) browser = " · Firefox";

  return `${os}${browser}`;
}

// ─── Default Settings ──────────────────────────────────────────────────────

export const DEFAULT_SETTINGS: SyncSettings = {
  // Intentionally EMPTY: the real identity is minted and persisted by getSettings().
  // This used to be a module-load `crypto.randomUUID()`, which meant every extension
  // context — service worker, popup, options, onboarding — carried its own different
  // default, and nothing ever wrote it down. See getSettings().
  device_id: "",
  device_label: detectDeviceName(),
  // Bookmarks only by default. The extension list is fingerprint-grade data and
  // history/tabs are sensitive, so those are opt-in (turned on in onboarding/settings).
  enabled_types: ["bookmarks"],
  backends: [],
  active_backend: null,
  sync_interval_seconds: 60,
  conflict_strategy: "lww",
  history_days_limit: 30,
  bulk_delete_percent: 60,
  auto_sync: true,
  sync_on_change: true,
  notifications_enabled: true,
  debug_mode: false,
  encryption_enabled: false,
  onboarding_completed: false,
};

export const DEFAULT_STATE: SyncState = {
  status: "idle",
  last_sync: null,
  last_error: null,
  pending_conflicts: [],
  sync_counts: { bookmarks: 0, history: 0, sessions: 0, extensions: 0 },
  bytes_transferred: 0,
  recovery_notice: null,
};

// ─── Keys ──────────────────────────────────────────────────────────────────

// The single source of truth for every chrome.storage.local key. Exported so the
// UI reads/writes go through KEYS.* instead of re-typing raw "konode_*" strings
// (a mistyped/legacy literal is what left the options "missing extensions" list
// silently empty).
export const KEYS = {
  SETTINGS: "konode_settings",
  STATE: "konode_state",
  AUDIT_LOG: "konode_audit",
  BOOKMARK_CACHE: "konode_bm_cache",
  BOOKMARK_TOMBSTONES: "konode_bm_tombstones",
  BOOKMARK_MOVES: "konode_bm_moves",
  BOOKMARK_FOLDER_MOVES: "konode_bm_folder_moves",
  // Superseded by the backend-side `konode_snap_index.json`, which every device can
  // read. Kept only so the one-time migration in sync/snapshots.ts can drain the
  // counts this device recorded before dropping the key.
  LEGACY_SNAPSHOTS: "konode_bm_snapshots",
  HIST_IMPORTED: "konode_hist_imported",
  REMOTE_SESSIONS: "konode_remote_sessions",
  REMOTE_EXTENSIONS: "konode_remote_extensions",
  UPLOAD_CHECKSUMS: "konode_upload_checksums",
  RESOLVED_CONFLICTS: "konode_resolved_conflicts",
  CONFLICT_PACKETS: "konode_conflict_packets",
  RECOVERY_SNAPSHOT: "konode_recovery_snap",
  SYNC_LOCK: "konode_sync_lock",
  GDRIVE_SESSION: "konode_gdrive_session",
  GDRIVE_FOLDER: "konode_gdrive_folder",
} as const;

// ─── Generic Helpers ───────────────────────────────────────────────────────

async function get<T>(key: string, fallback: T): Promise<T> {
  const result = await browser.storage.local.get(key);
  return (result[key] as T) ?? fallback;
}

async function set(key: string, value: unknown): Promise<void> {
  await browser.storage.local.set({ [key]: value });
}

// ─── Serialized read-modify-write ──────────────────────────────────────────
// `chrome.storage.local` has no atomic update, so every get → mutate → set pair is
// a lost-update race. Bookmark bursts make that concrete: Chrome fires one
// `onRemoved` per removed node, so deleting five selected bookmarks starts five
// overlapping recordRemovedTombstones() runs that all read the SAME list and then
// clobber one another. Deletions were silently lost and the bookmarks came back
// from a peer on the next merge — the deletion-propagation model's whole point.
//
// `updateKey` chains updates per key, so each one observes every write before it.
// This guards a single JS context, which is where the bursts happen: the bookmark
// listeners and the sync engine all live in the service worker.

const updateChains = new Map<string, Promise<unknown>>();

export function updateKey<T>(key: string, mutate: (current: T) => T, fallback: T): Promise<T> {
  const run = async (): Promise<T> => {
    const next = mutate(await get<T>(key, fallback));
    await set(key, next);
    return next;
  };
  // Continue on both settle paths, so one failed update can't wedge the key.
  const chained = (updateChains.get(key) ?? Promise.resolve()).then(run, run);
  updateChains.set(key, chained.catch(() => {}));
  return chained;
}

// ─── Settings ──────────────────────────────────────────────────────────────

/**
 * Settings, with a STABLE device identity guaranteed.
 *
 * Every synced file is named `konode_<type>_<device_id>.json`, so the id must never
 * change: a new one means a fresh set of files on the backend while the old ones linger as
 * orphans forever. It used to be a module-load `crypto.randomUUID()` in DEFAULT_SETTINGS
 * that this function merged in but never PERSISTED — so until something happened to call
 * saveSettings(), the answer differed per extension context (each has its own module
 * instance) and per worker wake.
 *
 * That is not cosmetic. `konode_upload_checksums` is a separate key, so a device_id that
 * changed while those survived left the NEW identity's file unwritten for any payload
 * static enough not to change on its own — which is exactly the installed-extension list.
 * It matches a field report where two devices each had an extensions file that was never
 * uploaded and an orphan file from a third id sitting next to them.
 *
 * Minted through the serialized `updateKey`, so two contexts reading at the same moment
 * cannot mint two different ids.
 */
export async function getSettings(): Promise<SyncSettings> {
  // Fallback `{}`, NOT DEFAULT_SETTINGS: "nothing stored" has to be distinguishable so we
  // know to mint an identity, and the defaults get merged over it either way.
  const stored = await get<Partial<SyncSettings>>(KEYS.SETTINGS, {});
  if (stored.device_id) return { ...DEFAULT_SETTINGS, ...stored };
  const settled = await updateKey<Partial<SyncSettings>>(
    KEYS.SETTINGS,
    (cur) => (cur.device_id ? cur : { ...cur, device_id: crypto.randomUUID() }),
    {}
  );
  return { ...DEFAULT_SETTINGS, ...settled };
}

export async function saveSettings(partial: Partial<SyncSettings>): Promise<SyncSettings> {
  const current = await getSettings();
  const next = { ...current, ...partial };
  await set(KEYS.SETTINGS, next);
  return next;
}

// ─── State ─────────────────────────────────────────────────────────────────

export async function getState(): Promise<SyncState> {
  return get<SyncState>(KEYS.STATE, DEFAULT_STATE);
}

export async function setState(partial: Partial<SyncState>): Promise<SyncState> {
  const current = await getState();
  const next = { ...current, ...partial };
  await set(KEYS.STATE, next);
  return next;
}

// ─── Audit Log ─────────────────────────────────────────────────────────────

export interface AuditEntry {
  timestamp: string;
  action: string;
  detail?: string;
  ok: boolean;
}

export async function appendAudit(entry: AuditEntry): Promise<void> {
  // Serialized: the logger calls this without awaiting, so a sync emits several
  // overlapping appends and a plain get→set pair dropped all but the last.
  await updateKey<AuditEntry[]>(KEYS.AUDIT_LOG, (log) => [entry, ...log].slice(0, 200), []);
}

// ─── Caches ────────────────────────────────────────────────────────────────

export async function getBookmarkCache<T>(): Promise<T | null> {
  return get<T | null>(KEYS.BOOKMARK_CACHE, null);
}

export async function setBookmarkCache<T>(data: T): Promise<void> {
  await set(KEYS.BOOKMARK_CACHE, data);
}

export async function getTombstones(): Promise<Tombstone[]> {
  return get<Tombstone[]>(KEYS.BOOKMARK_TOMBSTONES, []);
}

export async function setTombstones(list: Tombstone[]): Promise<void> {
  await set(KEYS.BOOKMARK_TOMBSTONES, list);
}

// Per-URL "last (re)placed at" log, so bookmark MOVES propagate with LWW
// (folders carry no identity; a move keeps the URL but changes its parent).
export async function getMoves(): Promise<MoveRecord[]> {
  return get<MoveRecord[]>(KEYS.BOOKMARK_MOVES, []);
}

export async function setMoves(list: MoveRecord[]): Promise<void> {
  await set(KEYS.BOOKMARK_MOVES, list);
}

// Per-path "folder last repositioned at" log, so a folder reordered among its
// siblings propagates with LWW (a folder has no URL, so the URL move-log above
// can't describe it — see FolderMoveRecord).
export async function getFolderMoves(): Promise<FolderMoveRecord[]> {
  return get<FolderMoveRecord[]>(KEYS.BOOKMARK_FOLDER_MOVES, []);
}

export async function setFolderMoves(list: FolderMoveRecord[]): Promise<void> {
  await set(KEYS.BOOKMARK_FOLDER_MOVES, list);
}

// Serialized read-modify-write for the three change logs (see `updateKey`). Every
// caller that APPENDS to a log — the bookmark listeners, which run unawaited and in
// bursts — must go through these, not a get/set pair, or concurrent events overwrite
// each other and the deletion/move is silently lost. `setX` remains for callers that
// replace the whole log wholesale (the merge, restore, tests).

export function updateTombstones(mutate: (current: Tombstone[]) => Tombstone[]): Promise<Tombstone[]> {
  return updateKey<Tombstone[]>(KEYS.BOOKMARK_TOMBSTONES, mutate, []);
}

export function updateMoves(mutate: (current: MoveRecord[]) => MoveRecord[]): Promise<MoveRecord[]> {
  return updateKey<MoveRecord[]>(KEYS.BOOKMARK_MOVES, mutate, []);
}

export function updateFolderMoves(
  mutate: (current: FolderMoveRecord[]) => FolderMoveRecord[]
): Promise<FolderMoveRecord[]> {
  return updateKey<FolderMoveRecord[]>(KEYS.BOOKMARK_FOLDER_MOVES, mutate, []);
}

// ─── Imported history (CO-6) ─────────────────────────────────────────────────
// URLs this device RECEIVED via history import (not genuinely visited here).
// Excluded from this device's export so imported entries don't get re-published
// as native visits and resurrect across the device mesh forever.

const HIST_IMPORTED_CAP = 20_000;

export async function getImportedHistoryUrls(): Promise<string[]> {
  return get<string[]>(KEYS.HIST_IMPORTED, []);
}

export async function addImportedHistoryUrls(urls: string[]): Promise<void> {
  if (!urls.length) return;
  // Serialized like the other logs (see updateKey) — this was a get/set pair.
  await updateKey<string[]>(KEYS.HIST_IMPORTED, (current) => {
    const seen = new Set(current);
    const merged = [...current];
    for (const u of urls) if (!seen.has(u)) { seen.add(u); merged.push(u); }
    // FIFO cap to bound storage. Dropping the oldest can at worst let one very old
    // imported URL be re-exported once — it won't perpetually resurrect.
    return merged.length > HIST_IMPORTED_CAP ? merged.slice(-HIST_IMPORTED_CAP) : merged;
  }, []);
}

/**
 * Take URLs back OUT of the imported set, because this device has since genuinely visited
 * them itself.
 *
 * The set only ever grew before, and nothing ever released an entry — so once a page had
 * arrived from any peer, this device stopped publishing it FOREVER, even when the user
 * later browsed it here. With three devices each having received most of the mesh's URLs,
 * a day spent on familiar sites exported as nothing at all. Reported from the field as
 * "a day of activity on my Mac, nothing appears on Windows".
 *
 * Compared on the canonical key so the legacy raw entries are removed too.
 */
export async function dropImportedHistoryUrls(urls: string[]): Promise<void> {
  if (!urls.length) return;
  const drop = new Set(urls.map(canonicalUrlKey));
  await updateKey<string[]>(
    KEYS.HIST_IMPORTED,
    (current) => current.filter((u) => !drop.has(canonicalUrlKey(u))),
    []
  );
}

// ─── Last resolved Drive folder ──────────────────────────────────────────────
// Drive FINDS its folder by lookup instead of taking it from config, so the engine's
// destination tag — which is built from the config — cannot see when that folder changes.
// Remembering the last one lets the Drive backend flush the upload checksums exactly when
// the destination really moved. See GDriveBackend.noteResolvedFolder.

export async function getLastDriveFolder(): Promise<string | null> {
  return get<string | null>(KEYS.GDRIVE_FOLDER, null);
}

export async function setLastDriveFolder(id: string): Promise<void> {
  await set(KEYS.GDRIVE_FOLDER, id);
}

// ─── Recovery-snapshot latch ─────────────────────────────────────────────────
// The mass-delete guard re-evaluates the SAME peer deletions on every merge (a
// peer's tombstones live for 90 days and the local bookmarks are still there,
// because we refused to remove them), so "blocked → save a restore point" fired
// on every sync. With a 10-slot snapshot ring and a 60s interval that evicted
// every pre-incident restore point in ~10 minutes — destroying exactly the
// history the user would want to recover from.
//
// So: one restore point per INCIDENT. Latched after a successful recovery
// snapshot, cleared by the first bookmark sync that blocks nothing. A failed
// write leaves the latch clear so the next cycle retries.

export async function getRecoverySnapshotTaken(): Promise<boolean> {
  return get<boolean>(KEYS.RECOVERY_SNAPSHOT, false);
}

export async function setRecoverySnapshotTaken(taken: boolean): Promise<void> {
  await set(KEYS.RECOVERY_SNAPSHOT, taken);
}

// ─── Sync lock (CO-4) ─────────────────────────────────────────────────────────
// A persisted, TTL'd lock so a sync interrupted by an MV3 worker suspension can't
// leave a later wake double-running (belt-and-braces with the in-memory isSyncing,
// which only guards within a single worker instance). A stale lock (older than the
// TTL) is ignored, so a crashed sync self-heals rather than blocking forever.

export async function acquireSyncLock(ttlMs: number): Promise<boolean> {
  const now = Date.now();
  const lockedAt = await get<number>(KEYS.SYNC_LOCK, 0);
  if (lockedAt && now - lockedAt < ttlMs) return false; // a fresh lock is held
  await set(KEYS.SYNC_LOCK, now);
  return true;
}

export async function releaseSyncLock(): Promise<void> {
  await set(KEYS.SYNC_LOCK, 0);
}

/**
 * Drop a lock left behind by a worker that died mid-sync, reporting whether one was
 * actually held. Called from the service worker's startup recovery.
 *
 * On a fresh worker any lock is stale BY DEFINITION: MV3 runs one worker at a time and
 * tears the entire JS context down, so nothing can still be holding it — which is also
 * why this doesn't consult the TTL. Without it the lock sat there for its full 2 minutes
 * while every sync returned early, including the manual "Sync now", and still reported
 * success.
 */
export async function clearStaleSyncLock(): Promise<boolean> {
  const lockedAt = await get<number>(KEYS.SYNC_LOCK, 0);
  if (!lockedAt) return false;
  await set(KEYS.SYNC_LOCK, 0);
  return true;
}

// ─── Remote sessions (one per peer device) ──────────────────────────────────

/**
 * Normalizes the `konode_remote_sessions` value into an array, newest first.
 * Accepts the current device-keyed map, the legacy single-object shape, and
 * empty/undefined. Pure so the popup can use it synchronously after a
 * `chrome.storage.local.get` callback.
 */
export function normalizeRemoteSessions(raw: unknown): RemoteSessionEntry[] {
  if (!raw || typeof raw !== "object") return [];
  // Legacy single-object shape: { device_id, timestamp, session }
  if ("session" in (raw as Record<string, unknown>)) {
    const entry = raw as RemoteSessionEntry;
    return entry.session?.tabs?.length ? [entry] : [];
  }
  // Current map shape: { [device_id]: RemoteSessionEntry }
  return Object.values(raw as Record<string, RemoteSessionEntry>)
    .filter((e) => e?.session?.tabs?.length)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

export async function getRemoteSessions(): Promise<RemoteSessionEntry[]> {
  const r = await browser.storage.local.get(KEYS.REMOTE_SESSIONS);
  return normalizeRemoteSessions(r[KEYS.REMOTE_SESSIONS]);
}

/** Upserts one peer's session into the device-keyed map (upgrades legacy shape). */
export async function setRemoteSession(entry: RemoteSessionEntry): Promise<void> {
  const r = await browser.storage.local.get(KEYS.REMOTE_SESSIONS);
  const cur = r[KEYS.REMOTE_SESSIONS] as Record<string, RemoteSessionEntry> | undefined;
  const map: Record<string, RemoteSessionEntry> =
    cur && typeof cur === "object" && !("session" in cur) ? { ...cur } : {};
  map[entry.device_id] = entry;
  await set(KEYS.REMOTE_SESSIONS, map);
}

// ─── Remote extensions (aggregated across all peers) ────────────────────────

/**
 * Normalizes the `konode_remote_extensions` value into a **deduped union** of every
 * peer device's installed-extension list (first occurrence per id wins). Accepts the
 * current device-keyed map, the legacy single-object shape, and empty/undefined.
 * Pure so the popup can use it synchronously after a `chrome.storage.local.get`.
 */
export function normalizeRemoteExtensions(raw: unknown): SyncExtension[] {
  if (!raw || typeof raw !== "object") return [];
  const entries: RemoteExtensionEntry[] =
    "extensions" in (raw as Record<string, unknown>)
      ? [raw as RemoteExtensionEntry] // legacy single-object shape
      : Object.values(raw as Record<string, RemoteExtensionEntry>); // device-keyed map
  const byId = new Map<string, SyncExtension>();
  for (const entry of entries) {
    for (const ext of entry?.extensions ?? []) {
      // Rebuild storeUrl locally rather than trusting the peer's value. The whole
      // entry is persisted verbatim from a peer's packet — which, with E2EE off,
      // anyone with backend write access can forge — and the popup opens storeUrl
      // in a tab / the options page links to it. A forged storeUrl is a phishing
      // vector; storeUrlFor() pins the host to the Web Store (chrome, by id) or
      // Firefox Add-ons (firefox, by name search), so at worst a bogus value yields
      // a dead but same-host link. Also stamp the inferred source store.
      if (ext?.id && !byId.has(ext.id)) {
        const store = inferStore(ext);
        byId.set(ext.id, { ...ext, store, storeUrl: storeUrlFor({ id: ext.id, name: ext.name, store }) });
      }
    }
  }
  return [...byId.values()];
}

/** Upserts one peer's extension list into the device-keyed map (upgrades legacy shape). */
export async function setRemoteExtensions(entry: RemoteExtensionEntry): Promise<void> {
  const r = await browser.storage.local.get(KEYS.REMOTE_EXTENSIONS);
  const cur = r[KEYS.REMOTE_EXTENSIONS] as Record<string, RemoteExtensionEntry> | undefined;
  const map: Record<string, RemoteExtensionEntry> =
    cur && typeof cur === "object" && !("extensions" in cur) ? { ...cur } : {};
  map[entry.device_id] = entry;
  await set(KEYS.REMOTE_EXTENSIONS, map);
}

// ─── Upload de-dup (skip re-uploading unchanged data) ───────────────────────

/** Checksum of the payload this device last uploaded for a data type, if any. */
export async function getLastUploadChecksum(dataType: DataType): Promise<string | null> {
  const r = await browser.storage.local.get(KEYS.UPLOAD_CHECKSUMS);
  return (r[KEYS.UPLOAD_CHECKSUMS] as Record<string, string> | undefined)?.[dataType] ?? null;
}

export async function setLastUploadChecksum(dataType: DataType, checksum: string): Promise<void> {
  const r = await browser.storage.local.get(KEYS.UPLOAD_CHECKSUMS);
  const map = { ...((r[KEYS.UPLOAD_CHECKSUMS] as Record<string, string>) ?? {}), [dataType]: checksum };
  await set(KEYS.UPLOAD_CHECKSUMS, map);
}

/**
 * Forget every "last uploaded" checksum so the next sync re-uploads all data types.
 * Called when encryption is toggled or the passphrase changes: the checksum is over
 * the *plaintext* payload, so an encryption change alone wouldn't otherwise trigger a
 * re-upload — the device's own file would keep sitting on the backend in its previous
 * (e.g. plaintext) form even though E2EE is now on.
 */
export async function clearUploadChecksums(): Promise<void> {
  await browser.storage.local.remove(KEYS.UPLOAD_CHECKSUMS);
}

// ─── Pending-conflict packets (parked OUTSIDE konode_state) ─────────────────
// The raw peer packet is what "use remote" needs in order to decrypt, verify and apply
// the version the user picked — so it has to be kept. It just must not live in
// `konode_state`: every setState() rewrites that whole object (several times per sync)
// and every STATE_UPDATE broadcasts it to the popup, so a few hundred KB of bookmark
// tree per conflict turned routine status updates into megabytes of churn.
//
// Keyed by conflict id. The popup only ever renders a conflict's `id` and `data_type`,
// so nothing else needs the bulk.

export async function getConflictPacket(id: string): Promise<SyncPacket | null> {
  const map = await get<Record<string, SyncPacket>>(KEYS.CONFLICT_PACKETS, {});
  return map[id] ?? null;
}

export async function putConflictPacket(id: string, packet: SyncPacket): Promise<void> {
  await updateKey<Record<string, SyncPacket>>(
    KEYS.CONFLICT_PACKETS, (cur) => ({ ...cur, [id]: packet }), {}
  );
}

/** Keep only the packets still backing a pending conflict. Called whenever the pending
 *  list changes, so it covers both resolve-cleanup and any orphan left by an earlier
 *  interruption — the packets are the largest thing this extension stores per conflict. */
export async function pruneConflictPackets(keepIds: string[]): Promise<void> {
  const keep = new Set(keepIds);
  await updateKey<Record<string, SyncPacket>>(KEYS.CONFLICT_PACKETS, (cur) => {
    const next: Record<string, SyncPacket> = {};
    for (const [id, p] of Object.entries(cur)) if (keep.has(id)) next[id] = p;
    return next;
  }, {});
}

// ─── Resolved manual conflicts (make a resolution sticky) ───────────────────
// Under the `manual` strategy the engine queues a conflict per diverging peer.
// Resolving one (keep-local OR keep-remote) doesn't change the *peer's* file on
// the backend, so it still diverges from ours next cycle — without this record the
// same conflict re-queues and re-notifies forever. We remember the peer CHECKSUM we
// resolved against, keyed by `${data_type}:${device_id}`; the queue loop skips a peer
// whose current checksum still matches. If the peer's data genuinely changes later,
// its checksum changes, this record no longer matches, and a fresh conflict surfaces.
// Bounded by peer-count × data-types (tiny), so no GC needed.

export async function getResolvedConflicts(): Promise<Record<string, string>> {
  return get<Record<string, string>>(KEYS.RESOLVED_CONFLICTS, {});
}

export async function setResolvedConflict(key: string, checksum: string): Promise<void> {
  const map = { ...(await getResolvedConflicts()), [key]: checksum };
  await set(KEYS.RESOLVED_CONFLICTS, map);
}

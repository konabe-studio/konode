import type {
  DataType,
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
  device_id: crypto.randomUUID(),
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
};

export const DEFAULT_STATE: SyncState = {
  status: "idle",
  last_sync: null,
  last_error: null,
  pending_conflicts: [],
  sync_counts: { bookmarks: 0, history: 0, sessions: 0, extensions: 0 },
  bytes_transferred: 0,
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
  HIST_IMPORTED: "konode_hist_imported",
  REMOTE_SESSIONS: "konode_remote_sessions",
  REMOTE_EXTENSIONS: "konode_remote_extensions",
  UPLOAD_CHECKSUMS: "konode_upload_checksums",
  RESOLVED_CONFLICTS: "konode_resolved_conflicts",
  SYNC_LOCK: "konode_sync_lock",
  GDRIVE_SESSION: "konode_gdrive_session",
} as const;

// ─── Generic Helpers ───────────────────────────────────────────────────────

async function get<T>(key: string, fallback: T): Promise<T> {
  const result = await browser.storage.local.get(key);
  return (result[key] as T) ?? fallback;
}

async function set(key: string, value: unknown): Promise<void> {
  await browser.storage.local.set({ [key]: value });
}

// ─── Settings ──────────────────────────────────────────────────────────────

export async function getSettings(): Promise<SyncSettings> {
  // Merge over defaults so a settings object saved by an older build (missing a
  // newly-added field like bulk_delete_percent) still gets a sane value.
  const stored = await get<Partial<SyncSettings>>(KEYS.SETTINGS, DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
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
  const log = await get<AuditEntry[]>(KEYS.AUDIT_LOG, []);
  log.unshift(entry);
  // Keep last 200 entries
  await set(KEYS.AUDIT_LOG, log.slice(0, 200));
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
  const current = await get<string[]>(KEYS.HIST_IMPORTED, []);
  const seen = new Set(current);
  const merged = [...current];
  for (const u of urls) if (!seen.has(u)) { seen.add(u); merged.push(u); }
  // FIFO cap to bound storage. Dropping the oldest can at worst let one very old
  // imported URL be re-exported once — it won't perpetually resurrect.
  const capped = merged.length > HIST_IMPORTED_CAP ? merged.slice(-HIST_IMPORTED_CAP) : merged;
  await set(KEYS.HIST_IMPORTED, capped);
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
      if (ext?.id && !byId.has(ext.id)) byId.set(ext.id, ext);
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

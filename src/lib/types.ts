// ─── Core Types ────────────────────────────────────────────────────────────

export type DataType = "bookmarks" | "history" | "sessions" | "extensions";
export type BackendType = "gdrive" | "webdav" | "github";
export type SyncStatus = "idle" | "syncing" | "success" | "error" | "conflict";
export type ConflictStrategy = "lww" | "prefer-local" | "prefer-remote" | "manual";

// ─── Sync Packet ───────────────────────────────────────────────────────────

export interface SyncPacket {
  version: "1.0";
  device_id: string;
  /**
   * The human-readable name of the device that wrote this, so a peer can list devices by
   * something other than a UUID.
   *
   * Optional: a packet from an older build carries none, and the reader falls back to a
   * shortened id. Nothing keys off it — the file name and every identity check use
   * device_id — so a rename never orphans a file. It travelled only inside the sessions
   * payload before, which meant a device with Sessions turned off was nameless to its peers.
   */
  device_label?: string;
  timestamp: string; // ISO-8601
  data_type: DataType;
  checksum: string; // SHA-256 hex of the plaintext payload
  encrypted: boolean;
  payload: string; // JSON string, optionally encrypted
  // LEGACY (read-only): packets from older builds carry a passphrase verifier
  // (createKeyVerifier) that peers check for a clearer mismatch error. It is no
  // longer WRITTEN — a known-plaintext verifier on third-party storage is an
  // offline brute-force oracle on the passphrase; a mismatch now surfaces via the
  // payload's GCM decrypt failure instead. Absent on plaintext + current packets.
  verifier?: string;
}

// ─── Bookmark ──────────────────────────────────────────────────────────────

export interface SyncBookmark {
  id: string;
  parentId: string | null;
  title: string;
  url?: string;
  dateAdded: number;
  children?: SyncBookmark[];
  _deleted?: boolean;
}

// A deletion marker so a removed bookmark propagates (and doesn't resurrect from
// a peer that still has it). Keyed by URL since merge is URL-based.
export interface Tombstone {
  url: string;
  deletedAt: number; // epoch ms
}

// A move marker: a URL was last (re)placed into its folder at `at`. Lets bookmark
// MOVES propagate with last-write-wins (folders have no stable identity, and a
// move keeps the URL but changes its parent — which the URL-keyed merge ignores).
export interface MoveRecord {
  url: string;
  at: number; // epoch ms
}

// A folder-reposition marker. Folders carry no URL, so the URL-keyed MoveRecord
// can't describe a folder that was reordered among its siblings. `path` is the
// browser-agnostic identity — `[rootKind, ...ancestorTitles, folderTitle]` (e.g.
// ["bar","Work","Docs"]). Propagated with LWW like MoveRecord. Only pure reorders
// (same parent) are recorded; a cross-parent folder move relocates its bookmarks
// via the URL move-log and the emptied shell is cleaned up on the receiver.
//
// Placement is ANCHOR-based, not absolute: `prev`/`next` are the keys of the
// siblings immediately before/after the folder at move time (a bookmark → `u:<url>`,
// a folder → `f:<title>`), so the receiver positions the folder relative to a shared
// sibling — an absolute index doesn't translate when the two devices have different
// (device-local) siblings. `index` is kept only as a last-resort fallback when
// neither anchor exists locally.
/**
 * LWW record of a bookmark's TITLE, keyed by URL — the same identity the rest of the
 * bookmark sync uses. The tree already carries titles; what was missing was any way to
 * decide WHOSE title is newer, so the merge had no basis to overwrite one and simply
 * never did.
 */
export interface TitleRecord {
  url: string;
  title: string;
  at: number; // epoch ms
}

/**
 * A folder rename, recorded as an OPERATION (from → to) rather than as a state.
 *
 * A folder has no cross-device id: its identity IS its path, i.e. its title and its
 * ancestors' titles. So a rename changes the very key a state record would be filed
 * under, and the receiver would see an unrelated folder appear rather than a rename.
 * Recording the operation keeps both ends of the change, so the receiver can find the
 * folder it already has and rename it in place.
 */
export interface FolderRenameRecord {
  path: string[]; // the PARENT's path: [rootKind, …ancestorTitles]
  from: string;
  to: string;
  at: number; // epoch ms
}

export interface FolderMoveRecord {
  path: string[];
  index: number;   // fallback only (absolute position on the source device)
  at: number;      // epoch ms
  prev?: string;   // sibling key immediately before the folder (undefined = it's first)
  next?: string;   // sibling key immediately after the folder (undefined = it's last)
}

// Bookmark sync payload: the live tree plus the device's deletion log.
// (Older packets are a bare SyncBookmark[] — handled for backward compatibility.)
export interface BookmarkPayload {
  tree: SyncBookmark[];
  tombstones: Tombstone[];
  moves?: MoveRecord[]; // optional for back-compat with packets written before move-sync
  folderMoves?: FolderMoveRecord[]; // optional for back-compat (added with folder-reorder sync)
  titles?: TitleRecord[]; // optional for back-compat (added with rename sync)
  folderRenames?: FolderRenameRecord[]; // optional for back-compat (added with rename sync)
}

// ─── History ───────────────────────────────────────────────────────────────

export interface SyncHistoryItem {
  url: string;
  title?: string;
  lastVisitTime: number;
  visitCount: number;
  _deleted?: boolean;
}

// ─── Session ───────────────────────────────────────────────────────────────

export interface SyncSession {
  id: string;
  device_id: string;
  savedAt: string;
  label?: string;
  tabs: Array<{
    url: string;
    title?: string;
    pinned: boolean;
    favIconUrl?: string;
  }>;
}

/** A peer device's stored session, keyed by device_id in `konode_remote_sessions`. */
export interface RemoteSessionEntry {
  device_id: string;
  timestamp: string; // ISO-8601, from SyncPacket.timestamp
  session: SyncSession;
}

// ─── Extension ─────────────────────────────────────────────────────────────

export interface SyncExtension {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  homepageUrl?: string;
  storeUrl: string; // a host-pinned store link: CWS listing (chrome) or AMO search (firefox)
  description?: string;
  type: "extension" | "theme" | "app";
  // Source browser/store. Extension ids don't cross stores, so this + the name/
  // homepage drive cross-browser matching. Optional for legacy packets (inferred).
  store?: "chrome" | "firefox";
}

/** A peer device's stored extension list, keyed by device_id in `konode_remote_extensions`. */
export interface RemoteExtensionEntry {
  device_id: string;
  timestamp: string; // ISO-8601, from SyncPacket.timestamp
  extensions: SyncExtension[];
}

export interface BackendConfig {
  type: BackendType;
  label: string;
  enabled: boolean;
  // Google Drive
  gdrive?: {
    folderId?: string;
  };
  // WebDAV (Nextcloud, pCloud, Synology, etc.)
  webdav?: {
    url: string;
    username: string;
    password: string;
    path?: string; // subfolder, default "konode"
  };
  // GitHub
  github?: {
    token?: string;
    repo?: string; // "owner/repo"
    branch?: string;
    path?: string; // subfolder in repo, default "konode"
  };
}

// ─── Extension Settings ────────────────────────────────────────────────────

export interface SyncSettings {
  device_id: string;
  device_label: string;
  enabled_types: DataType[];
  backends: BackendConfig[];
  active_backend: BackendType | null;
  sync_interval_seconds: number; // default: 60
  conflict_strategy: ConflictStrategy;
  history_days_limit: number; // default: 30
  // Safety net: the bookmark merge refuses a peer deletion that would remove more
  // than this % of local bookmarks (guards against a corrupt/oversized tombstone
  // log wiping the tree). Default 60; raise it if you routinely delete in bulk.
  bulk_delete_percent: number;
  auto_sync: boolean;
  sync_on_change: boolean;       // trigger sync immediately on bookmark change
  notifications_enabled: boolean;
  debug_mode: boolean;
  // E2EE (opt-in) — wired into the sync engine; see src/lib/crypto/encryption.ts
  encryption_enabled: boolean;
  encryption_passphrase?: string; // device-local only: never uploaded, never leaves chrome.storage.local
  // True once the user has finished first-run setup (onboarding wizard, or a first
  // working config in Options). Gates the "Finish setting up Konode" card so it never
  // reappears while the user browses provider cards after they're already set up.
  onboarding_completed?: boolean;
}

// ─── Sync State ────────────────────────────────────────────────────────────

export interface SyncState {
  status: SyncStatus;
  last_sync: string | null; // ISO-8601
  last_error: string | null;
  pending_conflicts: ConflictItem[];
  sync_counts: Record<DataType, number>;
  bytes_transferred: number;
  // Set when the mass-delete guard blocked an unusual peer deletion on the last sync
  // (and an auto-snapshot was saved). Cleared at the start of each sync. `blocked` is
  // how many local bookmarks the guard refused to remove.
  recovery_notice?: { at: string; blocked: number } | null;
}

/**
 * A queued manual conflict. Deliberately METADATA ONLY — it lives in `konode_state`,
 * which every setState() rewrites in full and every STATE_UPDATE broadcasts to the
 * popup. The peer's raw packet is parked in `konode_conflict_packets` instead (see
 * getConflictPacket), keyed by `id`.
 *
 * The three payload fields below are LEGACY, read-only: older builds inlined the full
 * local tree, the full remote tree AND the raw packet here — the same data up to three
 * times, per conflict, in the object rewritten on every status change. `local_version`
 * was never read by anything at all. They're still accepted so a conflict queued by an
 * older build can still be resolved; nothing writes them.
 */
export interface ConflictItem {
  id: string;
  data_type: DataType;
  device_id: string; // the peer this conflict is against (dedupe key; correct map key on apply)
  local_version?: unknown;
  remote_version?: unknown;
  remote_packet?: SyncPacket;
  timestamp: string;
  resolved: boolean;
}

// ─── Backend Interface ─────────────────────────────────────────────────────

export interface IBackend {
  type: BackendType;
  isConfigured(): boolean;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  upload(packet: SyncPacket): Promise<void>;
  // All peer packets, excluding the caller's own file — so the engine can merge
  // across every device, not just one. Order is not significant: the engine sorts
  // newest-first by packet timestamp (`orderPeersByTime`), so backends may return
  // files in any order (e.g. directory-listing order).
  downloadAll(data_type: DataType, excludeDeviceId?: string): Promise<SyncPacket[]>;
  listVersions(data_type: DataType): Promise<string[]>;
  testConnection(): Promise<{ ok: boolean; message: string }>;
  // ── Generic named-file ops on the Konode folder ──────────────────────────
  // Used by snapshots (restore points) — files that live alongside the per-device
  // sync files but are invisible to downloadAll (they don't match its
  // `konode_<type>_` prefix). `name` is the basename in the folder; getFile returns
  // null when absent; listFiles returns basenames that start with `prefix`.
  putFile(name: string, content: string): Promise<void>;
  getFile(name: string): Promise<string | null>;
  listFiles(prefix: string): Promise<string[]>;
  deleteFile(name: string): Promise<void>;
}

// ─── Snapshots (bookmark restore points) ────────────────────────────────────

export interface SnapshotMeta {
  name: string;      // backend filename: konode_snap_bookmarks_<epochms>.json
  timestamp: number; // epoch ms (parsed from the filename)
  count?: number;    // bookmark count, from the shared index; absent if unreadable
}

// ─── Message Types (background ↔ popup) ───────────────────────────────────

export type ExtensionMessage =
  | { type: "SYNC_NOW"; payload?: { data_type?: DataType } }
  | { type: "GET_STATE" }
  | { type: "GET_SETTINGS" }
  | { type: "SAVE_SETTINGS"; payload: Partial<SyncSettings> }
  | { type: "RESOLVE_CONFLICT"; payload: { id: string; resolution: "local" | "remote" } }
  | { type: "CLEAR_AUDIT_LOG" }
  | { type: "RESTORE_SESSION"; payload?: { id?: string } }
  | { type: "TEST_BACKEND"; payload: { backend: BackendType } }
  | { type: "CREATE_SNAPSHOT" }
  | { type: "LIST_SNAPSHOTS" }
  | { type: "RESTORE_SNAPSHOT"; payload: { name: string } }
  | { type: "DELETE_SNAPSHOT"; payload: { name: string } };

export type ExtensionResponse =
  | { type: "STATE"; payload: SyncState }
  | { type: "SETTINGS"; payload: SyncSettings }
  | { type: "OK" }
  | { type: "ERROR"; payload: string }
  | { type: "TEST_RESULT"; payload: { ok: boolean; message: string } }
  | { type: "SNAPSHOTS"; payload: SnapshotMeta[] }
  | { type: "SNAPSHOT_RESTORED"; payload: { restored: number } };

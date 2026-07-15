// ─── Core Types ────────────────────────────────────────────────────────────

export type DataType = "bookmarks" | "history" | "sessions" | "extensions";
export type BackendType = "gdrive" | "webdav" | "github";
export type SyncStatus = "idle" | "syncing" | "success" | "error" | "conflict";
export type ConflictStrategy = "lww" | "prefer-local" | "prefer-remote" | "manual";

// ─── Sync Packet ───────────────────────────────────────────────────────────

export interface SyncPacket {
  version: "1.0";
  device_id: string;
  timestamp: string; // ISO-8601
  data_type: DataType;
  checksum: string; // SHA-256 hex of the plaintext payload
  encrypted: boolean;
  payload: string; // JSON string, optionally encrypted
  // When `encrypted`, a passphrase verifier (createKeyVerifier) so a peer can
  // detect a passphrase MISMATCH up front — instead of a decrypt failing silently
  // and the devices diverging. Absent on plaintext packets and legacy files.
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
// ["bar","Work","GDD"]) — and `index` is the folder's new position under its
// parent. Propagated with LWW like MoveRecord. Only pure reorders (same parent)
// are recorded; a cross-parent folder move relocates its bookmarks via the URL
// move-log and the emptied shell is cleaned up on the receiver.
export interface FolderMoveRecord {
  path: string[];
  index: number;
  at: number; // epoch ms
}

// Bookmark sync payload: the live tree plus the device's deletion log.
// (Older packets are a bare SyncBookmark[] — handled for backward compatibility.)
export interface BookmarkPayload {
  tree: SyncBookmark[];
  tombstones: Tombstone[];
  moves?: MoveRecord[]; // optional for back-compat with packets written before move-sync
  folderMoves?: FolderMoveRecord[]; // optional for back-compat (added with folder-reorder sync)
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
  storeUrl: string; // Chrome Web Store URL
  description?: string;
  type: "extension" | "theme" | "app";
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
}

// ─── Sync State ────────────────────────────────────────────────────────────

export interface SyncState {
  status: SyncStatus;
  last_sync: string | null; // ISO-8601
  last_error: string | null;
  pending_conflicts: ConflictItem[];
  sync_counts: Record<DataType, number>;
  bytes_transferred: number;
}

export interface ConflictItem {
  id: string;
  data_type: DataType;
  device_id: string; // the peer this conflict is against (dedupe key; correct map key on apply)
  local_version: unknown;
  remote_version: unknown;
  remote_packet?: SyncPacket; // raw remote packet, so "use remote" can decrypt + apply
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
}

// ─── Message Types (background ↔ popup) ───────────────────────────────────

export type ExtensionMessage =
  | { type: "SYNC_NOW"; payload?: { data_type?: DataType } }
  | { type: "GET_STATE" }
  | { type: "GET_SETTINGS" }
  | { type: "SAVE_SETTINGS"; payload: Partial<SyncSettings> }
  | { type: "RESOLVE_CONFLICT"; payload: { id: string; resolution: "local" | "remote" } }
  | { type: "CLEAR_HISTORY" }
  | { type: "RESTORE_SESSION"; payload?: { id?: string } }
  | { type: "SET_EXTENSION_ENABLED"; payload: { id: string; enabled: boolean } }
  | { type: "TEST_BACKEND"; payload: { backend: BackendType } };

export type ExtensionResponse =
  | { type: "STATE"; payload: SyncState }
  | { type: "SETTINGS"; payload: SyncSettings }
  | { type: "OK" }
  | { type: "ERROR"; payload: string }
  | { type: "TEST_RESULT"; payload: { ok: boolean; message: string } };

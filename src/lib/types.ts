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
  checksum: string; // SHA-256 of payload
  encrypted: boolean;
  payload: string; // JSON string, optionally encrypted
}

// ─── Bookmark ──────────────────────────────────────────────────────────────

export interface SyncBookmark {
  id: string;
  parentId: string | null;
  title: string;
  url?: string;
  dateAdded: number;
  dateModified?: number;
  children?: SyncBookmark[];
  _deleted?: boolean;
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
    path?: string; // subfolder, default "synkro"
  };
  // GitHub
  github?: {
    token?: string;
    repo?: string; // "owner/repo"
    branch?: string;
    path?: string; // subfolder in repo, default "synkro"
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
  auto_sync: boolean;
  sync_on_change: boolean;       // trigger sync immediately on bookmark change
  notifications_enabled: boolean;
  debug_mode: boolean;
  // E2EE — Sprint 2
  encryption_enabled: boolean;
  encryption_key_hash?: string; // bcrypt hash to verify key without storing it
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
  local_version: unknown;
  remote_version: unknown;
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
  download(data_type: DataType, since?: string): Promise<SyncPacket | null>;
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
  | { type: "TEST_BACKEND"; payload: { backend: BackendType } };

export type ExtensionResponse =
  | { type: "STATE"; payload: SyncState }
  | { type: "SETTINGS"; payload: SyncSettings }
  | { type: "OK" }
  | { type: "ERROR"; payload: string }
  | { type: "TEST_RESULT"; payload: { ok: boolean; message: string } };

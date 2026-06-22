import type {
  RemoteExtensionEntry,
  RemoteSessionEntry,
  SyncExtension,
  SyncSettings,
  SyncState,
  Tombstone,
} from "@/lib/types";

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
  enabled_types: ["bookmarks", "extensions"],
  backends: [],
  active_backend: null,
  sync_interval_seconds: 60,
  conflict_strategy: "lww",
  history_days_limit: 30,
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

const KEYS = {
  SETTINGS: "synkro_settings",
  STATE: "synkro_state",
  AUDIT_LOG: "synkro_audit",
  BOOKMARK_CACHE: "synkro_bm_cache",
  BOOKMARK_TOMBSTONES: "synkro_bm_tombstones",
  HISTORY_CACHE: "synkro_hist_cache",
  TAB_CACHE: "synkro_tab_cache",
  REMOTE_SESSIONS: "synkro_remote_sessions",
  REMOTE_EXTENSIONS: "synkro_remote_extensions",
} as const;

// ─── Generic Helpers ───────────────────────────────────────────────────────

async function get<T>(key: string, fallback: T): Promise<T> {
  const result = await chrome.storage.local.get(key);
  return (result[key] as T) ?? fallback;
}

async function set(key: string, value: unknown): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

// ─── Settings ──────────────────────────────────────────────────────────────

export async function getSettings(): Promise<SyncSettings> {
  return get<SyncSettings>(KEYS.SETTINGS, DEFAULT_SETTINGS);
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

export async function getAuditLog(): Promise<AuditEntry[]> {
  return get<AuditEntry[]>(KEYS.AUDIT_LOG, []);
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

export async function getTabCache<T>(): Promise<T | null> {
  return get<T | null>(KEYS.TAB_CACHE, null);
}

export async function setTabCache<T>(data: T): Promise<void> {
  await set(KEYS.TAB_CACHE, data);
}

// ─── Remote sessions (one per peer device) ──────────────────────────────────

/**
 * Normalizes the `synkro_remote_sessions` value into an array, newest first.
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
  const r = await chrome.storage.local.get(KEYS.REMOTE_SESSIONS);
  return normalizeRemoteSessions(r[KEYS.REMOTE_SESSIONS]);
}

/** Upserts one peer's session into the device-keyed map (upgrades legacy shape). */
export async function setRemoteSession(entry: RemoteSessionEntry): Promise<void> {
  const r = await chrome.storage.local.get(KEYS.REMOTE_SESSIONS);
  const cur = r[KEYS.REMOTE_SESSIONS] as Record<string, RemoteSessionEntry> | undefined;
  const map: Record<string, RemoteSessionEntry> =
    cur && typeof cur === "object" && !("session" in cur) ? { ...cur } : {};
  map[entry.device_id] = entry;
  await set(KEYS.REMOTE_SESSIONS, map);
}

// ─── Remote extensions (aggregated across all peers) ────────────────────────

/**
 * Normalizes the `synkro_remote_extensions` value into a **deduped union** of every
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
  const r = await chrome.storage.local.get(KEYS.REMOTE_EXTENSIONS);
  const cur = r[KEYS.REMOTE_EXTENSIONS] as Record<string, RemoteExtensionEntry> | undefined;
  const map: Record<string, RemoteExtensionEntry> =
    cur && typeof cur === "object" && !("extensions" in cur) ? { ...cur } : {};
  map[entry.device_id] = entry;
  await set(KEYS.REMOTE_EXTENSIONS, map);
}

import type { SyncSettings, SyncState } from "@/lib/types";

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
  HISTORY_CACHE: "synkro_hist_cache",
  TAB_CACHE: "synkro_tab_cache",
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

export async function getTabCache<T>(): Promise<T | null> {
  return get<T | null>(KEYS.TAB_CACHE, null);
}

export async function setTabCache<T>(data: T): Promise<void> {
  await set(KEYS.TAB_CACHE, data);
}

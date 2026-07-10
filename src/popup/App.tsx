import { useEffect, useState, useCallback, useRef } from "react";
import type { SyncState, SyncSettings, DataType, SyncExtension, RemoteSessionEntry } from "@/lib/types";
import { sendMessage } from "@/lib/utils/messaging";
import { KEYS, normalizeRemoteSessions, normalizeRemoteExtensions } from "@/lib/utils/storage";
import { STATE_UPDATE } from "@/lib/constants";
import { AuditLog } from "./components/AuditLog";
import {
  RefreshCw, Settings, Bookmark, Clock, Globe,
  AlertCircle, Loader2, ChevronRight,
  Wifi, Puzzle, ExternalLink, GitMerge, RotateCcw,
} from "lucide-react";

// ─── Constants ────────────────────────────────────────────────────────────

const DATA_TYPE_META: Record<DataType, { label: string; icon: typeof Bookmark }> = {
  bookmarks:  { label: "Bookmarks",  icon: Bookmark },
  history:    { label: "History",    icon: Clock    },
  sessions:   { label: "Sessions",   icon: Globe    },
  extensions: { label: "Extensions", icon: Puzzle   },
};

const STATUS_CONFIG = {
  idle:     { color: "text-sk-muted",  dot: "bg-sk-subtle", ring: "border-sk-subtle", label: "Ready"    },
  syncing:  { color: "text-sk-text",   dot: "bg-sk-signal", ring: "border-sk-signal", label: "Syncing…" },
  success:  { color: "text-sk-text",   dot: "bg-sk-signal", ring: "border-sk-signal", label: "Synced"   },
  error:    { color: "text-sk-danger", dot: "bg-sk-danger", ring: "border-sk-danger", label: "Error"    },
  conflict: { color: "text-sk-warn",   dot: "bg-sk-warn",   ring: "border-sk-warn",   label: "Conflict" },
};

const SYNC_ORDER: DataType[] = ["bookmarks", "history", "sessions", "extensions"];

// ─── App ──────────────────────────────────────────────────────────────────

export default function PopupApp() {
  const [state, setState]       = useState<SyncState | null>(null);
  const [settings, setSettings] = useState<SyncSettings | null>(null);
  const [syncingType, setSyncingType]   = useState<DataType | null>(null);
  const [syncedTypes, setSyncedTypes]   = useState<Set<DataType>>(new Set());
  const [missingExtensions, setMissingExtensions] = useState<SyncExtension[]>([]);
  const [remoteSessions, setRemoteSessions] = useState<RemoteSessionEntry[]>([]);
  const [loadError, setLoadError] = useState(false);

  // Track animation state separately from sync state
  const animTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevStatusRef = useRef<string>("__init__");

  const load = useCallback(async () => {
    try {
      const [stateRes, settingsRes] = await Promise.all([
        sendMessage({ type: "GET_STATE" }),
        sendMessage({ type: "GET_SETTINGS" }),
      ]);
      if (stateRes.type === "STATE") setState(stateRes.payload);
      if (settingsRes.type === "SETTINGS") setSettings(settingsRes.payload);
      setLoadError(false);
    } catch (err) {
      console.error("Popup load error:", err);
      setLoadError(true);
    }
  }, []);

  // Start the per-type animation
  const startAnimation = useCallback((enabledTypes: DataType[]) => {
    if (animTimerRef.current) clearInterval(animTimerRef.current);

    const types = SYNC_ORDER.filter((t) => enabledTypes.includes(t));
    if (!types.length) return;

    let idx = 0;
    setSyncingType(types[0]);
    setSyncedTypes(new Set());

    animTimerRef.current = setInterval(() => {
      idx++;
      if (idx < types.length) {
        setSyncedTypes((prev) => new Set([...prev, types[idx - 1]]));
        setSyncingType(types[idx]);
      } else {
        setSyncedTypes(new Set(types));
        setSyncingType(null);
        if (animTimerRef.current) clearInterval(animTimerRef.current);
      }
    }, 600);
  }, []);

  // Stop animation and mark all done
  const stopAnimation = useCallback(() => {
    if (animTimerRef.current) clearInterval(animTimerRef.current);
    setSyncingType(null);
    setSyncedTypes(new Set());
  }, []);

  useEffect(() => {
    load();

    chrome.storage.local.get(KEYS.REMOTE_EXTENSIONS, (r) => {
      // Union of every peer device's extension list (deduped by id).
      const remote = normalizeRemoteExtensions(r[KEYS.REMOTE_EXTENSIONS]);
      if (!remote.length) return;
      // "management" is an optional permission now — only query if it was granted.
      chrome.permissions.contains({ permissions: ["management"] }, (hasMgmt) => {
        if (!hasMgmt) return;
        chrome.management.getAll((local) => {
          const localIds = new Set(local.map((e) => e.id));
          setMissingExtensions(
            remote.filter((e) => !localIds.has(e.id) && e.type === "extension")
          );
        });
      });
    });

    chrome.storage.local.get(KEYS.REMOTE_SESSIONS, (r) => {
      setRemoteSessions(normalizeRemoteSessions(r[KEYS.REMOTE_SESSIONS]));
    });

    return () => {
      if (animTimerRef.current) clearInterval(animTimerRef.current);
    };
  }, [load]);

  // React to state changes — drive animation from status
  useEffect(() => {
    if (!state) return;

    const prevStatus = prevStatusRef.current;
    const currStatus = state.status;

    // On initial load (prevStatus is "idle" sentinel)
    if (prevStatus === "__init__") {
      prevStatusRef.current = currStatus;
      // If state was stuck as "syncing" (e.g. crashed mid-sync), reset animation
      if (currStatus !== "syncing") {
        stopAnimation();
      }
      return;
    }

    prevStatusRef.current = currStatus;

    // Sync just started
    if (currStatus === "syncing" && prevStatus !== "syncing") {
      const enabled = settings?.enabled_types ?? SYNC_ORDER;
      startAnimation(enabled);
    }

    // Sync just finished
    if (prevStatus === "syncing" && currStatus !== "syncing") {
      stopAnimation();
      setTimeout(() => setSyncedTypes(new Set()), 1500);
    }
  }, [state?.status, settings?.enabled_types, startAnimation, stopAnimation]);

  // Listen for real-time state updates from background
  useEffect(() => {
    const handler = (msg: { type: string; payload: SyncState }) => {
      if (msg.type === STATE_UPDATE) setState(msg.payload);
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, []);

  const handleSyncNow = async () => {
    await sendMessage({ type: "SYNC_NOW" });
    // State will update via STATE_UPDATE messages from background
  };

  const openOptions = () => chrome.runtime.openOptionsPage();

  const openAllMissing = () => {
    missingExtensions.forEach((ext) => {
      chrome.tabs.create({ url: ext.storeUrl, active: false });
    });
  };

  const resolveConflict = async (id: string, resolution: "local" | "remote") => {
    await sendMessage({ type: "RESOLVE_CONFLICT", payload: { id, resolution } });
    await load();
  };

  const restoreSession = async (id: string) => {
    await sendMessage({ type: "RESTORE_SESSION", payload: { id } });
  };

  const status = state?.status ?? "idle";
  const statusCfg = STATUS_CONFIG[status];
  const isSyncing = status === "syncing";
  const hasBackend = !!settings?.active_backend;
  const lastSync = state?.last_sync
    ? new Date(state.last_sync).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;
  const pulsing = status === "syncing" || status === "success";

  return (
    <div className="flex max-h-[600px] w-[360px] flex-col bg-sk-bg text-sk-text">
      {/* Pinned top — header, status, banners and the primary action stay put while
          the body below scrolls. Chrome caps a popup at ~600px tall, so once the
          (expanded) content exceeds that, only the body region scrolls instead of
          the whole popup pushing its header off the top. */}
      <div className="shrink-0 px-4 pt-4">
      {/* ── Status + settings (the toolbar icon already identifies the popup,
            so the wordmark header is dropped; settings moves to the top-right) ── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="relative flex h-2 w-2 items-center justify-center">
            {pulsing && (
              <span className={`absolute h-2 w-2 rounded-full border-[1.5px] ${statusCfg.ring} animate-synkro-pulse`} />
            )}
            <span className={`h-2 w-2 rounded-full ${statusCfg.dot}`} />
          </span>
          <span className={`text-sm font-medium ${statusCfg.color}`}>{statusCfg.label}</span>
        </div>
        <div className="flex items-center gap-2">
          {lastSync && <span className="font-mono text-[14px] tabular-nums text-sk-muted">{lastSync}</span>}
          <button
            onClick={openOptions}
            aria-label="Settings"
            className="flex h-8 w-8 items-center justify-center rounded-icon text-sk-muted transition-colors hover:bg-sk-raised"
          >
            <Settings size={18} strokeWidth={1.75} />
          </button>
        </div>
      </div>

      {/* ── Banners ── */}
      {(loadError || state?.last_error || (state?.pending_conflicts?.length ?? 0) > 0 || !hasBackend) && (
        <div className="mt-3 space-y-2">
          {loadError && (
            <button
              onClick={load}
              className="flex w-full items-center justify-center gap-2 rounded-box border border-sk-hairline bg-sk-raised px-3 py-2 text-[12px] text-sk-danger transition-colors hover:bg-sk-tint"
            >
              <AlertCircle size={12} /> Couldn't reach Synkro — tap to retry
            </button>
          )}

          {state?.last_error && (
            <div className="flex items-start gap-2 rounded-box border border-sk-hairline bg-sk-raised px-3 py-2">
              <AlertCircle size={12} className="mt-0.5 shrink-0 text-sk-danger" />
              <span className="line-clamp-2 text-[12px] text-sk-danger">{state.last_error}</span>
            </div>
          )}

          {(state?.pending_conflicts?.length ?? 0) > 0 &&
            state!.pending_conflicts.map((c) => (
              <div key={c.id} className="rounded-box border border-sk-hairline bg-sk-raised px-3 py-2">
                <div className="mb-1.5 flex items-center gap-2">
                  <GitMerge size={12} className="shrink-0 text-sk-warn" />
                  <span className="text-[12px] text-sk-warn">Conflict in {c.data_type} — choose a version</span>
                </div>
                <div className="flex gap-1.5">
                  <button
                    onClick={() => resolveConflict(c.id, "local")}
                    className="flex-1 rounded-box border border-sk-hairline bg-sk-surface py-1.5 text-[12px] text-sk-muted transition-colors hover:text-sk-text"
                  >
                    Keep local
                  </button>
                  <button
                    onClick={() => resolveConflict(c.id, "remote")}
                    className="flex-1 rounded-box border border-sk-hairline bg-sk-surface py-1.5 text-[12px] text-sk-muted transition-colors hover:text-sk-text"
                  >
                    Use remote
                  </button>
                </div>
              </div>
            ))}

          {!hasBackend && (
            <button
              onClick={openOptions}
              className="flex w-full items-center justify-between rounded-box border border-sk-hairline bg-sk-raised px-3 py-2 transition-colors hover:bg-sk-tint"
            >
              <span className="flex items-center gap-2 text-sk-warn">
                <Wifi size={12} />
                <span className="text-[12px]">No backend configured</span>
              </span>
              <ChevronRight size={12} className="text-sk-warn" />
            </button>
          )}
        </div>
      )}

      {/* ── Sync now ── */}
      <button
        onClick={handleSyncNow}
        disabled={isSyncing || !hasBackend}
        className={`mt-4 flex h-11 w-full select-none items-center justify-center gap-2 rounded-box text-sm font-medium transition-colors ${
          hasBackend
            ? "bg-sk-signal text-sk-on-signal hover:opacity-90 active:scale-[0.99]"
            : "cursor-not-allowed bg-sk-raised text-sk-subtle"
        } disabled:opacity-60`}
      >
        {isSyncing ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} strokeWidth={2} />}
        {isSyncing ? "Syncing…" : "Sync now"}
      </button>
      </div>

      {/* Scrollable body — the popup grows to fit this; when it would exceed
          Chrome's ~600px ceiling, this region scrolls and the header stays pinned. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
      {/* ── Active streams (live per-type status) ── */}
      <section className="mt-4">
        <h2 className="mb-2 pl-0.5 font-mono text-[12px] font-medium tracking-[0.08em] text-sk-subtle">
          ACTIVE STREAMS
        </h2>
        <div className="grid grid-cols-4 gap-2.5">
          {SYNC_ORDER.map((type) => {
            const meta = DATA_TYPE_META[type];
            const Icon = meta.icon;
            const isEnabled = settings?.enabled_types.includes(type) ?? false;
            const isCurrentlySyncing = syncingType === type;
            const wasSynced = syncedTypes.has(type);
            const isPending = isSyncing && isEnabled && !isCurrentlySyncing && !wasSynced;

            // Green icon = OK; yellow spinner = syncing; subtle = pending/off.
            const iconColor = isCurrentlySyncing
              ? "text-sk-warn"
              : isEnabled && !isPending
                ? "text-sk-signal"
                : "text-sk-subtle";
            const state = isCurrentlySyncing
              ? "syncing"
              : !isEnabled
                ? "off"
                : isPending
                  ? "pending"
                  : "synced";

            return (
              <div
                key={type}
                title={`${meta.label} — ${state}`}
                aria-label={`${meta.label}: ${state}`}
                className={`flex aspect-square items-center justify-center rounded-full border border-sk-hairline bg-sk-tint ${!isEnabled ? "opacity-40" : ""}`}
              >
                {isCurrentlySyncing ? (
                  <Loader2 size={22} className={`animate-spin ${iconColor}`} />
                ) : (
                  <Icon size={22} strokeWidth={1.75} className={iconColor} />
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* ── Missing extensions ── */}
      {missingExtensions.length > 0 && (
        <div className="flex items-center justify-between px-0.5 pb-0.5 pt-[12px]">
          <span className="text-[14px]">
            <span className="font-medium text-sk-warn">{missingExtensions.length}</span> missing extensions
          </span>
          <button
            onClick={openAllMissing}
            className="inline-flex items-center gap-1.5 text-[14px] font-medium text-sk-text hover:underline hover:underline-offset-2"
          >
            Open all
            <ExternalLink size={14} strokeWidth={2} />
          </button>
        </div>
      )}

      {/* ── Restore sessions (one per peer device) ── */}
      {remoteSessions.length > 0 && (
        <section className="mt-4">
          <h2 className="mb-2 pl-0.5 font-mono text-[12px] font-medium tracking-[0.08em] text-sk-subtle">
            SESSIONS FROM OTHER DEVICES
          </h2>
          <div className="space-y-1.5">
            {remoteSessions.map((entry) => (
              <div key={entry.session.id} className="flex items-center gap-2 px-0.5 py-0.5">
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-[14px]">{entry.session.label || "Unknown device"}</span>
                  <span className="font-mono text-[12px] text-sk-subtle">
                    {entry.session.tabs.length} tab{entry.session.tabs.length === 1 ? "" : "s"}
                    {entry.timestamp &&
                      ` · ${new Date(entry.timestamp).toLocaleString([], {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}`}
                  </span>
                </div>
                <button
                  onClick={() => restoreSession(entry.session.id)}
                  className="flex shrink-0 items-center gap-1.5 rounded-box border border-sk-hairline bg-sk-raised px-2.5 py-1.5 text-[12px] text-sk-muted transition-colors hover:text-sk-text"
                >
                  <RotateCcw size={12} /> Restore
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Footer ── */}
      <footer className="mt-3.5 flex items-end justify-between border-t border-sk-hairline pt-3.5">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span className="text-xs text-sk-muted">Backend</span>
            <span className="font-mono text-xs">{settings?.active_backend ?? "—"}</span>
          </div>
          {settings?.device_label && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-sk-muted">Device</span>
              <span className="font-mono text-xs">{settings.device_label}</span>
            </div>
          )}
        </div>
        <button
          onClick={openOptions}
          className="text-[14px] font-medium text-sk-text hover:underline hover:underline-offset-2"
        >
          Configure →
        </button>
      </footer>

      {/* ── Audit log ── */}
      <AuditLog />
      </div>
    </div>
  );
}

import { useEffect, useState, useCallback, useRef } from "react";
import type { SyncState, SyncSettings, DataType, SyncExtension } from "@/lib/types";
import { sendMessage } from "@/lib/utils/messaging";
import {
  RefreshCw, Settings, Bookmark, Clock, Globe,
  CheckCircle2, AlertCircle, Loader2, Radio, ChevronRight,
  Wifi, Puzzle, ExternalLink,
} from "lucide-react";

// ─── Constants ────────────────────────────────────────────────────────────

const DATA_TYPE_META: Record<DataType, { label: string; icon: typeof Bookmark }> = {
  bookmarks:  { label: "Bookmarks",  icon: Bookmark },
  history:    { label: "History",    icon: Clock    },
  sessions:   { label: "Sessions",   icon: Globe    },
  extensions: { label: "Extensions", icon: Puzzle   },
};

const STATUS_CONFIG = {
  idle:     { color: "text-fg-muted",  dot: "bg-fg-subtle",          label: "Ready"    },
  syncing:  { color: "text-warn",      dot: "bg-warn animate-pulse", label: "Syncing…" },
  success:  { color: "text-accent",    dot: "bg-accent",             label: "Synced"   },
  error:    { color: "text-danger",    dot: "bg-danger",             label: "Error"    },
  conflict: { color: "text-warn",      dot: "bg-warn animate-pulse", label: "Conflict" },
};

const SYNC_ORDER: DataType[] = ["bookmarks", "history", "sessions", "extensions"];

// ─── App ──────────────────────────────────────────────────────────────────

export default function PopupApp() {
  const [state, setState]       = useState<SyncState | null>(null);
  const [settings, setSettings] = useState<SyncSettings | null>(null);
  const [syncingType, setSyncingType]   = useState<DataType | null>(null);
  const [syncedTypes, setSyncedTypes]   = useState<Set<DataType>>(new Set());
  const [missingExtensions, setMissingExtensions] = useState<SyncExtension[]>([]);

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
    } catch (err) {
      console.error("Popup load error:", err);
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

    chrome.storage.local.get("synkro_remote_extensions", (r) => {
      const remote = r["synkro_remote_extensions"]?.extensions as SyncExtension[] | undefined;
      if (!remote?.length) return;
      chrome.management.getAll((local) => {
        const localIds = new Set(local.map((e) => e.id));
        setMissingExtensions(
          remote.filter((e) => !localIds.has(e.id) && e.type === "extension")
        );
      });
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
      if (msg.type === "STATE_UPDATE") setState(msg.payload);
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

  const status = state?.status ?? "idle";
  const statusCfg = STATUS_CONFIG[status];
  const isSyncing = status === "syncing";
  const hasBackend = !!settings?.active_backend;
  const lastSync = state?.last_sync
    ? new Date(state.last_sync).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;

  return (
    <div
      className="w-[360px] min-h-[480px] bg-surface-1 flex flex-col"
      style={{ fontFamily: "'DM Sans', sans-serif" }}
    >
      {/* ── Header ── */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded bg-accent/20 flex items-center justify-center">
            <Radio size={12} className="text-accent" />
          </div>
          <span className="text-sm font-semibold tracking-wide text-fg">Synkro</span>
        </div>
        <button
          onClick={openOptions}
          className="p-1.5 rounded-md text-fg-subtle hover:text-fg hover:bg-surface-3 transition-colors"
          aria-label="Settings"
        >
          <Settings size={14} />
        </button>
      </header>

      {/* ── Status + Actions ── */}
      <div className="px-4 py-4 border-b border-border-subtle space-y-3 shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className={`w-1.5 h-1.5 rounded-full ${statusCfg.dot}`} />
            <span className={`text-xs font-medium ${statusCfg.color}`}>{statusCfg.label}</span>
          </div>
          {lastSync && (
            <span className="text-[10px] font-mono text-fg-subtle tabular-nums">{lastSync}</span>
          )}
        </div>

        {state?.last_error && (
          <div className="flex items-start gap-2 bg-danger/10 border border-danger/20 rounded-lg px-3 py-2">
            <AlertCircle size={11} className="text-danger mt-0.5 shrink-0" />
            <span className="text-[11px] text-danger line-clamp-2">{state.last_error}</span>
          </div>
        )}

        {!hasBackend && (
          <button
            onClick={openOptions}
            className="w-full flex items-center justify-between bg-warn/5 border border-warn/20 rounded-lg px-3 py-2 hover:bg-warn/10 transition-colors"
          >
            <div className="flex items-center gap-2 text-warn">
              <Wifi size={11} />
              <span className="text-[11px]">No backend configured</span>
            </div>
            <ChevronRight size={11} className="text-warn/60" />
          </button>
        )}

        <button
          onClick={handleSyncNow}
          disabled={isSyncing || !hasBackend}
          className={`
            w-full flex items-center justify-center gap-2
            py-2.5 rounded-lg text-sm font-medium
            transition-all duration-200 select-none
            ${hasBackend
              ? "bg-accent text-surface-0 hover:bg-accent/90 active:scale-[0.98] shadow-glow-sm"
              : "bg-surface-3 text-fg-subtle cursor-not-allowed"
            }
            disabled:opacity-60
          `}
        >
          {isSyncing
            ? <Loader2 size={14} className="animate-spin" />
            : <RefreshCw size={14} />
          }
          {isSyncing ? "Syncing…" : "Sync Now"}
        </button>
      </div>

      {/* ── Data Streams ── */}
      <div className="px-4 py-3 border-b border-border-subtle flex-1">
        <p className="text-[10px] font-mono text-fg-subtle uppercase tracking-wider mb-2">
          Active Streams
        </p>
        <div className="space-y-0.5">
          {(["bookmarks", "history", "sessions", "extensions"] as DataType[]).map((type) => {
            const meta = DATA_TYPE_META[type];
            const Icon = meta.icon;
            const isEnabled = settings?.enabled_types.includes(type) ?? false;
            const isCurrentlySyncing = syncingType === type;
            const wasSynced = syncedTypes.has(type);
            const isPending = isSyncing && isEnabled && !isCurrentlySyncing && !wasSynced;

            return (
              <div
                key={type}
                className={`
                  flex items-center justify-between px-3 py-2 rounded-md
                  transition-all duration-200
                  ${!isEnabled ? "opacity-35" : ""}
                  ${isCurrentlySyncing ? "bg-accent/10 border border-accent/20" : isEnabled ? "bg-surface-2" : ""}
                `}
              >
                <div className="flex items-center gap-2.5">
                  <Icon
                    size={13}
                    className={
                      isCurrentlySyncing ? "text-accent animate-pulse" :
                      isEnabled ? "text-accent/70" : "text-fg-subtle"
                    }
                  />
                  <span className={`text-xs ${isCurrentlySyncing ? "text-fg font-medium" : "text-fg-muted"}`}>
                    {meta.label}
                  </span>
                  {isCurrentlySyncing && (
                    <span className="text-[10px] text-accent/70 font-mono animate-pulse">syncing…</span>
                  )}
                </div>

                <div className="flex items-center gap-1.5">
                  {isCurrentlySyncing ? (
                    <Loader2 size={11} className="text-accent animate-spin" />
                  ) : wasSynced ? (
                    <CheckCircle2 size={11} className="text-accent" />
                  ) : isPending ? (
                    <Clock size={11} className="text-fg-subtle opacity-40" />
                  ) : isEnabled ? (
                    <CheckCircle2 size={11} className="text-accent/50" />
                  ) : (
                    <div className="w-[11px] h-[11px] rounded-full border border-border-strong" />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Missing extensions ── */}
      {missingExtensions.length > 0 && (
        <div className="px-4 py-2.5 border-b border-border-subtle">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-fg-muted">
              <span className="text-warn font-medium">{missingExtensions.length}</span> missing extensions
            </span>
            <button
              onClick={openAllMissing}
              className="flex items-center gap-1 text-[10px] text-accent hover:text-accent/80 transition-colors"
            >
              <ExternalLink size={10} />
              Open all
            </button>
          </div>
        </div>
      )}

      {/* ── Backend info ── */}
      <div className="px-4 py-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-fg-subtle">Backend</span>
            <span className="text-[10px] font-mono text-fg-muted">
              {settings?.active_backend ?? "—"}
            </span>
          </div>
          <button
            onClick={openOptions}
            className="text-[10px] text-accent/70 hover:text-accent transition-colors"
          >
            Configure →
          </button>
        </div>
        {settings?.device_label && (
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-[10px] text-fg-subtle">Device</span>
            <span className="text-[10px] font-mono text-fg-muted">{settings.device_label}</span>
          </div>
        )}
      </div>
    </div>
  );
}

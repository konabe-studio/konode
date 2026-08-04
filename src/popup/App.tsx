import { useEffect, useState, useCallback, useRef } from "react";
import type { SyncState, SyncSettings, DataType, SyncExtension, RemoteSessionEntry } from "@/lib/types";
import { providerFromConfig, providerById } from "@/lib/storage-providers";
import { sendMessage, request } from "@/lib/utils/messaging";
import { browser, currentStore } from "@/lib/utils/ext";
import { isInstalledLocally, installOrSearchUrl } from "@/lib/utils/extensions-match";
import { KEYS, getSettings, getState, normalizeRemoteSessions, normalizeRemoteExtensions } from "@/lib/utils/storage";
import { STATE_UPDATE } from "@/lib/constants";
import { streamState, streamInputFor, streamColor, streamLabelKey } from "@/popup/stream-state";
import { t, plural } from "@/lib/utils/i18n";
import {
  RefreshCw, Settings, Bookmark, Clock, Globe,
  AlertCircle, Loader2, ChevronRight,
  Wifi, Puzzle, ExternalLink, GitMerge, RotateCcw,
} from "lucide-react";

// ─── Constants ────────────────────────────────────────────────────────────

// Icons are static; the labels are looked up per render so they follow the browser's
// language. Same for STATUS_CONFIG below: the colour classes stay in the table, the
// wording moves out of it.
const DATA_TYPE_META: Record<DataType, { icon: typeof Bookmark }> = {
  bookmarks:  { icon: Bookmark },
  history:    { icon: Clock    },
  sessions:   { icon: Globe    },
  extensions: { icon: Puzzle   },
};

const STATUS_CONFIG = {
  idle:     { color: "text-sk-muted",  dot: "bg-sk-subtle", ring: "border-sk-subtle" },
  syncing:  { color: "text-sk-warn",   dot: "bg-sk-warn",   ring: "border-sk-warn"   },
  success:  { color: "text-sk-text",   dot: "bg-sk-signal", ring: "border-sk-signal" },
  error:    { color: "text-sk-danger", dot: "bg-sk-danger", ring: "border-sk-danger" },
  conflict: { color: "text-sk-warn",   dot: "bg-sk-warn",   ring: "border-sk-warn"   },
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
  // Why the last button press did nothing. Every one of these handlers used to
  // `await sendMessage(...)` and drop the answer, so an ERROR response — "a sync is
  // already running", a peer whose data can't be applied — looked like a dead button.
  const [actionError, setActionError] = useState<string | null>(null);

  // Track animation state separately from sync state
  const animTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevStatusRef = useRef<string>("__init__");

  const load = useCallback(async () => {
    try {
      // Read state + settings DIRECTLY from storage (authoritative + fast). The
      // GET_STATE/GET_SETTINGS messages only round-trip to read the same storage,
      // and on Firefox's non-persistent event page that round-trip can lag while
      // the worker cold-starts — long enough that the popup painted its initial
      // `settings === null` state as "No backend configured", then corrected when
      // the message resolved (the transient flash). Reading storage removes that
      // dependency; the flash is also gated below on `settingsLoaded`.
      const [st, se] = await Promise.all([getState(), getSettings()]);
      setState(st);
      setSettings(se);
      setLoadError(false);
    } catch (err) {
      console.error("Popup load error:", err);
      setLoadError(true);
    }
    // Still wake the background so it (re)inits alarms / clears a stuck "syncing",
    // but don't block the UI on it (fire-and-forget — cold event page is fine).
    void sendMessage({ type: "GET_STATE" }).catch(() => {});
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

    void (async () => {
      const r = await browser.storage.local.get(KEYS.REMOTE_EXTENSIONS);
      // Union of every peer device's extension list (deduped by id).
      const remote = normalizeRemoteExtensions(r[KEYS.REMOTE_EXTENSIONS]);
      if (!remote.length) return;
      // "management" is an optional permission now — only query if it was granted.
      const hasMgmt = await browser.permissions.contains({ permissions: ["management"] });
      if (!hasMgmt) return;
      const local = await browser.management.getAll();
      const here = currentStore();
      // Cross-store the same extension has different ids, so match on id (same
      // store) OR normalized name / homepage host — otherwise every extension on a
      // different-browser peer would show as "missing" here.
      setMissingExtensions(
        remote.filter((e) => e.type === "extension" && !isInstalledLocally(e, local, here))
      );
    })();

    void browser.storage.local.get(KEYS.REMOTE_SESSIONS).then((r) => {
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
    browser.runtime.onMessage.addListener(handler);
    return () => browser.runtime.onMessage.removeListener(handler);
  }, []);

  const handleSyncNow = async () => {
    setActionError(null);
    // The engine reports whether the sync actually started (a stranded lock used to make
    // this a no-op that answered OK). Success still arrives via STATE_UPDATE.
    const r = await request({ type: "SYNC_NOW" });
    if (!r.ok) setActionError(r.error);
  };

  const openOptions = () => browser.runtime.openOptionsPage();

  // The audit log lives in Settings → Activity (a popup is too cramped to scan a
  // long history). The hash selects that tab on load.
  const openActivityLog = () =>
    void browser.tabs.create({ url: browser.runtime.getURL("options.html#activity") });

  const openAllMissing = () => {
    const here = currentStore();
    missingExtensions.forEach((ext) => {
      // Same-store → the direct listing; cross-store → a name search in THIS
      // browser's store (a peer's CWS id can't resolve on Firefox and vice-versa).
      browser.tabs.create({ url: installOrSearchUrl(ext, here), active: false });
    });
  };

  const resolveConflict = async (id: string, resolution: "local" | "remote") => {
    setActionError(null);
    // "Use remote" can legitimately fail — an encrypted peer this device can't read, or
    // a packet that is no longer available. Silently reloading made the click look inert.
    const r = await request({ type: "RESOLVE_CONFLICT", payload: { id, resolution } });
    if (!r.ok) setActionError(r.error);
    await load();
  };

  const restoreSession = async (id: string) => {
    setActionError(null);
    const r = await request({ type: "RESTORE_SESSION", payload: { id } });
    if (!r.ok) setActionError(r.error);
  };

  const status = state?.status ?? "idle";
  const statusCfg = STATUS_CONFIG[status];
  const isSyncing = status === "syncing";
  const settingsLoaded = settings !== null;
  const hasBackend = !!settings?.active_backend;
  // Only treat "no backend" as real once settings have actually loaded — otherwise
  // the first paint (settings still null) flashes a false "No backend configured".
  const showNoBackend = settingsLoaded && !hasBackend;
  const lastSync = state?.last_sync
    ? new Date(state.last_sync).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;
  // Show the chosen provider's name (e.g. "Koofr"), not the raw backend type
  // ("webdav") — several providers map to the WebDAV backend.
  const backendLabel = (() => {
    if (!settings?.active_backend) return t("popup_backend_none");
    const url = settings.backends.find((b) => b.type === "webdav")?.webdav?.url;
    const pid = providerFromConfig(settings.active_backend, url);
    return pid ? providerById(pid).label : settings.active_backend;
  })();
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
              <span className={`absolute h-2 w-2 rounded-full border-[1.5px] ${statusCfg.ring} animate-konode-pulse`} />
            )}
            <span className={`h-2 w-2 rounded-full ${statusCfg.dot}`} />
          </span>
          <span className={`text-sm font-medium ${statusCfg.color}`}>{t(`status_${status}`)}</span>
        </div>
        <div className="flex items-center gap-2">
          {lastSync && <span className="font-mono text-[14px] tabular-nums text-sk-muted">{lastSync}</span>}
          <button
            onClick={openOptions}
            aria-label={t("popup_settings_aria")}
            className="flex h-8 w-8 items-center justify-center rounded-icon text-sk-muted transition-colors hover:bg-sk-raised"
          >
            <Settings size={18} strokeWidth={1.75} />
          </button>
        </div>
      </div>

      {/* ── Banners ── */}
      {(loadError || actionError || state?.last_error || state?.recovery_notice || (state?.pending_conflicts?.length ?? 0) > 0 || showNoBackend) && (
        <div className="mt-3 space-y-2">
          {actionError && (
            <div className="flex items-start gap-2 rounded-box border border-sk-hairline bg-sk-raised px-3 py-2" role="alert">
              <AlertCircle size={12} className="mt-0.5 shrink-0 text-sk-danger" />
              <span className="text-[12px] text-sk-danger">{actionError}</span>
            </div>
          )}
          {state?.recovery_notice && (
            <button
              onClick={openActivityLog}
              className="flex w-full items-start gap-2 rounded-box border border-sk-warn bg-sk-raised px-3 py-2 text-left transition-colors hover:bg-sk-tint"
            >
              <AlertCircle size={12} className="mt-0.5 shrink-0 text-sk-warn" />
              <span className="text-[12px] text-sk-warn">
                {t("popup_recovery_notice", String(state.recovery_notice.blocked))}
              </span>
            </button>
          )}

          {loadError && (
            <button
              onClick={load}
              className="flex w-full items-center justify-center gap-2 rounded-box border border-sk-hairline bg-sk-raised px-3 py-2 text-[12px] text-sk-danger transition-colors hover:bg-sk-tint"
            >
              <AlertCircle size={12} /> {t("popup_load_error")}
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
                  <span className="text-[12px] text-sk-warn">{t("popup_conflict_title", t(`datatype_${c.data_type}`))}</span>
                </div>
                <div className="flex gap-1.5">
                  <button
                    onClick={() => resolveConflict(c.id, "local")}
                    className="flex-1 rounded-box border border-sk-hairline bg-sk-surface py-1.5 text-[12px] text-sk-muted transition-colors hover:text-sk-text"
                  >
                    {t("popup_keep_local")}
                  </button>
                  <button
                    onClick={() => resolveConflict(c.id, "remote")}
                    className="flex-1 rounded-box border border-sk-hairline bg-sk-surface py-1.5 text-[12px] text-sk-muted transition-colors hover:text-sk-text"
                  >
                    {t("popup_use_remote")}
                  </button>
                </div>
              </div>
            ))}

          {showNoBackend && (
            <button
              onClick={openOptions}
              className="flex w-full items-center justify-between rounded-box border border-sk-hairline bg-sk-raised px-3 py-2 transition-colors hover:bg-sk-tint"
            >
              <span className="flex items-center gap-2 text-sk-warn">
                <Wifi size={12} />
                <span className="text-[12px]">{t("popup_no_backend")}</span>
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
        {isSyncing ? t("status_syncing") : t("popup_sync_now")}
      </button>
      </div>

      {/* Scrollable body — the popup grows to fit this; when it would exceed
          Chrome's ~600px ceiling, this region scrolls and the header stays pinned. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
      {/* ── Active streams (live per-type status) ── */}
      <section className="mt-4">
        <h2 className="mb-2 pl-0.5 font-mono text-[12px] font-medium tracking-[0.08em] text-sk-subtle">
          {t("popup_active_streams")}
        </h2>
        <div className="grid grid-cols-4 gap-2.5">
          {SYNC_ORDER.map((type) => {
            const Icon = DATA_TYPE_META[type].icon;
            const typeLabel = t(`datatype_${type}`);
            // Derived in one tested place — see popup/stream-state.ts. Inline, this
            // collapsed to green/"synced" for every enabled type whenever a sync wasn't
            // running, including before the first one and right after a failure.
            const ss = streamState(
              streamInputFor(type, {
                state,
                enabledTypes: settings?.enabled_types,
                syncingType,
                syncedTypes,
              })
            );
            const iconColor = streamColor(ss);

            return (
              <div
                key={type}
                title={`${typeLabel}: ${t(streamLabelKey(ss))}`}
                aria-label={`${typeLabel}: ${t(streamLabelKey(ss))}`}
                className={`flex aspect-square items-center justify-center rounded-full border border-sk-hairline bg-sk-tint ${ss === "off" ? "opacity-40" : ""}`}
              >
                {ss === "syncing" ? (
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
          <span className="text-[14px] font-medium text-sk-warn">
            {plural("popup_missing_extensions", missingExtensions.length)}
          </span>
          <button
            onClick={openAllMissing}
            className="inline-flex items-center gap-1.5 text-[14px] font-medium text-sk-text hover:underline hover:underline-offset-2"
          >
            {t("popup_open_all")}
            <ExternalLink size={14} strokeWidth={2} />
          </button>
        </div>
      )}

      {/* ── Restore sessions (one per peer device) ── */}
      {remoteSessions.length > 0 && (
        <section className="mt-4">
          <h2 className="mb-2 pl-0.5 font-mono text-[12px] font-medium tracking-[0.08em] text-sk-subtle">
            {t("popup_sessions_head")}
          </h2>
          <div className="space-y-1.5">
            {remoteSessions.map((entry) => (
              <div key={entry.session.id} className="flex items-center gap-2 px-0.5 py-0.5">
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-[14px]">{entry.session.label || t("popup_unknown_device")}</span>
                  <span className="font-mono text-[12px] text-sk-subtle">
                    {plural("popup_tabs", entry.session.tabs.length)}
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
                  <RotateCcw size={12} /> {t("popup_restore")}
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
            <span className="text-xs text-sk-muted">{t("popup_backend_label")}</span>
            <span className="text-xs">{backendLabel}</span>
          </div>
          {settings?.device_label && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-sk-muted">{t("popup_device_label")}</span>
              <span className="font-mono text-xs">{settings.device_label}</span>
            </div>
          )}
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <button
            onClick={openOptions}
            className="text-[14px] font-medium text-sk-text hover:underline hover:underline-offset-2"
          >
            {t("popup_configure")}
          </button>
          <button
            onClick={openActivityLog}
            className="text-[12px] text-sk-muted hover:text-sk-text hover:underline hover:underline-offset-2"
          >
            {t("popup_activity_log")}
          </button>
        </div>
      </footer>
      </div>
    </div>
  );
}

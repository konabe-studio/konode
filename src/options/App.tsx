import { useEffect, useState, useCallback } from "react";
import type { SyncSettings, BackendType, DataType, BackendConfig, SyncExtension } from "@/lib/types";
import { sendMessage } from "@/lib/utils/messaging";
import { interactiveSignIn } from "@/lib/backends/gdrive-oauth";
import {
  Cloud, Github, Server, Bookmark, Clock,
  Globe, Puzzle, AlertTriangle, CheckCircle2, XCircle,
  Loader2, ExternalLink, User, LogOut, Eye, EyeOff,
  Radio, Sliders, Shield, Save, Pencil, Key, Copy,
} from "lucide-react";
import { generateRecoveryKey } from "@/lib/crypto/encryption";
import { KEYS, normalizeRemoteExtensions } from "@/lib/utils/storage";
import { CWS_DETAIL_BASE } from "@/lib/constants";

// ─── Secret field ───────────────────────────────────────────────────────────
// Masks a *saved* secret (token / password / passphrase): once a value exists, the
// raw string is no longer bound into the DOM — the field shows a •••• summary until
// the user clicks Replace to enter a new one. The reveal toggle is per-field, so
// unmasking one secret no longer unmasks the others.
//
// `sensitive` = the E2EE passphrase: unlike a rotatable API token / password, the
// passphrase can't be cheaply changed (rotating means re-encrypting + re-keying every
// device), so its summary is fully content-free — no last-4 tail and a fixed dot count
// (no length leak). Screenshots / shoulder-surfing then reveal nothing.
function SecretField({
  value,
  onChange,
  placeholder,
  sensitive = false,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  sensitive?: boolean;
}) {
  const hasSaved = value.length > 0;
  const [editing, setEditing] = useState(!hasSaved);
  const [revealed, setRevealed] = useState(false);
  const [draft, setDraft] = useState("");

  if (hasSaved && !editing) {
    const masked = sensitive
      ? "•".repeat(12)
      : "•".repeat(Math.min(Math.max(value.length - 4, 8), 24)) + value.slice(-4);
    return (
      <div className="input-pw-wrap input-pw-wrap-2">
        {/* Reveal shows the true value on demand (user-initiated) — the default
            summary stays content-free for the passphrase, so a screenshot leaks
            nothing, but the value is still peekable without having to overwrite it. */}
        <input className="field-input mono" type="text" value={revealed ? value : masked} readOnly tabIndex={-1} />
        <div className="btn-eye-group">
          <button
            className="btn-eye"
            type="button"
            title={revealed ? "Hide" : "Show"}
            onClick={() => setRevealed((v) => !v)}
          >
            {revealed ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
          <button
            className="btn-eye"
            type="button"
            title="Replace"
            onClick={() => { setDraft(""); setRevealed(false); setEditing(true); }}
          >
            <Pencil size={13} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="input-pw-wrap">
      <input
        className="field-input mono"
        type={revealed ? "text" : "password"}
        value={hasSaved ? draft : value}
        onChange={(e) => { setDraft(e.target.value); onChange(e.target.value); }}
        placeholder={placeholder}
        autoComplete="off"
      />
      <button
        className="btn-eye"
        type="button"
        title={revealed ? "Hide" : "Show"}
        onClick={() => setRevealed((v) => !v)}
      >
        {revealed ? <EyeOff size={13} /> : <Eye size={13} />}
      </button>
    </div>
  );
}

// ─── Nav ──────────────────────────────────────────────────────────────────

type NavSection = "backend" | "data" | "device" | "advanced";

const NAV: { id: NavSection; label: string; icon: typeof Server }[] = [
  { id: "backend",  label: "Storage Backend", icon: Server },
  { id: "data",     label: "Data Types",      icon: Bookmark },
  { id: "device",   label: "Device",          icon: Sliders },
  { id: "advanced", label: "Advanced",        icon: Shield },
];

const BACKEND_META: Record<BackendType, { label: string; Icon: typeof Cloud; desc: string }> = {
  gdrive: {
    label: "Google Drive",
    Icon: Cloud,
    desc: "Sync via your Google Drive. OAuth — a short-lived access token is cached on this device only.",
  },
  webdav: {
    label: "WebDAV",
    Icon: Server,
    desc: "Nextcloud, pCloud, Synology, kDrive, ownCloud — any WebDAV server.",
  },
  github: {
    label: "GitHub / Gitea / GitLab",
    Icon: Github,
    desc: "Store sync data in a private repository using a Personal Access Token.",
  },
};

const DATA_TYPE_META: { type: DataType; Icon: typeof Bookmark; label: string; desc: string }[] = [
  { type: "bookmarks",  Icon: Bookmark, label: "Bookmarks",  desc: "Full bookmark tree with folders and ordering." },
  { type: "sessions",   Icon: Globe,    label: "Sessions",   desc: "Named tab sessions you can restore anywhere." },
  { type: "history",    Icon: Clock,    label: "History",    desc: "Browsing history, limited by days setting." },
  { type: "extensions", Icon: Puzzle,   label: "Extensions", desc: "Extension list — shows missing ones with install links." },
];

// ─── App ──────────────────────────────────────────────────────────────────

export default function OptionsApp() {
  const [settings, setSettings]   = useState<SyncSettings | null>(null);
  const [activeNav, setActiveNav] = useState<NavSection>("backend");
  const [saving, setSaving]       = useState(false);
  const [saveOk, setSaveOk]       = useState(false);
  const [testStatus, setTestStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting]     = useState(false);

  // Google Drive
  const [gdriveUser, setGdriveUser]           = useState<{ email: string; displayName: string } | null>(null);
  const [gdriveConnecting, setGdriveConnecting] = useState(false);
  const [gdriveError, setGdriveError]         = useState<string | null>(null);

  // GitHub user info (fetched after token entry)
  const [githubUser, setGithubUser] = useState<{ login: string; name: string } | null>(null);
  const [githubChecking, setGithubChecking] = useState(false);

  // Import/Export
  const [genKey, setGenKey] = useState<string | null>(null);
  // Passphrase confirm (double-entry): a mistyped E2EE passphrase makes data
  // unrecoverable, so a *new* manually-typed passphrase must be re-entered before
  // Save. `initialPass` is what loaded from settings (an untouched passphrase needs
  // no re-confirm); a generated key is exact by construction, so it skips confirm.
  const [initialPass, setInitialPass] = useState("");
  const [passConfirm, setPassConfirm] = useState("");
  // Require an explicit confirmation before disabling E2EE (a downgrade).
  const [confirmDisableEnc, setConfirmDisableEnc] = useState(false);
  const [exportStatus, setExportStatus] = useState<"idle" | "ok" | "error">("idle");
  const [importStatus, setImportStatus] = useState<"idle" | "ok" | "error">("idle");
  const [importCount, setImportCount] = useState(0);

  // Extensions diff
  const [remoteExtensions, setRemoteExtensions] = useState<SyncExtension[] | null>(null);
  const [localExtIds, setLocalExtIds] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    const res = await sendMessage({ type: "GET_SETTINGS" });
    if (res.type === "SETTINGS") {
      setSettings(res.payload);
      setInitialPass(res.payload.encryption_passphrase ?? "");
    }
  }, []);

  useEffect(() => {
    load();
    chrome.storage.local.get(KEYS.GDRIVE_SESSION, (r) => {
      // A stored session means we have a refresh token — show the account
      // regardless of access-token age (it renews silently).
      const s = r[KEYS.GDRIVE_SESSION];
      if (s) setGdriveUser({ email: s.email ?? "", displayName: s.displayName ?? "" });
    });
    chrome.storage.local.get(KEYS.REMOTE_EXTENSIONS, (r) => {
      // Use the normalizer: the value is a device-keyed map now, not the legacy
      // single object — reading `.extensions` off the map returned nothing, so the
      // options "missing on this device" list stayed empty (the popup was correct).
      setRemoteExtensions(normalizeRemoteExtensions(r[KEYS.REMOTE_EXTENSIONS]));
    });
    chrome.management.getAll((exts) => setLocalExtIds(new Set(exts.map((e) => e.id))));
  }, [load]);

  const update = (partial: Partial<SyncSettings>) =>
    setSettings((p) => p ? { ...p, ...partial } : p);

  const updateBackend = (type: BackendType, partial: Partial<BackendConfig>) => {
    if (!settings) return;
    const backends = [...settings.backends];
    const idx = backends.findIndex((b) => b.type === type);
    if (idx >= 0) backends[idx] = { ...backends[idx], ...partial };
    else backends.push({ type, label: BACKEND_META[type].label, enabled: true, ...partial });
    update({ backends });
  };

  const getBackend = (type: BackendType) => settings?.backends.find((b) => b.type === type);

  // #2 double-entry: require a confirm only for a *new*, manually-typed passphrase —
  // not an untouched saved one, and not a generated key (exact by construction).
  const currentPass = settings?.encryption_passphrase ?? "";
  const needsPassConfirm =
    !!settings?.encryption_enabled && currentPass.length > 0 && currentPass !== initialPass && currentPass !== genKey;
  const passMismatch = needsPassConfirm && passConfirm !== currentPass;

  // WebDAV hits an arbitrary user host that isn't in host_permissions, so we
  // request it at runtime (optional_host_permissions). Must run inside a user
  // gesture, so call it first — before any await — in the click handlers below.
  const requestWebdavHostPermission = async (): Promise<boolean> => {
    const url = getBackend("webdav")?.webdav?.url;
    if (!url) return false;
    try {
      const origin = new URL(url).origin + "/*";
      return await chrome.permissions.request({ origins: [origin] });
    } catch {
      return false;
    }
  };

  const save = async () => {
    if (!settings) return;
    if (passMismatch) {
      setTestStatus({ ok: false, message: "The two passphrases don't match — re-enter to confirm before saving." });
      return;
    }
    if (settings.active_backend === "webdav") {
      const granted = await requestWebdavHostPermission();
      if (!granted) {
        setTestStatus({ ok: false, message: "Permission to access the WebDAV server was not granted." });
        return;
      }
    }
    setSaving(true);
    await sendMessage({ type: "SAVE_SETTINGS", payload: settings });
    setSaving(false); setSaveOk(true);
    setTimeout(() => setSaveOk(false), 2500);
  };

  const testBackend = async () => {
    if (!settings?.active_backend) return;
    if (settings.active_backend === "webdav") {
      const granted = await requestWebdavHostPermission();
      if (!granted) {
        setTestStatus({ ok: false, message: "Permission to access the WebDAV server was not granted." });
        return;
      }
    }
    setTesting(true); setTestStatus(null);
    const res = await sendMessage({ type: "TEST_BACKEND", payload: { backend: settings.active_backend } });
    if (res.type === "TEST_RESULT") setTestStatus(res.payload);
    setTesting(false);
  };

  // history/tabs/management are optional permissions now — request them on enable
  // so the install-time prompt stays minimal (and the CWS review stays clean).
  const PERM_FOR_TYPE: Partial<Record<DataType, string>> = {
    history: "history",
    sessions: "tabs",
    extensions: "management",
  };

  const toggleDataType = async (type: DataType) => {
    if (!settings) return;
    const enabling = !settings.enabled_types.includes(type);
    if (enabling) {
      const perm = PERM_FOR_TYPE[type];
      if (perm) {
        const granted = await chrome.permissions.request({ permissions: [perm] });
        if (!granted) return; // leave it off if the user declined the permission
      }
    }
    const next = enabling
      ? [...settings.enabled_types, type]
      : settings.enabled_types.filter((t) => t !== type);
    update({ enabled_types: next });
  };

  // ─── Google Drive OAuth ────────────────────────────────────────────────

  const connectGDrive = async () => {
    setGdriveConnecting(true); setGdriveError(null);
    try {
      // One interactive consent (PKCE auth-code) → stores a refresh token, so
      // background sync renews silently afterwards. See lib/backends/gdrive-oauth.
      const s = await interactiveSignIn();
      setGdriveUser({ email: s.email, displayName: s.displayName });
      update({ active_backend: "gdrive" });
    } catch (err) {
      setGdriveError(err instanceof Error ? err.message : "Connection failed");
    } finally {
      setGdriveConnecting(false);
    }
  };

  const disconnectGDrive = () => {
    chrome.storage.local.remove(KEYS.GDRIVE_SESSION);
    setGdriveUser(null);
    if (settings?.active_backend === "gdrive") update({ active_backend: null });
  };

  // ─── Export ───────────────────────────────────────────────────────────

  const exportData = async () => {
    setExportStatus("idle");
    try {
      // Collect all syncable data
      const [bookmarkTree, extensions, historyItems] = await Promise.all([
        chrome.bookmarks.getTree(),
        new Promise<chrome.management.ExtensionInfo[]>((r) => chrome.management.getAll(r)),
        chrome.history.search({ text: "", startTime: Date.now() - 30 * 24 * 60 * 60 * 1000, maxResults: 5000 }),
      ]);

      const bundle = {
        version: "1.0",
        exportedAt: new Date().toISOString(),
        device: settings?.device_label ?? "unknown",
        data: {
          bookmarks: bookmarkTree,
          extensions: extensions
            .filter(e => e.id !== chrome.runtime.id && e.installType !== "other" && e.installType !== "admin")
            .map(e => ({ id: e.id, name: e.name, version: e.version, enabled: e.enabled, storeUrl: `${CWS_DETAIL_BASE}${e.id}` })),
          history: historyItems.map(h => ({ url: h.url, title: h.title, lastVisitTime: h.lastVisitTime, visitCount: h.visitCount })),
        },
      };

      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `synkro-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setExportStatus("ok");
      setTimeout(() => setExportStatus("idle"), 3000);
    } catch {
      setExportStatus("error");
      setTimeout(() => setExportStatus("idle"), 2000);
    }
  };

  const importData = async (file: File) => {
    setImportStatus("idle");
    try {
      const text = await file.text();
      const bundle = JSON.parse(text);

      // Support both old format (bundle.bookmarks) and new (bundle.data.bookmarks)
      const data = bundle.data ?? bundle;

      if (!bundle.version) throw new Error("Invalid Synkro backup file");

      let imported = 0;

      // Import bookmarks
      if (data.bookmarks) {
        const roots = (await chrome.bookmarks.getTree())[0]?.children ?? [];
        const other = roots.find(r => r.id === "2") ?? roots[1];

        if (other) {
          const importFolder = await chrome.bookmarks.create({
            parentId: other.id,
            title: `Synkro Import ${new Date().toLocaleDateString()}`,
          });

          const walk = async (nodes: chrome.bookmarks.BookmarkTreeNode[], parentId: string) => {
            for (const node of nodes) {
              if (node.url) {
                try { await chrome.bookmarks.create({ parentId, title: node.title, url: node.url }); imported++; } catch { /* skip invalid */ }
              } else if (node.children) {
                const f = await chrome.bookmarks.create({ parentId, title: node.title });
                await walk(node.children, f.id);
              }
            }
          };

          // Handle both raw tree and wrapped tree
          const bookmarkData = Array.isArray(data.bookmarks) ? data.bookmarks : [data.bookmarks];
          for (const root of bookmarkData) {
            if (root.children) await walk(root.children, importFolder.id);
          }
        }
      }

      // Import history
      if (Array.isArray(data.history)) {
        for (const item of data.history) {
          if (item.url) try { await chrome.history.addUrl({ url: item.url }); } catch { /* skip */ }
        }
      }

      setImportStatus("ok");
      setImportCount(imported);
      setTimeout(() => { setImportStatus("idle"); setImportCount(0); }, 4000);
    } catch {
      setImportStatus("error");
      setTimeout(() => setImportStatus("idle"), 3000);
    }
  };

  // ─── GitHub PAT verify ────────────────────────────────────────────────

  const verifyGithubToken = async (token: string) => {
    if (!token) { setGithubUser(null); return; }
    setGithubChecking(true);
    try {
      const res = await fetch("https://api.github.com/user", {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      });
      if (res.ok) {
        const d = await res.json();
        setGithubUser({ login: d.login, name: d.name ?? d.login });
      } else {
        setGithubUser(null);
      }
    } catch { setGithubUser(null); }
    setGithubChecking(false);
  };

  if (!settings) {
    return (
      <div className="settings-root">
        <style>{STYLES}</style>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", width: "100%" }}>
          <Loader2 size={20} className="spin" style={{ color: "var(--accent)" }} />
        </div>
      </div>
    );
  }

  const missingExtensions = remoteExtensions?.filter(
    (e) => !localExtIds.has(e.id) && e.type === "extension"
  ) ?? [];

  return (
    <div className="settings-root">
      <style>{STYLES}</style>

      {/* ── Sidebar ── */}
      <nav className="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-logo"><Radio size={14} /></div>
          <span className="sidebar-title">Synkro</span>
        </div>
        <ul className="nav-list">
          {NAV.map(({ id, label, icon: Icon }) => (
            <li key={id}>
              <button
                className={`nav-item ${activeNav === id ? "active" : ""}`}
                onClick={() => setActiveNav(id)}
              >
                <Icon size={16} />
                <span>{label}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>

      {/* ── Content ── */}
      <main className="content">
        <div className="content-inner">

          {/* ── BACKEND ── */}
          {activeNav === "backend" && (
            <div className="section-wrap">
              <h1 className="page-title">Storage Backend</h1>
              <p className="page-subtitle">Choose where your sync data is stored. Your data never touches our servers.</p>

              <div className="card-list">
                {(["gdrive", "webdav", "github"] as BackendType[]).map((type) => {
                  const { label, Icon, desc } = BACKEND_META[type];
                  const isActive = settings.active_backend === type;

                  return (
                    <div
                      key={type}
                      className={`backend-card ${isActive ? "selected" : ""}`}
                      role="button"
                      tabIndex={0}
                      aria-pressed={isActive}
                      aria-label={`Use ${label}`}
                      onClick={() => update({ active_backend: type })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          update({ active_backend: type });
                        }
                      }}
                    >
                      <div className="backend-card-header">
                        <div className="backend-icon-wrap"><Icon size={17} /></div>
                        <div className="backend-info">
                          <div className="backend-name">
                            {label}
                            {isActive && <span className="badge-active">active</span>}
                          </div>
                          <div className="backend-desc">{desc}</div>
                        </div>
                        <div className={`radio-circle ${isActive ? "checked" : ""}`} />
                      </div>

                      {/* ── Google Drive ── */}
                      {isActive && type === "gdrive" && (
                        <div className="backend-config" onClick={(e) => e.stopPropagation()}>
                          {gdriveUser ? (
                            <div className="account-row">
                              <div className="account-avatar"><User size={14} /></div>
                              <div className="account-info">
                                <div className="account-name">{gdriveUser.displayName}</div>
                                <div className="account-email">{gdriveUser.email}</div>
                              </div>
                              <button className="btn-disconnect" onClick={disconnectGDrive}>
                                <LogOut size={12} /> Disconnect
                              </button>
                            </div>
                          ) : (
                            <div>
                              <button className="btn-connect-google" onClick={connectGDrive} disabled={gdriveConnecting}>
                                {gdriveConnecting ? <Loader2 size={14} className="spin" /> : (
                                  <svg width="15" height="15" viewBox="0 0 24 24">
                                    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                                    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                                    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                                    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                                  </svg>
                                )}
                                {gdriveConnecting ? "Connecting…" : "Sign in with Google"}
                              </button>
                              {gdriveError && <div className="error-row"><XCircle size={11} /> {gdriveError}</div>}
                              <p className="config-hint">Only <code>drive.file</code> scope — Synkro can only access files it creates.</p>
                            </div>
                          )}
                          {gdriveUser && (
                            <div className="field-group">
                              <label className="field-label">Drive Folder ID <span className="optional">(optional)</span></label>
                              <input
                                className="field-input"
                                value={getBackend("gdrive")?.gdrive?.folderId ?? ""}
                                onChange={(e) => updateBackend("gdrive", { gdrive: { folderId: e.target.value } })}
                                placeholder="Leave blank — auto-creates a 'Synkro' folder"
                              />
                            </div>
                          )}
                        </div>
                      )}

                      {/* ── WebDAV ── */}
                      {isActive && type === "webdav" && (
                        <div className="backend-config" onClick={(e) => e.stopPropagation()}>
                          <div className="field-group">
                            <label className="field-label">Server URL</label>
                            <input
                              className="field-input mono"
                              value={getBackend("webdav")?.webdav?.url ?? ""}
                              onChange={(e) => updateBackend("webdav", { webdav: { ...getBackend("webdav")?.webdav, url: e.target.value } as any })}
                              placeholder="https://cloud.example.com/remote.php/dav/files/username/"
                            />
                          </div>
                          <div className="field-row-2">
                            <div className="field-group" style={{ flex: 1 }}>
                              <label className="field-label">Username</label>
                              <input
                                className="field-input mono"
                                value={getBackend("webdav")?.webdav?.username ?? ""}
                                onChange={(e) => updateBackend("webdav", { webdav: { ...getBackend("webdav")?.webdav, username: e.target.value } as any })}
                                placeholder="username"
                                autoComplete="off"
                              />
                            </div>
                            <div className="field-group" style={{ flex: 1 }}>
                              <label className="field-label">Password / App token</label>
                              <SecretField
                                value={getBackend("webdav")?.webdav?.password ?? ""}
                                placeholder="••••••••"
                                onChange={(v) => updateBackend("webdav", { webdav: { ...getBackend("webdav")?.webdav, password: v } as any })}
                              />
                            </div>
                          </div>
                          <p className="config-hint">
                            For Nextcloud, use an App Password from Settings → Security.
                          </p>
                          {(() => {
                            const u = getBackend("webdav")?.webdav?.url ?? "";
                            return /^http:\/\//i.test(u) && !/^http:\/\/(localhost|127\.)/i.test(u);
                          })() && (
                            <div className="error-row">
                              <AlertTriangle size={11} /> This is an <code>http://</code> URL — your password would be sent unencrypted. Use <code>https://</code>.
                            </div>
                          )}
                        </div>
                      )}

                      {/* ── GitHub PAT ── */}
                      {isActive && type === "github" && (
                        <div className="backend-config" onClick={(e) => e.stopPropagation()}>
                          <div className="field-group">
                            <label className="field-label">Personal Access Token</label>
                            <SecretField
                              value={getBackend("github")?.github?.token ?? ""}
                              placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                              onChange={async (v) => {
                                updateBackend("github", { github: { ...getBackend("github")?.github, token: v } });
                                if (v.length > 10) await verifyGithubToken(v);
                              }}
                            />
                            {githubChecking && <div className="verify-row"><Loader2 size={11} className="spin" /> Verifying…</div>}
                            {githubUser && !githubChecking && (
                              <div className="verify-row ok"><CheckCircle2 size={11} /> @{githubUser.login} — {githubUser.name}</div>
                            )}
                          </div>
                          <div className="field-row-2">
                            <div className="field-group" style={{ flex: 2 }}>
                              <label className="field-label">Repository</label>
                              <input
                                className="field-input mono"
                                value={getBackend("github")?.github?.repo ?? ""}
                                onChange={(e) => updateBackend("github", { github: { ...getBackend("github")?.github, repo: e.target.value } })}
                                placeholder="username/repo-name"
                              />
                            </div>
                            <div className="field-group" style={{ flex: 1 }}>
                              <label className="field-label">Branch</label>
                              <input
                                className="field-input mono"
                                value={getBackend("github")?.github?.branch ?? "main"}
                                onChange={(e) => updateBackend("github", { github: { ...getBackend("github")?.github, branch: e.target.value } })}
                                placeholder="main"
                              />
                            </div>
                          </div>
                          <a
                            href="https://github.com/settings/personal-access-tokens/new"
                            target="_blank" rel="noreferrer"
                            className="link-external"
                          >
                            <ExternalLink size={11} /> Create a fine-grained token (only this repo · Contents: Read &amp; Write)
                          </a>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Test + Save row */}
              <div className="action-row">
                <button className={`btn-save ${saveOk ? "saved" : ""}`} onClick={save} disabled={saving}>
                  {saving ? <Loader2 size={13} className="spin" /> : saveOk ? <CheckCircle2 size={13} /> : <Save size={13} />}
                  {saving ? "Saving…" : saveOk ? "Saved" : "Save changes"}
                </button>
                {settings.active_backend && (
                  <div className="test-group">
                    {testStatus && (
                      <span className={`test-result ${testStatus.ok ? "ok" : "fail"}`}>
                        {testStatus.ok ? <CheckCircle2 size={11} /> : <XCircle size={11} />}
                        {testStatus.message}
                      </span>
                    )}
                    <button className="btn-secondary" onClick={testBackend} disabled={testing}>
                      {testing ? <Loader2 size={12} className="spin" /> : <CheckCircle2 size={12} />}
                      Test Connection
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── DATA TYPES ── */}
          {activeNav === "data" && (
            <div className="section-wrap">
              <h1 className="page-title">Data Types</h1>
              <p className="page-subtitle">Choose what gets synced across your devices.</p>

              <div className="settings-section">
                {DATA_TYPE_META.map(({ type, Icon, label, desc }) => (
                  <div key={type} className="settings-row">
                    <div className="settings-row-left">
                      <Icon size={16} className="row-icon" />
                      <div>
                        <div className="row-label">{label}</div>
                        <div className="row-desc">{desc}</div>
                      </div>
                    </div>
                    <label className="toggle-wrap">
                      <input type="checkbox" className="toggle-input"
                        checked={settings.enabled_types.includes(type)}
                        onChange={() => toggleDataType(type)} />
                      <span className="toggle-track"><span className="toggle-thumb" /></span>
                    </label>
                  </div>
                ))}
              </div>

              <h2 className="section-title">History</h2>
              <div className="settings-section">
                <div className="settings-row">
                  <div className="settings-row-left">
                    <div>
                      <div className="row-label">Days to sync</div>
                      <div className="row-desc">Recommended: 30 days.</div>
                    </div>
                  </div>
                  <div className="slider-wrap">
                    <input type="range" min={7} max={365} step={1}
                      value={settings.history_days_limit}
                      onChange={(e) => update({ history_days_limit: Number(e.target.value) })}
                      className="slider" />
                    <span className="slider-val">{settings.history_days_limit}d</span>
                  </div>
                </div>
              </div>

              {missingExtensions.length > 0 && (
                <>
                  <h2 className="section-title">Missing extensions ({missingExtensions.length})</h2>
                  <div className="settings-section">
                    {missingExtensions.map((ext) => (
                      <div key={ext.id} className="settings-row">
                        <div className="settings-row-left">
                          <Puzzle size={15} className="row-icon" />
                          <div>
                            <div className="row-label">{ext.name}</div>
                            {ext.description && <div className="row-desc">{ext.description.slice(0, 80)}</div>}
                          </div>
                        </div>
                        <a href={ext.storeUrl} target="_blank" rel="noreferrer" className="btn-install">Install</a>
                      </div>
                    ))}
                  </div>
                </>
              )}

              <div className="notice-warn">
                <AlertTriangle size={13} />
                <div>
                  <strong>Password sync not available.</strong>{" "}
                  Chrome extensions cannot access the native password store. Use{" "}
                  <a href="https://bitwarden.com" target="_blank" rel="noreferrer">Bitwarden</a> or{" "}
                  <a href="https://proton.me/pass" target="_blank" rel="noreferrer">Proton Pass</a> for self-hosted password sync.
                </div>
              </div>

              <div className="action-row" style={{ marginTop: 20 }}>
                <button className={`btn-save ${saveOk ? "saved" : ""}`} onClick={save} disabled={saving}>
                  {saving ? <Loader2 size={13} className="spin" /> : saveOk ? <CheckCircle2 size={13} /> : <Save size={13} />}
                  {saving ? "Saving…" : saveOk ? "Saved" : "Save changes"}
                </button>
              </div>
            </div>
          )}

          {/* ── DEVICE ── */}
          {activeNav === "device" && (
            <div className="section-wrap">
              <h1 className="page-title">Device</h1>
              <p className="page-subtitle">Identify this device in the sync network.</p>

              <h2 className="section-title">Identity</h2>
              <div className="settings-section">
                <div className="settings-row">
                  <div className="settings-row-left">
                    <div>
                      <div className="row-label">Device name</div>
                      <div className="row-desc">How this device appears in sync logs.</div>
                    </div>
                  </div>
                  <input className="field-input-inline"
                    value={settings.device_label}
                    onChange={(e) => update({ device_label: e.target.value })}
                    placeholder="My Laptop" />
                </div>
                <div className="settings-row">
                  <div className="settings-row-left">
                    <div>
                      <div className="row-label">Device ID</div>
                      <div className="row-desc">Auto-generated. Do not change.</div>
                    </div>
                  </div>
                  <span className="mono-value">{settings.device_id.slice(0, 16)}…</span>
                </div>
              </div>

              <h2 className="section-title">Sync behaviour</h2>
              <div className="settings-section">
                <div className="settings-row">
                  <div className="settings-row-left">
                    <div><div className="row-label">Sync on change</div><div className="row-desc">Instantly sync bookmarks and tabs when they change. Recommended.</div></div>
                  </div>
                  <label className="toggle-wrap">
                    <input type="checkbox" className="toggle-input" checked={settings.sync_on_change ?? true}
                      onChange={(e) => update({ sync_on_change: e.target.checked })} />
                    <span className="toggle-track"><span className="toggle-thumb" /></span>
                  </label>
                </div>
                <div className="settings-row">
                  <div className="settings-row-left">
                    <div><div className="row-label">Auto sync</div><div className="row-desc">Also sync on a regular schedule.</div></div>
                  </div>
                  <label className="toggle-wrap">
                    <input type="checkbox" className="toggle-input" checked={settings.auto_sync}
                      onChange={(e) => update({ auto_sync: e.target.checked })} />
                    <span className="toggle-track"><span className="toggle-thumb" /></span>
                  </label>
                </div>
                <div className="settings-row">
                  <div className="settings-row-left">
                    <div><div className="row-label">Notifications</div><div className="row-desc">Sync status and conflict alerts.</div></div>
                  </div>
                  <label className="toggle-wrap">
                    <input type="checkbox" className="toggle-input" checked={settings.notifications_enabled}
                      onChange={(e) => update({ notifications_enabled: e.target.checked })} />
                    <span className="toggle-track"><span className="toggle-thumb" /></span>
                  </label>
                </div>
                <div className="settings-row">
                  <div className="settings-row-left">
                    <div><div className="row-label">Sync interval</div><div className="row-desc">How often this device pulls remote changes. 30s is the browser's minimum for background checks. Your own changes upload almost instantly.</div></div>
                  </div>
                  <div className="slider-wrap">
                    <input type="range" min={30} max={600} step={30}
                      value={settings.sync_interval_seconds}
                      onChange={(e) => update({ sync_interval_seconds: Number(e.target.value) })}
                      className="slider" />
                    <span className="slider-val">{settings.sync_interval_seconds}s</span>
                  </div>
                </div>
              </div>

              <h2 className="section-title">Conflict resolution</h2>
              <div className="settings-section">
                {([
                  { value: "lww",           label: "Last Write Wins",  desc: "Most recent change always wins." },
                  { value: "prefer-local",  label: "Prefer Local",     desc: "Local changes override remote." },
                  { value: "prefer-remote", label: "Prefer Remote",    desc: "Remote changes override local." },
                  { value: "manual",        label: "Manual",           desc: "Ask me to resolve each conflict in the popup." },
                ] as const).map(({ value, label, desc }) => (
                  <label key={value} className="settings-row radio-row">
                    <div className="settings-row-left">
                      <div><div className="row-label">{label}</div><div className="row-desc">{desc}</div></div>
                    </div>
                    <input type="radio" name="conflict" className="native-radio"
                      value={value} checked={settings.conflict_strategy === value}
                      onChange={() => update({ conflict_strategy: value })} />
                  </label>
                ))}
              </div>

              <div className="action-row" style={{ marginTop: 20 }}>
                <button className={`btn-save ${saveOk ? "saved" : ""}`} onClick={save} disabled={saving}>
                  {saving ? <Loader2 size={13} className="spin" /> : saveOk ? <CheckCircle2 size={13} /> : <Save size={13} />}
                  {saving ? "Saving…" : saveOk ? "Saved" : "Save changes"}
                </button>
              </div>
            </div>
          )}

          {/* ── ADVANCED ── */}
          {activeNav === "advanced" && (
            <div className="section-wrap">
              <h1 className="page-title">Advanced</h1>
              <p className="page-subtitle">Encryption and developer options.</p>

              <h2 className="section-title">Import / Export</h2>
              <div className="settings-section">
                <div className="settings-row">
                  <div className="settings-row-left">
                    <div>
                      <div className="row-label">Export backup</div>
                      <div className="row-desc">Download bookmarks, history, and extensions as a JSON file. No cloud needed.</div>
                    </div>
                  </div>
                  <button className="btn-secondary" onClick={exportData}>
                    {exportStatus === "ok" ? <><CheckCircle2 size={12} /> Exported</> :
                     exportStatus === "error" ? <><XCircle size={12} /> Failed</> :
                     "Export"}
                  </button>
                </div>
                <div className="settings-row">
                  <div className="settings-row-left">
                    <div>
                      <div className="row-label">Import backup</div>
                      <div className="row-desc">
                        {importStatus === "ok"
                          ? `✓ Imported ${importCount} bookmarks into "Synkro Import" folder.`
                          : importStatus === "error"
                          ? "Invalid or unsupported file format."
                          : "Restore from a Synkro JSON backup. Bookmarks added to a new folder."}
                      </div>
                    </div>
                  </div>
                  <label className="btn-secondary" style={{ cursor: "pointer" }}>
                    {importStatus === "ok" ? <><CheckCircle2 size={12} /> Done</> :
                     importStatus === "error" ? <><XCircle size={12} /> Error</> :
                     "Import"}
                    <input
                      type="file" accept=".json" style={{ display: "none" }}
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) importData(f); e.target.value = ""; }}
                    />
                  </label>
                </div>
              </div>

              <h2 className="section-title">Encryption</h2>
              <div className="settings-section">
                <div className="settings-row">
                  <div className="settings-row-left">
                    <div>
                      <div className="row-label">End-to-End Encryption</div>
                      <div className="row-desc">
                        AES-256-GCM. Data is encrypted with your passphrase before it leaves this
                        device, so the storage provider can never read it. Keep the passphrase safe —
                        without it, encrypted data can't be recovered, and every device must use the same one.
                      </div>
                    </div>
                  </div>
                  <label className="toggle-wrap">
                    <input type="checkbox" className="toggle-input"
                      checked={settings.encryption_enabled}
                      onChange={(e) => {
                        const next = e.target.checked;
                        // Turning E2EE OFF is a downgrade — the next sync re-uploads
                        // this device's data unencrypted. Require an explicit confirm
                        // (don't flip the toggle yet) so it can't be switched off by a
                        // stray click. Turning it on needs no confirm.
                        if (!next && (settings.encryption_passphrase ?? "").length > 0) {
                          setConfirmDisableEnc(true);
                        } else {
                          update({ encryption_enabled: next });
                        }
                      }} />
                    <span className="toggle-track"><span className="toggle-thumb" /></span>
                  </label>
                </div>
                {confirmDisableEnc && (
                  <div className="settings-row" style={{ paddingTop: 0 }}>
                    <div className="settings-row-left">
                      <div className="row-desc" style={{ color: "var(--danger)" }}>
                        Turn off encryption? Your synced data will be stored <b>unencrypted</b> on your
                        backend from the next sync on. Every device must then also turn it off.
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                      <button className="btn-secondary" type="button" onClick={() => setConfirmDisableEnc(false)}>
                        Cancel
                      </button>
                      <button
                        className="btn-secondary"
                        type="button"
                        style={{ color: "var(--danger)", borderColor: "var(--danger)" }}
                        onClick={() => { update({ encryption_enabled: false }); setConfirmDisableEnc(false); }}
                      >
                        Turn off
                      </button>
                    </div>
                  </div>
                )}
                {settings.encryption_enabled && (
                  <div className="settings-row">
                    <div className="settings-row-left">
                      <div>
                        <div className="row-label">Passphrase</div>
                        <div className="row-desc">Derives the encryption key. Stored only on this device, never uploaded.</div>
                      </div>
                    </div>
                    <div style={{ width: 220 }}>
                      <SecretField
                        value={settings.encryption_passphrase ?? ""}
                        placeholder="Choose a strong passphrase"
                        sensitive
                        onChange={(v) => update({ encryption_passphrase: v })}
                      />
                      {needsPassConfirm && (
                        <div style={{ marginTop: 8 }}>
                          <input
                            className="field-input mono"
                            type="password"
                            value={passConfirm}
                            placeholder="Confirm passphrase"
                            autoComplete="off"
                            onChange={(e) => setPassConfirm(e.target.value)}
                          />
                          {passMismatch ? (
                            <div className="row-desc" style={{ marginTop: 4, color: "var(--danger)" }}>
                              Passphrases don't match yet.
                            </div>
                          ) : (
                            <div className="row-desc" style={{ marginTop: 4, color: "var(--accent)", display: "flex", alignItems: "center", gap: 4 }}>
                              <CheckCircle2 size={11} style={{ flexShrink: 0 }} /> Passphrases match.
                            </div>
                          )}
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={() => { const k = generateRecoveryKey(); setGenKey(k); update({ encryption_passphrase: k }); }}
                        style={{ marginTop: 8, display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--accent)", background: "none", border: "none", cursor: "pointer", padding: 0 }}>
                        <Key size={12} /> Generate a strong key
                      </button>
                      {genKey && (
                        <div className="row-desc" style={{ marginTop: 8, color: "var(--text-primary)" }}>
                          Save this now — it's the only way to recover your data if you forget it. Enter the same key on your other devices.
                          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                            <code style={{ userSelect: "all", fontSize: 12, wordBreak: "break-all" }}>{genKey}</code>
                            <button type="button" title="Copy" onClick={() => navigator.clipboard?.writeText(genKey)}
                              style={{ background: "none", border: "none", cursor: "pointer", color: "var(--accent)", flexShrink: 0 }}>
                              <Copy size={12} />
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
                {settings.encryption_enabled && !settings.encryption_passphrase && (
                  <div className="settings-row" style={{ paddingTop: 0 }}>
                    <div className="settings-row-left">
                      <div className="row-desc" style={{ color: "var(--danger)" }}>
                        Encryption is on but no passphrase is set — sync keeps uploading plaintext until you add one.
                      </div>
                    </div>
                  </div>
                )}
                {!settings.encryption_enabled && (
                  <div className="settings-row" style={{ paddingTop: 0 }}>
                    <div className="settings-row-left">
                      <AlertTriangle size={14} className="row-icon" style={{ color: "var(--text-secondary)" }} />
                      <div className="row-desc">
                        Encryption is off — your synced data (bookmarks, history, sessions, extensions) is stored
                        <b> unencrypted</b> on your backend. Turn it on to encrypt everything before it leaves this device.
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <h2 className="section-title">Developer</h2>
              <div className="settings-section">
                <div className="settings-row">
                  <div className="settings-row-left">
                    <div><div className="row-label">Debug mode</div><div className="row-desc">Verbose logging to the console.</div></div>
                  </div>
                  <label className="toggle-wrap">
                    <input type="checkbox" className="toggle-input" checked={settings.debug_mode}
                      onChange={(e) => update({ debug_mode: e.target.checked })} />
                    <span className="toggle-track"><span className="toggle-thumb" /></span>
                  </label>
                </div>
              </div>

              <h2 className="section-title">About</h2>
              <div className="settings-section">
                <div className="settings-row">
                  <div className="settings-row-left"><div><div className="row-label">Version</div></div></div>
                  <span className="mono-value">0.1.0</span>
                </div>
                <div className="settings-row">
                  <div className="settings-row-left">
                    <div><div className="row-label">Source code</div><div className="row-desc">No telemetry. No external servers.</div></div>
                  </div>
                  <a href="https://github.com/benstone326/Synkro" target="_blank" rel="noreferrer" className="link-external">
                    <Github size={12} /> GitHub <ExternalLink size={10} />
                  </a>
                </div>
              </div>

              <div className="action-row" style={{ marginTop: 20 }}>
                <button className={`btn-save ${saveOk ? "saved" : ""}`} onClick={save} disabled={saving || passMismatch}>
                  {saving ? <Loader2 size={13} className="spin" /> : saveOk ? <CheckCircle2 size={13} /> : <Save size={13} />}
                  {saving ? "Saving…" : saveOk ? "Saved" : "Save changes"}
                </button>
              </div>
            </div>
          )}

        </div>
      </main>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────

const STYLES = `
  /* No external font fetch — a privacy-first extension shouldn't ping Google
     Fonts on every open. Falls back to the system UI font. */
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --sidebar-w: 200px; --content-max: 736px; --radius: 8px;
    --font: 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    --font-mono: 'JetBrains Mono', 'SF Mono', 'Fira Code', monospace;
    --bg: #f7f8fa; --bg-sidebar: #ffffff; --bg-card: #ffffff; --bg-card-sel: #e7f5ef;
    --bg-hover: #f1f3f5; --bg-input: #ffffff;
    --border: #e6e8eb; --border-input: #d4d8dd;
    --text-primary: #11151a; --text-secondary: #5b6470; --text-disabled: #aab2bd;
    --text-link: #0e9e6e;
    --nav-active-bg: #f1f3f5; --nav-active-text: #11151a; --nav-active-bar: #0e9e6e;
    --accent: #0e9e6e; --accent-hover: #0c8a60; --accent-light: #e7f5ef;
    --toggle-off: #d4d8dd; --toggle-on: #0e9e6e; --toggle-thumb: #ffffff;
    --warn-bg: #fdf4e3; --warn-border: #b7791f; --warn-text: #7a4f08;
    --danger: #dc2626; --success: #0e9e6e;
    --shadow: 0 1px 2px rgba(17,21,26,.05), 0 0 0 1px rgba(17,21,26,.06);
  }

  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1216; --bg-sidebar: #161a20; --bg-card: #161a20; --bg-card-sel: #173a30;
      --bg-hover: #1e232b; --bg-input: #1e232b;
      --border: #2a2f37; --border-input: #353b45;
      --text-primary: #e6e9ee; --text-secondary: #97a0ad; --text-disabled: #6b7480;
      --text-link: #34d399;
      --nav-active-bg: #1e232b; --nav-active-text: #e6e9ee; --nav-active-bar: #34d399;
      --accent: #34d399; --accent-hover: #5ee0b0; --accent-light: #173a30;
      --toggle-off: #353b45; --toggle-on: #34d399;
      --warn-bg: #3a2e10; --warn-border: #f5a524; --warn-text: #f5c97a;
      --danger: #f87171; --success: #34d399;
      --shadow: 0 1px 3px rgba(0,0,0,.35), 0 0 0 1px rgba(255,255,255,.05);
    }
  }

  html, body, #root { height: 100%; background: var(--bg); }
  .settings-root { display: flex; min-height: 100vh; font-family: var(--font); font-size: 13px; color: var(--text-primary); background: var(--bg); -webkit-font-smoothing: antialiased; }

  .sidebar { width: var(--sidebar-w); background: var(--bg-sidebar); border-right: 1px solid var(--border); position: fixed; top: 0; left: 0; height: 100vh; overflow-y: auto; }
  .sidebar-header { display: flex; align-items: center; gap: 10px; padding: 18px 20px 14px; }
  .sidebar-logo { width: 24px; height: 24px; background: var(--accent); border-radius: 6px; display: flex; align-items: center; justify-content: center; color: white; flex-shrink: 0; }
  .sidebar-title { font-size: 15px; font-weight: 600; color: var(--text-primary); }
  .nav-list { list-style: none; padding: 4px 0; }
  .nav-item { display: flex; align-items: center; gap: 14px; width: 100%; padding: 9px 20px; border: none; background: transparent; color: var(--text-secondary); font-family: var(--font); font-size: 13px; cursor: pointer; text-align: left; position: relative; transition: background .1s, color .1s; }
  .nav-item:hover { background: var(--bg-hover); color: var(--text-primary); }
  .nav-item.active { background: var(--nav-active-bg); color: var(--nav-active-text); font-weight: 500; }
  .nav-item.active::before { content: ''; position: absolute; left: 0; top: 4px; bottom: 4px; width: 3px; background: var(--nav-active-bar); border-radius: 0 2px 2px 0; }

  .content { margin-left: var(--sidebar-w); flex: 1; display: flex; justify-content: center; padding: 32px 24px 60px; min-height: 100vh; }
  .content-inner { width: 100%; max-width: var(--content-max); }
  .section-wrap { padding-bottom: 16px; }
  .page-title { font-size: 20px; font-weight: 400; color: var(--text-primary); margin-bottom: 4px; }
  .page-subtitle { font-size: 13px; color: var(--text-secondary); margin-bottom: 20px; line-height: 1.5; }
  .section-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .07em; color: var(--text-secondary); margin: 28px 0 8px; }

  .settings-section { background: var(--bg-card); border-radius: var(--radius); overflow: hidden; box-shadow: var(--shadow); }
  .settings-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 13px 16px; border-bottom: 1px solid var(--border); min-height: 52px; background: var(--bg-card); transition: background .1s; }
  .settings-row:last-child { border-bottom: none; }
  .settings-row:hover:not(.row-disabled) { background: var(--bg-hover); }
  .settings-row.radio-row { cursor: pointer; }
  .settings-row.row-disabled { opacity: .45; pointer-events: none; }
  .settings-row-left { display: flex; align-items: flex-start; gap: 12px; flex: 1; min-width: 0; }
  .row-icon { color: var(--text-secondary); margin-top: 1px; flex-shrink: 0; }
  .row-label { font-size: 13px; color: var(--text-primary); }
  .row-desc { font-size: 12px; color: var(--text-secondary); margin-top: 2px; line-height: 1.45; }

  .card-list { background: var(--bg-card); border-radius: var(--radius); overflow: hidden; box-shadow: var(--shadow); }
  .backend-card { padding: 13px 16px; cursor: pointer; border-bottom: 1px solid var(--border); transition: background .1s; background: var(--bg-card); }
  .backend-card:last-child { border-bottom: none; }
  .backend-card:hover { background: var(--bg-hover); }
  .backend-card.selected { background: var(--bg-card-sel); }
  .backend-card-header { display: flex; align-items: flex-start; gap: 12px; }
  .backend-icon-wrap { width: 30px; height: 30px; background: var(--bg-hover); border-radius: 6px; display: flex; align-items: center; justify-content: center; color: var(--text-secondary); flex-shrink: 0; margin-top: 1px; }
  .backend-card.selected .backend-icon-wrap { background: var(--accent); color: white; }
  .backend-info { flex: 1; min-width: 0; }
  .backend-name { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-primary); margin-bottom: 2px; }
  .backend-desc { font-size: 12px; color: var(--text-secondary); line-height: 1.4; }
  .badge-active { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; background: var(--accent); color: white; padding: 1px 5px; border-radius: 3px; }
  .radio-circle { width: 16px; height: 16px; border-radius: 50%; border: 2px solid var(--border-input); flex-shrink: 0; margin-top: 3px; background: var(--bg-card); transition: border-color .15s; }
  .radio-circle.checked { border-color: var(--accent); background: radial-gradient(circle at center, var(--accent) 38%, transparent 42%); }

  .backend-config { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border); }
  .field-row-2 { display: flex; gap: 10px; }
  .field-group { margin-top: 10px; }
  .field-label { display: block; font-size: 12px; color: var(--text-secondary); margin-bottom: 5px; }
  .field-label .optional { opacity: .7; }
  .field-input { width: 100%; padding: 7px 10px; background: var(--bg-input); border: 1px solid var(--border-input); border-radius: 4px; font-family: var(--font); font-size: 13px; color: var(--text-primary); outline: none; transition: border-color .15s, box-shadow .15s; }
  .field-input.mono { font-family: var(--font-mono); font-size: 12px; }
  .field-input:focus { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(14,158,110,.18); }
  .field-input-inline { padding: 6px 10px; width: 180px; background: var(--bg-input); border: 1px solid var(--border-input); border-radius: 4px; font-family: var(--font); font-size: 13px; color: var(--text-primary); outline: none; }
  .field-input-inline:focus { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(14,158,110,.18); }

  .input-pw-wrap { position: relative; }
  .input-pw-wrap .field-input { padding-right: 36px; }
  .input-pw-wrap-2 .field-input { padding-right: 60px; }
  .btn-eye { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); background: none; border: none; cursor: pointer; color: var(--text-secondary); padding: 2px; display: flex; align-items: center; }
  .btn-eye:hover { color: var(--text-primary); }
  .btn-eye-group { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); display: flex; align-items: center; gap: 2px; }
  .btn-eye-group .btn-eye { position: static; transform: none; }

  .verify-row { display: flex; align-items: center; gap: 5px; font-size: 11px; color: var(--text-secondary); margin-top: 5px; }
  .verify-row.ok { color: var(--success); }

  .account-row { display: flex; align-items: center; gap: 10px; padding: 2px 0; }
  .account-avatar { width: 28px; height: 28px; background: var(--bg-hover); border: 1px solid var(--border); border-radius: 50%; display: flex; align-items: center; justify-content: center; color: var(--text-secondary); flex-shrink: 0; }
  .account-info { flex: 1; }
  .account-name { font-size: 13px; font-weight: 500; color: var(--text-primary); }
  .account-email { font-size: 12px; color: var(--text-secondary); }

  .btn-connect-google { display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; padding: 8px 16px; background: var(--bg-card); border: 1px solid var(--border-input); border-radius: 4px; cursor: pointer; font-family: var(--font); font-size: 13px; font-weight: 500; color: var(--text-primary); transition: background .1s, border-color .1s; }
  .btn-connect-google:hover { background: var(--bg-hover); border-color: var(--accent); }
  .btn-connect-google:disabled { opacity: .55; cursor: not-allowed; }
  .btn-disconnect { display: flex; align-items: center; gap: 5px; padding: 5px 10px; border-radius: var(--radius); border: 1px solid var(--border-input); background: var(--bg-card); cursor: pointer; font-family: var(--font); font-size: 12px; color: var(--text-secondary); transition: color .1s, border-color .1s, background .1s; white-space: nowrap; }
  .btn-disconnect:hover { color: var(--danger); border-color: var(--danger); }
  .config-hint { font-size: 11px; color: var(--text-secondary); margin-top: 7px; line-height: 1.4; }
  .config-hint code { font-family: var(--font-mono); font-size: 11px; background: var(--bg-hover); padding: 1px 3px; border-radius: 2px; }
  .error-row { display: flex; align-items: center; gap: 5px; font-size: 12px; color: var(--danger); margin-top: 7px; }
  .link-external { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--text-link); text-decoration: none; margin-top: 10px; }
  .link-external:hover { text-decoration: underline; }

  .action-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 16px; }
  .test-group { display: flex; align-items: center; gap: 8px; }
  .test-result { display: flex; align-items: center; gap: 5px; font-size: 12px; white-space: nowrap; }
  .test-result.ok { color: var(--success); }
  .test-result.fail { color: var(--danger); }

  .toggle-wrap { position: relative; display: inline-flex; align-items: center; cursor: pointer; flex-shrink: 0; }
  .toggle-input { position: absolute; opacity: 0; width: 0; height: 0; }
  .toggle-track { width: 34px; height: 18px; background: var(--toggle-off); border-radius: 9px; position: relative; transition: background .2s; }
  .toggle-input:checked ~ .toggle-track { background: var(--toggle-on); }
  .toggle-input:disabled ~ .toggle-track { opacity: .4; cursor: not-allowed; }
  .toggle-thumb { position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; background: var(--toggle-thumb); border-radius: 50%; transition: transform .18s; box-shadow: 0 1px 2px rgba(0,0,0,.2); }
  .toggle-input:checked ~ .toggle-track .toggle-thumb { transform: translateX(16px); }
  .native-radio { width: 15px; height: 15px; flex-shrink: 0; accent-color: var(--accent); cursor: pointer; }
  .slider-wrap { display: flex; align-items: center; gap: 8px; }
  .slider { width: 110px; accent-color: var(--accent); cursor: pointer; -webkit-appearance: none; height: 4px; background: var(--border); border-radius: 2px; outline: none; }
  .slider::-webkit-slider-thumb { -webkit-appearance: none; width: 13px; height: 13px; background: var(--accent); border-radius: 50%; }
  .slider-val { font-size: 12px; font-family: var(--font-mono); color: var(--text-secondary); min-width: 30px; text-align: right; }
  .mono-value { font-family: var(--font-mono); font-size: 11px; color: var(--text-secondary); }

  .btn-secondary { display: inline-flex; align-items: center; gap: 6px; padding: 7px 14px; border-radius: 4px; border: 1px solid var(--border-input); background: var(--bg-card); cursor: pointer; font-family: var(--font); font-size: 13px; color: var(--text-secondary); transition: background .1s, border-color .1s, color .1s; white-space: nowrap; }
  .btn-secondary:hover { background: var(--bg-hover); color: var(--text-primary); border-color: var(--accent); }
  .btn-secondary:disabled { opacity: .5; cursor: not-allowed; }
  .btn-save { display: inline-flex; align-items: center; gap: 7px; padding: 8px 18px; border-radius: 4px; border: none; background: var(--accent); color: white; font-family: var(--font); font-size: 13px; font-weight: 500; cursor: pointer; transition: background .15s; white-space: nowrap; }
  .btn-save:hover { background: var(--accent-hover); }
  .btn-save.saved { background: var(--success); }
  .btn-save:disabled { opacity: .6; cursor: not-allowed; }
  .btn-install { display: inline-flex; align-items: center; padding: 5px 12px; border-radius: 4px; background: var(--accent); color: white; font-size: 12px; font-weight: 500; text-decoration: none; flex-shrink: 0; transition: background .1s; }
  .btn-install:hover { background: var(--accent-hover); }

  .notice-warn { display: flex; align-items: flex-start; gap: 10px; padding: 11px 13px; margin-top: 14px; background: var(--warn-bg); border: 1px solid var(--warn-border); border-radius: var(--radius); font-size: 12px; color: var(--warn-text); line-height: 1.5; }
  .notice-warn svg { margin-top: 1px; flex-shrink: 0; color: var(--warn-border); }
  .notice-warn a { color: var(--text-link); }

  .spin { animation: spin .8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
`;

import { useState, useEffect, useRef } from "react";
import { sendMessage } from "@/lib/utils/messaging";
import { browser } from "@/lib/utils/ext";
import { interactiveSignIn } from "@/lib/backends/gdrive-oauth";
import type { BackendType, SyncSettings } from "@/lib/types";
import {
  Cloud, Server, Github, Bookmark,
  Clock, Puzzle, Globe, CheckCircle2, ArrowRight,
  Loader2, XCircle, Eye, EyeOff, Lock, Key,
} from "lucide-react";
// Konode brand mark — the glyph only; the container supplies the green tile.
function BrandMark({ size = 14, color = "currentColor" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="48 48 160 160" fill="none" aria-hidden="true">
      <path d="M152 192C152 196.418 155.582 200 160 200H192C196.418 200 200 196.418 200 192V157.601C200 154.322 197.342 151.664 194.063 151.664H178.723C176.899 151.664 175.231 150.635 174.413 149.005C170.523 141.251 172.071 131.874 178.249 125.783L198.313 105.999C199.392 104.935 200 103.482 200 101.966V64C200 59.5817 196.418 56 192 56H157.119C153.998 56 151.163 57.8143 149.855 60.6475L107.816 151.732C106.917 153.679 104 153.039 104 150.894V111.329C104 106.91 100.418 103.329 96 103.329H64C59.5817 103.329 56 106.91 56 111.329V192C56 196.418 59.5817 200 64 200H100.67C102.801 200 104.845 199.149 106.346 197.637L141.743 161.993C145.516 158.193 152 160.866 152 166.221V192Z" fill={color} />
    </svg>
  );
}

import { generateRecoveryKey, MIN_PASSPHRASE_LENGTH } from "@/lib/crypto/encryption";

// ─── Steps ────────────────────────────────────────────────────────────────

type Step = "welcome" | "backend" | "data" | "encrypt" | "syncing" | "done";

const STEPS: Step[] = ["welcome", "backend", "data", "encrypt", "done"];

// Icon + label for the live sync-progress list (#3) — matches the data-types step.
const TYPE_META: Record<"bookmarks" | "extensions" | "history" | "sessions", { Icon: typeof Bookmark; label: string }> = {
  bookmarks:  { Icon: Bookmark, label: "Bookmarks" },
  extensions: { Icon: Puzzle,   label: "Extensions" },
  history:    { Icon: Clock,    label: "History" },
  sessions:   { Icon: Globe,    label: "Sessions" },
};

// ─── App ──────────────────────────────────────────────────────────────────

export default function OnboardingApp() {
  const [step, setStep] = useState<Step>("welcome");
  const [backend, setBackend] = useState<BackendType | null>(null);
  const [saving, setSaving] = useState(false);

  // Google Drive
  const [gdriveUser, setGdriveUser] = useState<{ email: string; displayName: string } | null>(null);
  const [gdriveConnecting, setGdriveConnecting] = useState(false);
  const [gdriveError, setGdriveError] = useState<string | null>(null);

  // GitHub
  const [githubToken, setGithubToken] = useState("");
  const [githubRepo, setGithubRepo] = useState("");
  const [githubUser, setGithubUser] = useState<{ login: string } | null>(null);
  const [githubChecking, setGithubChecking] = useState(false);
  const [showToken, setShowToken] = useState(false);

  // WebDAV
  const [webdavUrl, setWebdavUrl] = useState("");
  const [webdavUser, setWebdavUser] = useState("");
  const [webdavPass, setWebdavPass] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);

  // Data types
  const [dataTypes, setDataTypes] = useState({
    bookmarks: true,
    extensions: false, // opt-in: the extension list is fingerprint-grade data
    history: false,
    sessions: false,
  });

  const toggleData = (key: keyof typeof dataTypes) =>
    setDataTypes((p) => ({ ...p, [key]: !p[key] }));

  // Encryption choice (made consciously on the "encrypt" step)
  const [encEnabled, setEncEnabled] = useState(false);
  const [encPass, setEncPass] = useState("");
  // #2 double-entry: a mistyped passphrase makes E2EE data unrecoverable, so a
  // manually-typed passphrase must be confirmed. A generated key (exact) skips it.
  const [encConfirm, setEncConfirm] = useState("");
  const [encGenerated, setEncGenerated] = useState("");
  const [showEncPass, setShowEncPass] = useState(false);
  // Set once the user hits Finish with E2EE on but the passphrase not (correctly)
  // filled — drives the red border + inline error (clears itself as they fix it).
  const [encTouched, setEncTouched] = useState(false);
  // Note: no copy-passphrase button here (unlike Settings). Onboarding is where the
  // passphrase is first CONFIRMED by re-typing; a copy button would let the user
  // paste it into the confirm field and defeat the double-entry check. Settings —
  // where the passphrase is already set — keeps copy for saving/rotating it.

  // #3: post-finish live sync progress. STATE_UPDATE only fires at sync start/end,
  // so we poll GET_STATE and light up each enabled type as its sync_counts entry
  // climbs past the baseline captured when the user hit Finish.
  const [syncCounts, setSyncCounts] = useState<Record<string, number>>({});
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncTimedOut, setSyncTimedOut] = useState(false);
  const baselineRef = useRef<Record<string, number>>({});
  const enabledTypes = (["bookmarks", "extensions", "history", "sessions"] as const).filter((k) => dataTypes[k]);

  // E2EE validation (a generated key is exact, so it skips the double-entry confirm).
  const confirmNeeded = encEnabled && encPass.length > 0 && encPass !== encGenerated;
  const passMissing = encEnabled && !encPass;
  const confirmMismatch = confirmNeeded && encConfirm !== encPass;
  // Strength floor for a manually-typed passphrase (a generated key is long by
  // construction): synced blobs sit on third-party storage and can be brute-forced
  // offline, so a short passphrase would hollow out the E2EE promise.
  const passTooShort = confirmNeeded && encPass.length < MIN_PASSPHRASE_LENGTH;

  useEffect(() => {
    if (step !== "syncing") return;
    let cancelled = false;
    let elapsed = 0;
    const POLL_MS = 600;
    const TIMEOUT_MS = 20000;
    const id = setInterval(async () => {
      const res = await sendMessage({ type: "GET_STATE" }).catch(() => null);
      if (cancelled || !res || res.type !== "STATE") return;
      const st = res.payload;
      setSyncCounts(st.sync_counts);
      if (st.status === "error" && st.last_error) {
        clearInterval(id);
        setSyncError(st.last_error);
        return;
      }
      const base = baselineRef.current;
      const allDone = enabledTypes.every((t) => (st.sync_counts[t] ?? 0) > (base[t] ?? 0));
      if (allDone) {
        clearInterval(id);
        setTimeout(() => { if (!cancelled) setStep("done"); }, 500);
        return;
      }
      elapsed += POLL_MS;
      if (elapsed >= TIMEOUT_MS) {
        clearInterval(id);
        setSyncTimedOut(true);
      }
    }, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [step]);

  const next = () => {
    const idx = STEPS.indexOf(step);
    if (idx < STEPS.length - 1) setStep(STEPS[idx + 1]);
  };

  const canProceedBackend = () => {
    if (!backend) return false;
    if (backend === "gdrive") return !!gdriveUser;
    if (backend === "github") return !!githubUser && !!githubRepo;
    if (backend === "webdav") return !!(webdavUrl && webdavUser && webdavPass);
    return false;
  };

  const finish = async () => {
    setSetupError(null);

    // E2EE chosen but the passphrase is empty / not confirmed — surface it (red
    // border + inline error) instead of silently doing nothing on click.
    if (passMissing || passTooShort || confirmMismatch) {
      setEncTouched(true);
      return;
    }

    // Request every optional permission this setup needs in ONE call, while we
    // still have the click's user gesture. A SECOND permissions.request() after an
    // await can be rejected for lacking a user gesture, which stranded WebDAV users
    // who also enabled an optional data type (origin request, then perms request).
    // The chosen data types (history/tabs/management) and — for WebDAV — the server
    // origin (an arbitrary host not in host_permissions) go in the same request.
    const optPerms: string[] = [];
    if (dataTypes.history) optPerms.push("history");
    if (dataTypes.sessions) optPerms.push("tabs");
    if (dataTypes.extensions) optPerms.push("management");

    const origins: string[] = [];
    if (backend === "webdav") {
      try {
        origins.push(new URL(webdavUrl).origin + "/*");
      } catch {
        setSetupError("That WebDAV address doesn't look like a valid URL.");
        return;
      }
    }

    if (optPerms.length || origins.length) {
      let granted = false;
      try {
        granted = await browser.permissions.request({
          ...(optPerms.length ? { permissions: optPerms } : {}),
          ...(origins.length ? { origins } : {}),
        });
      } catch {
        granted = false;
      }
      if (!granted) {
        setSetupError(
          origins.length
            ? "Konode needs permission to reach your WebDAV server and the data types you chose. Please allow them to continue."
            : "Some permissions were declined. Grant them, or turn off those data types, to continue."
        );
        return;
      }
    }

    setSaving(true);
    try {
      const res = await sendMessage({ type: "GET_SETTINGS" });
      if (res.type !== "SETTINGS") return;
      const current: SyncSettings = res.payload;

      const backends = [];
      if (backend === "gdrive") {
        // The session (incl. refresh token) was already persisted by connectGDrive.
        backends.push({ type: "gdrive" as const, label: "Google Drive", enabled: true, gdrive: {} });
      } else if (backend === "github") {
        backends.push({
          type: "github" as const, label: "GitHub", enabled: true,
          github: { token: githubToken, repo: githubRepo, branch: "main" },
        });
      } else if (backend === "webdav") {
        backends.push({
          type: "webdav" as const, label: "WebDAV", enabled: true,
          webdav: { url: webdavUrl, username: webdavUser, password: webdavPass },
        });
      }

      const enabled_types = (Object.keys(dataTypes) as Array<keyof typeof dataTypes>)
        .filter((k) => dataTypes[k]) as SyncSettings["enabled_types"];

      await sendMessage({
        type: "SAVE_SETTINGS",
        payload: {
          ...current, active_backend: backend, backends, enabled_types,
          encryption_enabled: encEnabled,
          encryption_passphrase: encEnabled ? encPass : undefined,
        },
      });

      // Capture pre-sync counts, show the live progress step, then start the first
      // sync WITHOUT awaiting — the "syncing" step polls GET_STATE and moves to
      // "done" when every enabled type's count has climbed (or surfaces an error).
      const stRes = await sendMessage({ type: "GET_STATE" });
      baselineRef.current = stRes.type === "STATE" ? { ...stRes.payload.sync_counts } : {};
      setSyncCounts(baselineRef.current);
      setSyncError(null);
      setSyncTimedOut(false);
      setStep("syncing");
      void sendMessage({ type: "SYNC_NOW" }).catch(() => {});
    } finally {
      setSaving(false);
    }
  };

  // ─── Google OAuth ──────────────────────────────────────────────────────

  const connectGDrive = () => {
    setGdriveConnecting(true); setGdriveError(null);
    void (async () => {
      try {
        // PKCE auth-code consent → stores a refresh token (see lib/backends/gdrive-oauth).
        const s = await interactiveSignIn();
        setGdriveUser({ email: s.email, displayName: s.displayName });
      } catch (err) {
        setGdriveError(err instanceof Error ? err.message : "Failed");
      } finally {
        setGdriveConnecting(false);
      }
    })();
  };

  // ─── GitHub token verify ───────────────────────────────────────────────

  const verifyToken = async (token: string) => {
    if (token.length < 10) { setGithubUser(null); return; }
    setGithubChecking(true);
    try {
      const res = await fetch("https://api.github.com/user", {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      });
      if (res.ok) {
        const d = await res.json();
        setGithubUser({ login: d.login });
      } else {
        setGithubUser(null);
      }
    } catch { setGithubUser(null); }
    setGithubChecking(false);
  };

  // ─── Render ───────────────────────────────────────────────────────────

  return (
    <div style={S.root}>
      <style>{CSS}</style>

      {/* Progress */}
      {step !== "done" && step !== "syncing" && (
        <div style={S.progress}>
          {STEPS.filter(s => s !== "done").map((s, i) => (
            <div key={s} style={{
              ...S.dot,
              background: STEPS.indexOf(step) >= i ? "var(--accent)" : "var(--border)",
            }} />
          ))}
        </div>
      )}

      {/* ── Welcome ── */}
      {step === "welcome" && (
        <div style={S.card}>
          <div style={S.logoWrap}>
            <BrandMark size={32} color="white" />
          </div>
          <h1 style={S.h1}>Welcome to Konode</h1>
          <p style={S.subtitle}>
            Privacy-first browser sync. Your bookmarks, sessions, and extensions — synced to your own storage. No middlemen.
          </p>
          <div style={S.featureList}>
            {[
              ["🔒", "Your data stays on your storage"],
              ["⚡", "Sync on every change, not just on schedule"],
              ["🌐", "Works across Chrome, Brave, and more"],
              ["📦", "Google Drive, WebDAV, GitHub — you choose"],
            ].map(([icon, text]) => (
              <div key={text} style={S.featureRow}>
                <span>{icon}</span>
                <span style={{ color: "var(--text-secondary)", fontSize: 14 }}>{text}</span>
              </div>
            ))}
          </div>
          <button style={S.btnPrimary} onClick={next}>
            Get started <ArrowRight size={16} />
          </button>
        </div>
      )}

      {/* ── Backend ── */}
      {step === "backend" && (
        <div style={S.card}>
          <h1 style={S.h1}>Choose your storage</h1>
          <p style={S.subtitle}>Where should Konode store your data?</p>

          <div style={S.backendList}>
            {/* Google Drive */}
            <div
              style={{ ...S.backendCard, ...(backend === "gdrive" ? S.backendSelected : {}) }}
              role="button" tabIndex={0} aria-pressed={backend === "gdrive"} aria-label="Use Google Drive"
              onClick={() => setBackend("gdrive")}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setBackend("gdrive"); } }}
            >
              <div style={S.backendHeader}>
                <Cloud size={18} color={backend === "gdrive" ? "var(--text-primary)" : "var(--text-secondary)"} />
                <div>
                  <div style={S.backendName}>Google Drive</div>
                  <div style={S.backendDesc}>OAuth — short-lived token cached on this device</div>
                </div>
                <div style={{ ...S.radio, ...(backend === "gdrive" ? S.radioChecked : {}) }} />
              </div>
              {backend === "gdrive" && (
                <div style={S.authPanel}>
                  {gdriveUser ? (
                    <div style={S.verifiedRow}>
                      <CheckCircle2 size={14} color="var(--success)" />
                      <span style={{ color: "var(--success)", fontSize: 14 }}>
                        {gdriveUser.displayName} ({gdriveUser.email})
                      </span>
                    </div>
                  ) : (
                    <>
                      <button style={S.btnGoogle} onClick={(e) => { e.stopPropagation(); connectGDrive(); }} disabled={gdriveConnecting}>
                        {gdriveConnecting ? <Loader2 size={14} className="spin" /> : (
                          <svg width="14" height="14" viewBox="0 0 24 24">
                            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                          </svg>
                        )}
                        {gdriveConnecting ? "Connecting…" : "Sign in with Google"}
                      </button>
                      {gdriveError && (
                        <div style={S.errorRow}><XCircle size={12} /> {gdriveError}</div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>

            {/* WebDAV */}
            <div
              style={{ ...S.backendCard, ...(backend === "webdav" ? S.backendSelected : {}) }}
              role="button" tabIndex={0} aria-pressed={backend === "webdav"} aria-label="Use WebDAV"
              onClick={() => setBackend("webdav")}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setBackend("webdav"); } }}
            >
              <div style={S.backendHeader}>
                <Server size={18} color={backend === "webdav" ? "var(--text-primary)" : "var(--text-secondary)"} />
                <div>
                  <div style={S.backendName}>WebDAV</div>
                  <div style={S.backendDesc}>Nextcloud, pCloud, Synology, ownCloud…</div>
                </div>
                <div style={{ ...S.radio, ...(backend === "webdav" ? S.radioChecked : {}) }} />
              </div>
              {backend === "webdav" && (
                <div style={S.authPanel} onClick={(e) => e.stopPropagation()}>
                  <input style={S.input} placeholder="https://cloud.example.com/remote.php/dav/files/user/"
                    value={webdavUrl} onChange={(e) => setWebdavUrl(e.target.value)} />
                  <div style={{ display: "flex", gap: 8 }}>
                    <input style={{ ...S.input, flex: 1 }} placeholder="Username"
                      value={webdavUser} onChange={(e) => setWebdavUser(e.target.value)} />
                    <div style={{ position: "relative", flex: 1 }}>
                      <input style={{ ...S.input, width: "100%", paddingRight: 32 }}
                        type={showPass ? "text" : "password"} placeholder="Password / App token"
                        value={webdavPass} onChange={(e) => setWebdavPass(e.target.value)} />
                      <button style={S.eyeBtn} onClick={() => setShowPass(v => !v)}>
                        {showPass ? <EyeOff size={12} /> : <Eye size={12} />}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* GitHub */}
            <div
              style={{ ...S.backendCard, ...(backend === "github" ? S.backendSelected : {}) }}
              role="button" tabIndex={0} aria-pressed={backend === "github"} aria-label="Use GitHub"
              onClick={() => setBackend("github")}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setBackend("github"); } }}
            >
              <div style={S.backendHeader}>
                <Github size={18} color={backend === "github" ? "var(--text-primary)" : "var(--text-secondary)"} />
                <div>
                  <div style={S.backendName}>GitHub / Gitea / GitLab</div>
                  <div style={S.backendDesc}>Private repository via Personal Access Token</div>
                </div>
                <div style={{ ...S.radio, ...(backend === "github" ? S.radioChecked : {}) }} />
              </div>
              {backend === "github" && (
                <div style={S.authPanel} onClick={(e) => e.stopPropagation()}>
                  <div style={{ position: "relative" }}>
                    <input
                      style={{ ...S.input, fontFamily: "monospace", paddingRight: 32 }}
                      type={showToken ? "text" : "password"}
                      placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                      value={githubToken}
                      onChange={async (e) => {
                        setGithubToken(e.target.value);
                        await verifyToken(e.target.value);
                      }}
                    />
                    <button style={S.eyeBtn} onClick={() => setShowToken(v => !v)}>
                      {showToken ? <EyeOff size={12} /> : <Eye size={12} />}
                    </button>
                  </div>
                  {githubChecking && (
                    <div style={S.verifyRow}><Loader2 size={12} className="spin" /> Verifying…</div>
                  )}
                  {githubUser && !githubChecking && (
                    <div style={{ ...S.verifyRow, color: "var(--success)" }}>
                      <CheckCircle2 size={12} /> @{githubUser.login}
                    </div>
                  )}
                  <input style={{ ...S.input, fontFamily: "monospace" }}
                    placeholder="username/konode-sync"
                    value={githubRepo} onChange={(e) => setGithubRepo(e.target.value)} />
                  <a
                    href="https://github.com/settings/personal-access-tokens/new"
                    target="_blank" rel="noreferrer"
                    style={{ fontSize: 12, color: "var(--text-link)", textDecoration: "none", marginTop: 4, display: "inline-block" }}
                  >
                    Create a fine-grained token (only this repo) →
                  </a>
                </div>
              )}
            </div>
          </div>

          <div style={S.navRow}>
            <button style={S.btnSecondary} onClick={() => setStep("welcome")}>Back</button>
            <button
              style={{ ...S.btnPrimary, flex: 1, opacity: canProceedBackend() ? 1 : 0.45, cursor: canProceedBackend() ? "pointer" : "not-allowed" }}
              onClick={next}
              disabled={!canProceedBackend()}
            >
              Continue <ArrowRight size={16} />
            </button>
          </div>
        </div>
      )}

      {/* ── Data Types ── */}
      {step === "data" && (
        <div style={S.card}>
          <h1 style={S.h1}>What to sync?</h1>
          <p style={S.subtitle}>You can change this anytime in Settings.</p>

          <div style={S.dataList}>
            {([
              { key: "bookmarks",  Icon: Bookmark, label: "Bookmarks",  desc: "Folders, order, all sites" },
              { key: "extensions", Icon: Puzzle,   label: "Extensions", desc: "Shows missing ones on other devices" },
              { key: "history",    Icon: Clock,    label: "History",    desc: "Last 30 days" },
              { key: "sessions",   Icon: Globe,    label: "Sessions",   desc: "Named tab groups" },
            ] as const).map(({ key, Icon, label, desc }) => (
              <label
                key={key}
                style={S.dataRow}
                role="switch"
                aria-checked={dataTypes[key]}
                aria-label={label}
                tabIndex={0}
                onClick={() => toggleData(key)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleData(key); } }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <Icon size={16} color={dataTypes[key] ? "var(--accent)" : "var(--text-secondary)"} />
                  <div>
                    <div style={{ fontSize: 14, color: "var(--text-primary)" }}>{label}</div>
                    <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>{desc}</div>
                  </div>
                </div>
                <div style={{
                  ...S.toggleTrack,
                  background: dataTypes[key] ? "var(--accent)" : "var(--toggle-off)",
                }}>
                  <div style={{
                    ...S.toggleThumb,
                    transform: dataTypes[key] ? "translateX(16px)" : "translateX(0)",
                  }} />
                </div>
              </label>
            ))}
          </div>

          {setupError && (
            <div style={{ ...S.errorRow, marginBottom: 12 }}><XCircle size={12} /> {setupError}</div>
          )}
          <div style={S.navRow}>
            <button style={S.btnSecondary} onClick={() => setStep("backend")}>Back</button>
            <button style={{ ...S.btnPrimary, flex: 1 }} onClick={() => setStep("encrypt")}>
              Continue <ArrowRight size={14} />
            </button>
          </div>
        </div>
      )}

      {step === "encrypt" && (
        <div style={S.card}>
          <h1 style={S.h1}>Encrypt your data?</h1>
          <p style={S.subtitle}>
            Your choice — Konode works either way. Encryption scrambles everything on this device
            before it's uploaded, so your storage provider can never read it.
          </p>

          <label
            style={{ ...S.dataRow, marginBottom: 12 }}
            role="switch"
            aria-checked={encEnabled}
            aria-label="End-to-end encryption"
            tabIndex={0}
            onClick={() => setEncEnabled((v) => !v)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setEncEnabled((v) => !v); } }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <Lock size={16} color={encEnabled ? "var(--accent)" : "var(--text-secondary)"} />
              <div>
                <div style={{ fontSize: 14, color: "var(--text-primary)" }}>End-to-end encryption</div>
                <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>AES-256-GCM. Recommended.</div>
              </div>
            </div>
            <div style={{ ...S.toggleTrack, background: encEnabled ? "var(--accent)" : "var(--toggle-off)" }}>
              <div style={{ ...S.toggleThumb, transform: encEnabled ? "translateX(16px)" : "translateX(0)" }} />
            </div>
          </label>

          {encEnabled ? (
            <div style={{ marginBottom: 12 }}>
              <div style={{ position: "relative" }}>
                <input
                  style={{ ...S.input, width: "100%", paddingRight: 34, ...(encTouched && passMissing ? { borderColor: "var(--danger)" } : {}) }}
                  type={showEncPass ? "text" : "password"}
                  placeholder="Choose a passphrase, or generate a key →"
                  value={encPass}
                  onChange={(e) => setEncPass(e.target.value)}
                  aria-invalid={encTouched && passMissing}
                />
                <div style={S.inputBtnGroup}>
                  <button type="button" style={S.iconBtn} onClick={() => setShowEncPass(v => !v)} title={showEncPass ? "Hide" : "Show"}>
                    {showEncPass ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </div>
              {encTouched && passMissing && (
                <div style={{ fontSize: 12, color: "var(--danger)", marginTop: 4 }}>
                  Enter a passphrase, or generate a key.
                </div>
              )}
              {passTooShort && (
                <div style={{ fontSize: 12, color: "var(--danger)", marginTop: 4 }}>
                  At least {MIN_PASSPHRASE_LENGTH} characters — synced data can be attacked offline, so short passphrases are guessable.
                </div>
              )}
              {confirmNeeded && (
                <>
                  <input
                    style={{ ...S.input, marginTop: 8, ...((encTouched || encConfirm.length > 0) && confirmMismatch ? { borderColor: "var(--danger)" } : {}) }}
                    type="password"
                    placeholder="Confirm passphrase"
                    value={encConfirm}
                    onChange={(e) => setEncConfirm(e.target.value)}
                    aria-invalid={(encTouched || encConfirm.length > 0) && confirmMismatch}
                  />
                  {(encTouched || encConfirm.length > 0) && confirmMismatch && (
                    <div style={{ fontSize: 12, color: "var(--danger)", marginTop: 4 }}>
                      {encConfirm.length === 0 ? "Confirm your passphrase." : "Passphrases don't match yet."}
                    </div>
                  )}
                </>
              )}
              <button
                type="button"
                onClick={() => { const k = generateRecoveryKey(); setEncPass(k); setEncGenerated(k); setEncConfirm(""); setShowEncPass(true); }}
                style={{ marginTop: 8, display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--accent)", background: "none", border: "none", cursor: "pointer", padding: 0 }}>
                <Key size={12} /> Generate a strong key
              </button>
              <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 10, lineHeight: 1.5 }}>
                <b>Save this passphrase.</b> It never leaves your device and can't be recovered if lost —
                and every device must use the same one.
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 12, lineHeight: 1.5 }}>
              Your data will be stored <b>unencrypted</b> on your backend. Fine for storage you fully trust;
              you can turn encryption on later in Settings.
            </div>
          )}

          {setupError && (
            <div style={{ ...S.errorRow, marginBottom: 12 }}><XCircle size={12} /> {setupError}</div>
          )}
          <div style={S.navRow}>
            <button style={S.btnSecondary} onClick={() => setStep("data")}>Back</button>
            <button style={{ ...S.btnPrimary, flex: 1 }} onClick={finish} disabled={saving}>
              {saving ? <Loader2 size={14} className="spin" /> : <CheckCircle2 size={14} />}
              {saving ? "Setting up…" : "Finish & Sync"}
            </button>
          </div>
        </div>
      )}

      {/* ── Syncing (live progress) ── */}
      {step === "syncing" && (
        <div style={S.card}>
          <h1 style={S.h1}>{syncError ? "Couldn't finish the first sync" : "Syncing your data…"}</h1>
          <p style={S.subtitle}>
            {syncError
              ? "Your settings are saved. Open Settings to fix this, or finish and let Konode retry in the background."
              : "Konode is running its first sync. This also runs in the background — you don't have to wait here."}
          </p>

          <div style={S.dataList}>
            {enabledTypes.map((key) => {
              const done = (syncCounts[key] ?? 0) > (baselineRef.current[key] ?? 0);
              const { Icon, label } = TYPE_META[key];
              return (
                <div key={key} style={{ ...S.dataRow, cursor: "default" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <Icon size={16} color={done ? "var(--accent)" : "var(--text-secondary)"} />
                    <div style={{ fontSize: 14, color: "var(--text-primary)" }}>{label}</div>
                  </div>
                  {done ? (
                    <CheckCircle2 size={16} color="var(--accent)" />
                  ) : syncError ? (
                    <XCircle size={16} color="var(--text-disabled)" />
                  ) : (
                    <Loader2 size={16} className="spin" color="var(--text-secondary)" />
                  )}
                </div>
              );
            })}
          </div>

          {syncError && (
            <div style={{ ...S.errorRow, marginBottom: 12 }}><XCircle size={12} /> {syncError}</div>
          )}
          {syncTimedOut && !syncError && (
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 12, lineHeight: 1.5 }}>
              This is taking longer than usual — a large history can do that. The sync keeps running in the background, so you can finish now.
            </div>
          )}

          {(syncError || syncTimedOut) && (
            <div style={S.navRow}>
              {syncError && (
                <button style={{ ...S.btnPrimary, flex: 1 }} onClick={() => browser.runtime.openOptionsPage()}>
                  Open Settings
                </button>
              )}
              <button
                style={syncError ? S.btnSecondary : { ...S.btnPrimary, flex: 1 }}
                onClick={() => setStep("done")}
              >
                {syncError ? "Finish anyway" : "Finish"} <ArrowRight size={14} />
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Done ── */}
      {step === "done" && (
        <div style={{ ...S.card, textAlign: "center" }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>🎉</div>
          <h1 style={S.h1}>You're all set!</h1>
          <p style={S.subtitle}>
            Konode is now syncing your browser data to{" "}
            <strong>{backend === "gdrive" ? "Google Drive" : backend === "github" ? "GitHub" : "WebDAV"}</strong>.
            The first sync is running in the background.
          </p>
          <div style={{ ...S.featureList, marginBottom: 24 }}>
            <div style={S.featureRow}><span>✅</span><span style={{ fontSize: 14, color: "var(--text-secondary)" }}>Backend connected</span></div>
            <div style={S.featureRow}><span>✅</span><span style={{ fontSize: 14, color: "var(--text-secondary)" }}>Automatic background sync</span></div>
            <div style={S.featureRow}><span>✅</span><span style={{ fontSize: 14, color: "var(--text-secondary)" }}>Adjust everything in Settings</span></div>
          </div>
          <button style={S.btnPrimary} onClick={() => window.close()}>
            Close <ArrowRight size={16} />
          </button>
          <button
            style={{ ...S.btnSecondary, marginTop: 8, width: "100%", justifyContent: "center" }}
            onClick={() => browser.runtime.openOptionsPage()}
          >
            Open Settings
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────

const S: Record<string, React.CSSProperties> = {
  root: {
    minHeight: "100vh", background: "var(--bg)",
    display: "flex", alignItems: "flex-start", justifyContent: "center",
    padding: "40px 16px 60px",
    fontFamily: "-apple-system, 'Google Sans', BlinkMacSystemFont, 'Segoe UI', sans-serif",
  },
  progress: {
    position: "fixed", top: 20, left: "50%", transform: "translateX(-50%)",
    display: "flex", gap: 6,
  },
  dot: { width: 24, height: 4, borderRadius: 2, transition: "background .2s" },
  card: {
    width: "100%", maxWidth: 480,
    background: "var(--bg-card)",
    borderRadius: 20,
    padding: "36px 36px 30px",
    boxShadow: "0 1px 2px rgba(17,21,26,.04), 0 12px 28px -8px rgba(17,21,26,.12), 0 0 0 1px rgba(17,21,26,.05)",
    marginTop: 20,
  },
  logoWrap: {
    width: 56, height: 56, borderRadius: 16,
    background: "var(--accent)",
    display: "flex", alignItems: "center", justifyContent: "center",
    marginBottom: 22,
    boxShadow: "0 6px 16px -4px rgba(18,183,106,.45)",
  },
  h1: { fontSize: 24, fontWeight: 600, letterSpacing: "-0.02em", color: "var(--text-primary)", margin: "0 0 8px" },
  subtitle: { fontSize: 14, color: "var(--text-secondary)", lineHeight: 1.55, margin: "0 0 24px" },
  featureList: { display: "flex", flexDirection: "column", gap: 12, marginBottom: 28 },
  featureRow: { display: "flex", alignItems: "center", gap: 10 },
  btnPrimary: {
    display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8,
    width: "100%", height: 44, padding: "0 20px", borderRadius: 14, border: "none",
    background: "var(--accent-solid)", color: "var(--on-accent)",
    fontSize: 14, fontWeight: 600, cursor: "pointer",
    fontFamily: "inherit", transition: "background .15s, box-shadow .15s",
    boxShadow: "0 1px 2px rgba(18,183,106,.30)",
  },
  btnSecondary: {
    display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, flexShrink: 0,
    height: 44, padding: "0 18px", borderRadius: 14,
    border: "1px solid var(--border-input)", background: "var(--bg-card)",
    fontSize: 14, fontWeight: 500, color: "var(--text-secondary)", cursor: "pointer", fontFamily: "inherit",
  },
  btnGoogle: {
    display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
    width: "100%", height: 40, padding: "0 14px", borderRadius: 12,
    border: "1px solid var(--border-input)", background: "var(--bg-card)",
    fontSize: 14, fontWeight: 500, cursor: "pointer", fontFamily: "inherit",
    color: "var(--text-primary)",
  },
  backendList: { display: "flex", flexDirection: "column", gap: 0, marginBottom: 24,
    borderRadius: 16, overflow: "hidden", boxShadow: "0 1px 2px rgba(17,21,26,.04), 0 0 0 1px rgba(17,21,26,.07)" },
  backendCard: {
    padding: "14px 16px", cursor: "pointer",
    borderBottom: "1px solid var(--border)",
    background: "var(--bg-card)", transition: "background .1s",
  },
  backendSelected: { background: "var(--bg-card-sel)" },
  backendHeader: { display: "flex", alignItems: "flex-start", gap: 10 },
  backendName: { fontSize: 14, fontWeight: 500, color: "var(--text-primary)", marginBottom: 2 },
  backendDesc: { fontSize: 12, color: "var(--text-secondary)" },
  radio: {
    width: 16, height: 16, borderRadius: "50%",
    border: "2px solid var(--border-input)", marginLeft: "auto", marginTop: 2, flexShrink: 0,
    background: "var(--bg-card)",
  },
  radioChecked: {
    borderColor: "var(--accent)",
    background: "radial-gradient(circle at center, var(--accent) 38%, transparent 42%)",
  },
  authPanel: { marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 8 },
  input: {
    width: "100%", padding: "10px 12px",
    background: "var(--bg-input)", border: "1px solid var(--border-input)",
    borderRadius: 12, fontSize: 14, color: "var(--text-primary)", outline: "none",
    fontFamily: "inherit",
  },
  eyeBtn: {
    position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)",
    background: "none", border: "none", cursor: "pointer", color: "var(--text-secondary)",
    display: "flex", alignItems: "center",
  },
  inputBtnGroup: {
    position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)",
    display: "flex", alignItems: "center", gap: 2,
  },
  iconBtn: {
    background: "none", border: "none", cursor: "pointer", color: "var(--text-secondary)",
    display: "flex", alignItems: "center", padding: 4, borderRadius: 8,
  },
  verifiedRow: { display: "flex", alignItems: "center", gap: 6, fontSize: 12 },
  verifyRow: { display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--text-secondary)" },
  errorRow: { display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--danger)" },
  dataList: { display: "flex", flexDirection: "column", gap: 0, marginBottom: 24,
    borderRadius: 16, overflow: "hidden", boxShadow: "0 1px 2px rgba(17,21,26,.04), 0 0 0 1px rgba(17,21,26,.07)" },
  dataRow: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "14px 16px", borderBottom: "1px solid var(--border)",
    background: "var(--bg-card)", cursor: "pointer", transition: "background .1s",
  },
  toggleTrack: { width: 34, height: 18, borderRadius: 10, position: "relative", transition: "background .2s", flexShrink: 0 },
  toggleThumb: {
    position: "absolute", top: 2, left: 2, width: 14, height: 14,
    background: "white", borderRadius: "50%", transition: "transform .18s",
    boxShadow: "0 1px 2px rgba(0,0,0,.2)",
  },
  navRow: { display: "flex", alignItems: "stretch", gap: 12, marginTop: 20 },
};

const CSS = `
  @font-face { font-family: 'Inter'; font-style: normal; font-weight: 400; font-display: swap; src: url('/fonts/inter-400.woff2') format('woff2'); }
  @font-face { font-family: 'Inter'; font-style: normal; font-weight: 500; font-display: swap; src: url('/fonts/inter-500.woff2') format('woff2'); }
  /* Color tokens live in src/theme.css (imported by main.tsx), shared with the
     options page. */
  html, body, #root { margin: 0; padding: 0; background: var(--bg); font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
  * { box-sizing: border-box; }
  .spin { animation: spin .8s linear infinite; display: inline-block; }
  @keyframes spin { to { transform: rotate(360deg); } }
  button:hover { opacity: .9; }
`;

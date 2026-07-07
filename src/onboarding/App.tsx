import { useState } from "react";
import { sendMessage } from "@/lib/utils/messaging";
import { interactiveSignIn } from "@/lib/backends/gdrive-oauth";
import type { BackendType, SyncSettings } from "@/lib/types";
import {
  Radio, Cloud, Server, Github, Bookmark,
  Clock, Puzzle, Globe, CheckCircle2, ArrowRight,
  Loader2, XCircle, Eye, EyeOff, Lock, Key,
} from "lucide-react";
import { generateRecoveryKey } from "@/lib/crypto/encryption";

// ─── Steps ────────────────────────────────────────────────────────────────

type Step = "welcome" | "backend" | "data" | "encrypt" | "done";

const STEPS: Step[] = ["welcome", "backend", "data", "encrypt", "done"];

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
    extensions: true,
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
    // WebDAV reaches an arbitrary host not in host_permissions — request it now,
    // while we still have the click's user gesture (before any await).
    if (backend === "webdav") {
      let granted = false;
      try {
        const origin = new URL(webdavUrl).origin + "/*";
        granted = await chrome.permissions.request({ origins: [origin] });
      } catch {
        granted = false;
      }
      if (!granted) {
        setSetupError("Synkro needs permission to reach your WebDAV server. Please allow it to continue.");
        return;
      }
    }

    // Request optional permissions for the chosen data types (history/tabs/
    // management are no longer requested up front).
    const optPerms: string[] = [];
    if (dataTypes.history) optPerms.push("history");
    if (dataTypes.sessions) optPerms.push("tabs");
    if (dataTypes.extensions) optPerms.push("management");
    if (optPerms.length) {
      try {
        const ok = await chrome.permissions.request({ permissions: optPerms });
        if (!ok) {
          setSetupError("Some permissions were declined. Grant them, or turn off those data types, to continue.");
          return;
        }
      } catch {
        setSetupError("Could not request the required permissions.");
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

      // Trigger first sync
      await sendMessage({ type: "SYNC_NOW" });

      setStep("done");
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
      {step !== "done" && (
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
            <Radio size={28} color="white" />
          </div>
          <h1 style={S.h1}>Welcome to Synkro</h1>
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
                <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>{text}</span>
              </div>
            ))}
          </div>
          <button style={S.btnPrimary} onClick={next}>
            Get started <ArrowRight size={15} />
          </button>
        </div>
      )}

      {/* ── Backend ── */}
      {step === "backend" && (
        <div style={S.card}>
          <h1 style={S.h1}>Choose your storage</h1>
          <p style={S.subtitle}>Where should Synkro store your data?</p>

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
                      <span style={{ color: "var(--success)", fontSize: 13 }}>
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
                    <div style={S.verifyRow}><Loader2 size={11} className="spin" /> Verifying…</div>
                  )}
                  {githubUser && !githubChecking && (
                    <div style={{ ...S.verifyRow, color: "var(--success)" }}>
                      <CheckCircle2 size={11} /> @{githubUser.login}
                    </div>
                  )}
                  <input style={{ ...S.input, fontFamily: "monospace" }}
                    placeholder="username/synkro-sync"
                    value={githubRepo} onChange={(e) => setGithubRepo(e.target.value)} />
                  <a
                    href="https://github.com/settings/personal-access-tokens/new"
                    target="_blank" rel="noreferrer"
                    style={{ fontSize: 11, color: "var(--text-link)", textDecoration: "none", marginTop: 4, display: "inline-block" }}
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
              style={{ ...S.btnPrimary, opacity: canProceedBackend() ? 1 : 0.45, cursor: canProceedBackend() ? "pointer" : "not-allowed" }}
              onClick={next}
              disabled={!canProceedBackend()}
            >
              Continue <ArrowRight size={15} />
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
                    <div style={{ fontSize: 13, color: "var(--text-primary)" }}>{label}</div>
                    <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>{desc}</div>
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
            <button style={S.btnPrimary} onClick={() => setStep("encrypt")}>
              Continue <ArrowRight size={14} />
            </button>
          </div>
        </div>
      )}

      {step === "encrypt" && (
        <div style={S.card}>
          <h1 style={S.h1}>Encrypt your data?</h1>
          <p style={S.subtitle}>
            Your choice — Synkro works either way. Encryption scrambles everything on this device
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
                <div style={{ fontSize: 13, color: "var(--text-primary)" }}>End-to-end encryption</div>
                <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>AES-256-GCM. Recommended.</div>
              </div>
            </div>
            <div style={{ ...S.toggleTrack, background: encEnabled ? "var(--accent)" : "var(--toggle-off)" }}>
              <div style={{ ...S.toggleThumb, transform: encEnabled ? "translateX(16px)" : "translateX(0)" }} />
            </div>
          </label>

          {encEnabled ? (
            <div style={{ marginBottom: 12 }}>
              <input
                style={S.input}
                type="text"
                placeholder="Choose a passphrase, or generate a key →"
                value={encPass}
                onChange={(e) => setEncPass(e.target.value)}
              />
              {encPass.length > 0 && encPass !== encGenerated && (
                <>
                  <input
                    style={{ ...S.input, marginTop: 8 }}
                    type="password"
                    placeholder="Confirm passphrase"
                    value={encConfirm}
                    onChange={(e) => setEncConfirm(e.target.value)}
                  />
                  {encConfirm.length > 0 && encConfirm !== encPass && (
                    <div style={{ fontSize: 11, color: "var(--danger)", marginTop: 4 }}>Passphrases don't match yet.</div>
                  )}
                </>
              )}
              <button
                type="button"
                onClick={() => { const k = generateRecoveryKey(); setEncPass(k); setEncGenerated(k); setEncConfirm(""); }}
                style={{ marginTop: 8, display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--accent)", background: "none", border: "none", cursor: "pointer", padding: 0 }}>
                <Key size={12} /> Generate a strong key
              </button>
              <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 10, lineHeight: 1.5 }}>
                <b>Save this passphrase.</b> It never leaves your device and can't be recovered if lost —
                and every device must use the same one.
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 12, lineHeight: 1.5 }}>
              Your data will be stored <b>unencrypted</b> on your backend. Fine for storage you fully trust;
              you can turn encryption on later in Settings.
            </div>
          )}

          {setupError && (
            <div style={{ ...S.errorRow, marginBottom: 12 }}><XCircle size={12} /> {setupError}</div>
          )}
          <div style={S.navRow}>
            <button style={S.btnSecondary} onClick={() => setStep("data")}>Back</button>
            <button style={S.btnPrimary} onClick={finish} disabled={saving || (encEnabled && (!encPass || (encPass !== encGenerated && encConfirm !== encPass)))}>
              {saving ? <Loader2 size={14} className="spin" /> : <CheckCircle2 size={14} />}
              {saving ? "Setting up…" : "Finish & Sync"}
            </button>
          </div>
        </div>
      )}

      {/* ── Done ── */}
      {step === "done" && (
        <div style={{ ...S.card, textAlign: "center" }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>🎉</div>
          <h1 style={S.h1}>You're all set!</h1>
          <p style={S.subtitle}>
            Synkro is now syncing your browser data to{" "}
            <strong>{backend === "gdrive" ? "Google Drive" : backend === "github" ? "GitHub" : "WebDAV"}</strong>.
            The first sync is running in the background.
          </p>
          <div style={{ ...S.featureList, marginBottom: 24 }}>
            <div style={S.featureRow}><span>✅</span><span style={{ fontSize: 13, color: "var(--text-secondary)" }}>Backend connected</span></div>
            <div style={S.featureRow}><span>✅</span><span style={{ fontSize: 13, color: "var(--text-secondary)" }}>Automatic background sync</span></div>
            <div style={S.featureRow}><span>✅</span><span style={{ fontSize: 13, color: "var(--text-secondary)" }}>Adjust everything in Settings</span></div>
          </div>
          <button style={S.btnPrimary} onClick={() => window.close()}>
            Close <ArrowRight size={15} />
          </button>
          <button
            style={{ ...S.btnSecondary, marginTop: 8, width: "100%", justifyContent: "center" }}
            onClick={() => chrome.runtime.openOptionsPage()}
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
    borderRadius: 8,
    padding: "32px 32px 28px",
    boxShadow: "var(--shadow)",
    border: "1px solid var(--border)",
    marginTop: 20,
  },
  logoWrap: {
    width: 56, height: 56, borderRadius: 14,
    background: "var(--accent)",
    display: "flex", alignItems: "center", justifyContent: "center",
    marginBottom: 20,
  },
  h1: { fontSize: 22, fontWeight: 600, color: "var(--text-primary)", margin: "0 0 8px" },
  subtitle: { fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.55, margin: "0 0 24px" },
  featureList: { display: "flex", flexDirection: "column", gap: 10, marginBottom: 28 },
  featureRow: { display: "flex", alignItems: "center", gap: 10 },
  btnPrimary: {
    display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8,
    width: "100%", padding: "11px 20px", borderRadius: 6, border: "none",
    background: "var(--accent)", color: "white",
    fontSize: 14, fontWeight: 500, cursor: "pointer",
    fontFamily: "inherit", transition: "background .15s",
  },
  btnSecondary: {
    display: "inline-flex", alignItems: "center", gap: 6,
    padding: "9px 16px", borderRadius: 6,
    border: "1px solid var(--border-input)", background: "var(--bg-card)",
    fontSize: 13, color: "var(--text-secondary)", cursor: "pointer", fontFamily: "inherit",
  },
  btnGoogle: {
    display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
    width: "100%", padding: "8px 14px", borderRadius: 4,
    border: "1px solid var(--border-input)", background: "var(--bg-card)",
    fontSize: 13, fontWeight: 500, cursor: "pointer", fontFamily: "inherit",
    color: "var(--text-primary)",
  },
  backendList: { display: "flex", flexDirection: "column", gap: 0, marginBottom: 24,
    borderRadius: 6, overflow: "hidden", boxShadow: "var(--shadow)" },
  backendCard: {
    padding: "12px 14px", cursor: "pointer",
    borderBottom: "1px solid var(--border)",
    background: "var(--bg-card)", transition: "background .1s",
  },
  backendSelected: { background: "var(--bg-card-sel)" },
  backendHeader: { display: "flex", alignItems: "flex-start", gap: 10 },
  backendName: { fontSize: 13, fontWeight: 500, color: "var(--text-primary)", marginBottom: 1 },
  backendDesc: { fontSize: 11, color: "var(--text-secondary)" },
  radio: {
    width: 15, height: 15, borderRadius: "50%",
    border: "2px solid var(--border-input)", marginLeft: "auto", marginTop: 2, flexShrink: 0,
    background: "var(--bg-card)",
  },
  radioChecked: {
    borderColor: "var(--accent)",
    background: "radial-gradient(circle at center, var(--accent) 38%, transparent 42%)",
  },
  authPanel: { marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 8 },
  input: {
    width: "100%", padding: "7px 10px",
    background: "var(--bg-input)", border: "1px solid var(--border-input)",
    borderRadius: 4, fontSize: 12, color: "var(--text-primary)", outline: "none",
    fontFamily: "inherit",
  },
  eyeBtn: {
    position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)",
    background: "none", border: "none", cursor: "pointer", color: "var(--text-secondary)",
    display: "flex", alignItems: "center",
  },
  verifiedRow: { display: "flex", alignItems: "center", gap: 6, fontSize: 12 },
  verifyRow: { display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--text-secondary)" },
  errorRow: { display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: "var(--danger)" },
  dataList: { display: "flex", flexDirection: "column", gap: 0, marginBottom: 24,
    borderRadius: 6, overflow: "hidden", boxShadow: "var(--shadow)" },
  dataRow: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "12px 14px", borderBottom: "1px solid var(--border)",
    background: "var(--bg-card)", cursor: "pointer", transition: "background .1s",
  },
  toggleTrack: { width: 34, height: 18, borderRadius: 9, position: "relative", transition: "background .2s", flexShrink: 0 },
  toggleThumb: {
    position: "absolute", top: 2, left: 2, width: 14, height: 14,
    background: "white", borderRadius: "50%", transition: "transform .18s",
    boxShadow: "0 1px 2px rgba(0,0,0,.2)",
  },
  navRow: { display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 8 },
};

const CSS = `
  @font-face { font-family: 'Inter'; font-style: normal; font-weight: 400; font-display: swap; src: url('/fonts/inter-400.woff2') format('woff2'); }
  @font-face { font-family: 'Inter'; font-style: normal; font-weight: 500; font-display: swap; src: url('/fonts/inter-500.woff2') format('woff2'); }
  :root {
    --bg: #f7f8fa; --bg-card: #fff; --bg-card-sel: #e7f5ef; --bg-input: #fff;
    --bg-hover: #f1f3f5; --border: #e6e8eb; --border-input: #d4d8dd;
    --text-primary: #11151a; --text-secondary: #5b6470; --text-link: #0e9e6e;
    --accent: #0e9e6e; --accent-light: #e7f5ef; --toggle-off: #d4d8dd;
    --success: #0e9e6e; --danger: #dc2626;
    --shadow: 0 1px 2px rgba(17,21,26,.05), 0 0 0 1px rgba(17,21,26,.06);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1216; --bg-card: #161a20; --bg-card-sel: #173a30; --bg-input: #1e232b;
      --bg-hover: #1e232b; --border: #2a2f37; --border-input: #353b45;
      --text-primary: #e6e9ee; --text-secondary: #97a0ad; --text-link: #34d399;
      --accent: #34d399; --accent-light: #173a30; --toggle-off: #353b45;
      --success: #34d399; --danger: #f87171;
      --shadow: 0 1px 3px rgba(0,0,0,.35), 0 0 0 1px rgba(255,255,255,.05);
    }
  }
  html, body, #root { margin: 0; padding: 0; background: var(--bg); font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
  * { box-sizing: border-box; }
  .spin { animation: spin .8s linear infinite; display: inline-block; }
  @keyframes spin { to { transform: rotate(360deg); } }
  button:hover { opacity: .9; }
`;

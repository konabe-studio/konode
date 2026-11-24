/**
 * Dropbox OAuth: authorization code + PKCE, as a PUBLIC client, with a refresh token.
 *
 * Same shape as the Drive sign-in (gdrive-oauth.ts), one difference that matters: Dropbox
 * lets a public client finish the code exchange and every later refresh with PKCE alone, so
 * there is no app secret anywhere. The app key below is the OAuth `client_id`, public by
 * design (it sits in every authorize URL), so it is committed rather than injected at build
 * time, and the store build, the GitHub release build and a build from source all sign in
 * the same way. This needs "Allow public clients (Implicit Grant & PKCE)" on in the
 * Dropbox App Console.
 *
 * `token_access_type=offline` asks for a refresh token. Access tokens are short-lived
 * (`expires_in`, four hours today); the refresh token does not expire until the user
 * revokes it, and a refresh never returns a new one.
 *
 * The app is an App folder app: Dropbox creates `Apps/Konode` in the user's Dropbox and
 * this token can see nothing outside it. See dropbox-backend.ts.
 *
 * The redirect is the extension's BARE redirect URL, `https://<id>.chromiumapp.org/` (or
 * Firefox's `https://<hash>.extensions.allizom.org/`). Dropbox matches a redirect URI
 * exactly, and Orion and Quetta drop `getRedirectURL()`'s path argument (#24), so the root
 * is the one form every engine sends. Registered for the Chrome Web Store id, the Edge
 * Add-ons id, Firefox (sha1 of the add-on id) and the id the manifest `key` gives `dist/`.
 */

import { logger } from "@/lib/utils/logger";
import { KEYS } from "@/lib/utils/storage";
import { browser } from "@/lib/utils/ext";
import { codeChallenge, randomVerifier } from "@/lib/utils/pkce";
import { HttpError, retryAfterMs, withRetry } from "@/lib/utils/retry";

/**
 * The Dropbox app key (OAuth client_id). Public, see above, so it lives here in the source.
 * `VITE_DROPBOX_APP_KEY` replaces it at build time, for a fork that registers a Dropbox app
 * of its own (its extension id differs, so Konode's registered redirects cannot match it).
 */
export const DROPBOX_APP_KEY: string = import.meta.env.VITE_DROPBOX_APP_KEY ?? "cq03j1aywgriemo";

const AUTH_ENDPOINT = "https://www.dropbox.com/oauth2/authorize";
const TOKEN_ENDPOINT = "https://api.dropboxapi.com/oauth2/token";
const REVOKE_ENDPOINT = "https://api.dropboxapi.com/2/auth/token/revoke";
const ACCOUNT_ENDPOINT = "https://api.dropboxapi.com/2/users/get_current_account";
const STORAGE_KEY = KEYS.DROPBOX_SESSION;
const EXPIRY_BUFFER_MS = 60_000; // refresh a minute before the token actually expires

/** The two API origins the backend talks to. The authorize page is opened by the browser's
 *  own auth window and needs no permission. */
export const DROPBOX_ORIGINS = ["https://api.dropboxapi.com/*", "https://content.dropboxapi.com/*"];

export interface DropboxSession {
  access_token: string;
  refresh_token?: string;
  expires_at: number; // epoch ms
  /** Dropbox's `dbid:…` account id, which never changes for an account. */
  account_id: string;
  email: string;
  displayName: string;
  savedAt: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  account_id?: string;
}

/** Why a token request failed. An HttpError, so a 429 or 5xx is retried like any other
 *  call (with Dropbox's Retry-After), while a 400 (a dead refresh token) is not. */
export class DropboxTokenError extends HttpError {
  constructor(status: number, public readonly code: string, message: string, retryAfter?: number) {
    super(status, message, retryAfter);
    this.name = "DropboxTokenError";
  }
}

export function dropboxRedirectUri(): string {
  return browser.identity.getRedirectURL();
}

const UNSUPPORTED_MSG =
  "Dropbox sign-in isn't available in this browser. Use another storage provider instead.";
const NO_KEY_MSG =
  "This build of Konode has no Dropbox app key, so it can't sign in to Dropbox.";
const WINDOW_CLOSED_MSG =
  "The Dropbox sign-in window closed before the sign-in came back to Konode. Try again.";
/** Rejected sooner than anyone could close a page, as Yandex for Android does with every
 *  auth window (see the same case in gdrive-oauth.ts). */
const CLOSED_AT_ONCE_MSG =
  "The Dropbox sign-in window closed at once, before Dropbox's page could load. If you " +
  "didn't close it, this browser doesn't let extensions sign in: use another storage provider.";
const CLOSED_AT_ONCE_MS = 1500;
const SIGNIN_FAILED_MSG =
  "Dropbox sign-in didn't complete. What the browser reported is in Settings → Activity. Try again.";
const DECLINED_MSG =
  "Access was not allowed on Dropbox's consent screen. Try again to connect Dropbox.";
export const DROPBOX_EXPIRED_MSG =
  "Dropbox no longer accepts Konode's saved access. Open Konode's Settings and sign in to Dropbox again.";

const TOKEN_BUSY_MSG =
  "Dropbox is busy and asked Konode to wait. Try again in a minute. (HTTP 429)";
const TOKEN_DOWN_MSG =
  "Dropbox couldn't finish the sign-in just now. Try again in a minute.";

const WINDOW_CLOSED_RE = /cancel|denied|did not approve/i;
const UNSUPPORTED_RE = /not an object|not a function|parameters\.length/i;

/** Whether an interactive Dropbox sign-in can be attempted here: the browser has the
 *  auth window (Firefox for Android has no `identity`) and the build has an app key. */
export function isDropboxAuthAvailable(): boolean {
  if (!DROPBOX_APP_KEY) return false;
  try {
    return typeof browser.identity?.launchWebAuthFlow === "function";
  } catch {
    return false;
  }
}

// ─── Session storage ────────────────────────────────────────────────────────

export async function loadDropboxSession(): Promise<DropboxSession | null> {
  const r = await browser.storage.local.get(STORAGE_KEY);
  return (r[STORAGE_KEY] as DropboxSession | undefined) ?? null;
}

async function saveDropboxSession(s: DropboxSession): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEY]: s });
}

/**
 * Forget the session here, and revoke its token at Dropbox so it stops working for good.
 * The revoke is best-effort: a device that is offline still forgets, and the user can
 * remove the app at dropbox.com/account/connected_apps. Only this device's token is
 * revoked; every device signs in on its own and holds its own.
 */
export async function clearDropboxSession(): Promise<void> {
  const s = await loadDropboxSession();
  await browser.storage.local.remove(STORAGE_KEY);
  if (!s?.access_token) return;
  try {
    const token = s.expires_at > Date.now() + EXPIRY_BUFFER_MS || !s.refresh_token
      ? s.access_token
      : (await exchange({ grant_type: "refresh_token", refresh_token: s.refresh_token })).access_token;
    await fetch(REVOKE_ENDPOINT, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
  } catch (err) {
    logger.info("Dropbox.oauth", `Token revoke skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function getStoredDropboxUser(): Promise<{ email: string; displayName: string; account_id: string } | null> {
  const s = await loadDropboxSession();
  return s ? { email: s.email, displayName: s.displayName, account_id: s.account_id } : null;
}

// ─── Token endpoint ───────────────────────────────────────────────────────────

async function exchange(params: Record<string, string>): Promise<TokenResponse> {
  // No client_secret, ever: a PKCE public client is identified by its app key alone.
  const body = new URLSearchParams({ client_id: DROPBOX_APP_KEY, ...params });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    // The body is JSON (`error`, `error_description`) or plain text, and the text can be a
    // whole server stack trace: a first sign-in on 2026-11-23 got a 429 whose body was 60
    // lines of Go from the App folder's creation, and it reached the screen as the error.
    // The log gets the start of it, the screen a sentence.
    const text = await res.text().catch(() => "");
    let code = "";
    let detail = text;
    try {
      const e = JSON.parse(text);
      code = String(e.error ?? "");
      detail = String(e.error_description ?? "");
    } catch { /* plain text */ }
    logger.warn(
      "Dropbox.oauth",
      `Token request (${params.grant_type}) failed: HTTP ${res.status} ${code} ${detail.replace(/\s+/g, " ").slice(0, 300)}`.trim()
    );
    const message = res.status === 429 ? TOKEN_BUSY_MSG
      : res.status >= 500 ? TOKEN_DOWN_MSG
      : `Dropbox didn't accept the sign-in (HTTP ${res.status}${code ? `, ${code}` : ""}). Try again.`;
    throw new DropboxTokenError(res.status, code, message, retryAfterMs(res));
  }
  return res.json() as Promise<TokenResponse>;
}

export async function fetchDropboxAccount(accessToken: string): Promise<{ account_id: string; email: string; displayName: string } | null> {
  try {
    // An RPC endpoint with no arguments: POST with no body and no Content-Type.
    const res = await fetch(ACCOUNT_ENDPOINT, { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) return null;
    const d = await res.json();
    return { account_id: d.account_id ?? "", email: d.email ?? "", displayName: d.name?.display_name ?? "" };
  } catch {
    return null;
  }
}

// ─── Interactive sign-in (one-time consent → refresh token) ───────────────────

function logSignInEnd(branch: string, detail: string): void {
  logger.warn("Dropbox.oauth", `Sign-in ended (${branch}) for redirect ${dropboxRedirectUri()}: ${detail}`);
}

export async function interactiveDropboxSignIn(): Promise<DropboxSession> {
  if (!DROPBOX_APP_KEY) throw new Error(NO_KEY_MSG);
  if (!isDropboxAuthAvailable()) throw new Error(UNSUPPORTED_MSG);
  // As on Drive: whatever is stored survives until this flow SUCCEEDS, so closing the
  // window never leaves a working device without its refresh token.
  const verifier = randomVerifier();
  const challenge = await codeChallenge(verifier);
  const authUrl =
    `${AUTH_ENDPOINT}?client_id=${encodeURIComponent(DROPBOX_APP_KEY)}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(dropboxRedirectUri())}` +
    `&code_challenge=${challenge}&code_challenge_method=S256` +
    `&token_access_type=offline`;

  let responseUrl: string | undefined;
  const started = Date.now();
  try {
    responseUrl = await browser.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof TypeError || UNSUPPORTED_RE.test(msg)) {
      logSignInEnd("browser refused", msg);
      throw new Error(UNSUPPORTED_MSG);
    }
    if (WINDOW_CLOSED_RE.test(msg)) {
      const took = Date.now() - started;
      if (took < CLOSED_AT_ONCE_MS) {
        logSignInEnd("closed at once", `${msg} (after ${took} ms)`);
        throw new Error(CLOSED_AT_ONCE_MSG);
      }
      logSignInEnd("window closed", msg);
      throw new Error(WINDOW_CLOSED_MSG);
    }
    logSignInEnd("flow failed", msg);
    throw new Error(SIGNIN_FAILED_MSG);
  }
  if (!responseUrl) {
    logSignInEnd("no redirect", "the browser returned no URL");
    throw new Error(WINDOW_CLOSED_MSG);
  }

  const parsed = new URL(responseUrl);
  const code = parsed.searchParams.get("code");
  if (!code) {
    const error = parsed.searchParams.get("error");
    logSignInEnd("Dropbox answered", error ? `error=${error}` : "no code and no error");
    if (error === "access_denied") throw new Error(DECLINED_MSG);
    throw new Error(`Dropbox sign-in failed: ${error ?? "no code"}. Try again.`);
  }

  // Retried on a 429 or 5xx (Retry-After honoured): an app's first sign-in is when Dropbox
  // creates its App folder, and that answered 429 in testing. A code lives a few minutes.
  const tok = await withRetry(() => exchange({
    grant_type: "authorization_code",
    code,
    redirect_uri: dropboxRedirectUri(),
    code_verifier: verifier,
  }), { maxAttempts: 4, baseDelayMs: 1500 });
  const account = await fetchDropboxAccount(tok.access_token);
  const session: DropboxSession = {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at: Date.now() + (tok.expires_in ?? 14_400) * 1000,
    account_id: account?.account_id || tok.account_id || "",
    email: account?.email ?? "",
    displayName: account?.displayName ?? "",
    savedAt: Date.now(),
  };
  await saveDropboxSession(session);
  // No email in the log (PR-L2): the UI shows the account, the log needs the outcome.
  logger.event("Dropbox.oauth", `Signed in. Refresh token ${tok.refresh_token ? "stored" : "MISSING (re-consent needed)"}`);
  return session;
}

// ─── Get a valid access token, refreshing silently when possible ──────────────

/**
 * A valid access token. `force` refreshes even when the stored one looks current: the
 * backend passes it after a 401, which means Dropbox has stopped taking that token whatever
 * its expiry says (revoked, or a clock that is off).
 */
export async function getDropboxAccessToken(force = false): Promise<string> {
  const session = await loadDropboxSession();
  if (!session) throw new Error("Not signed in to Dropbox. Open Konode's Settings and sign in.");

  if (!force && session.access_token && session.expires_at > Date.now() + EXPIRY_BUFFER_MS) {
    return session.access_token;
  }
  if (!session.refresh_token) throw new Error(DROPBOX_EXPIRED_MSG);

  try {
    const tok = await exchange({ grant_type: "refresh_token", refresh_token: session.refresh_token });
    const updated: DropboxSession = {
      ...session,
      access_token: tok.access_token,
      expires_at: Date.now() + (tok.expires_in ?? 14_400) * 1000,
      refresh_token: tok.refresh_token ?? session.refresh_token,
      savedAt: Date.now(),
    };
    await saveDropboxSession(updated);
    logger.info("Dropbox.oauth", "Access token refreshed");
    return updated.access_token;
  } catch (err) {
    // 400 invalid_grant: the refresh token was revoked (the app removed in Dropbox's
    // connected apps, or the account's password reset). Nothing here can fix that.
    if (err instanceof DropboxTokenError && err.status === 400) {
      logger.warn("Dropbox.oauth", `Refresh refused: ${err.message}`);
      throw new Error(DROPBOX_EXPIRED_MSG);
    }
    // Anything else (offline, 5xx) is the network's, and the caller retries it as such.
    throw err;
  }
}

/**
 * Google Drive OAuth — authorization-code + PKCE flow with a refresh token.
 *
 * Why not chrome.identity.getAuthToken? It only works on real Chrome (signed
 * into a Google account); Brave/Helium/ungoogled don't ship Google integration.
 * Why not the implicit grant? Its token dies after ~1h with no refresh, and a
 * silent re-auth (prompt=none) can't reach the browser's Google session on Brave.
 *
 * So: one interactive consent obtains a refresh token; thereafter access tokens
 * are minted by a plain HTTPS POST to the token endpoint — no UI, no browser
 * session needed — which works identically on every Chromium browser.
 *
 * The client_secret is injected at BUILD TIME from VITE_GOOGLE_CLIENT_SECRET (a
 * gitignored .env) — never committed, so the public source stays clean and Google's
 * secret-scanning has nothing to flag. It still ships inside the packaged extension
 * (extractable), which is acceptable for an installed app: it's scoped to drive.file
 * (only Konode's own files) and can be rotated in the Google Cloud Console at any
 * time. A source build without the var yields an empty secret — supply your own
 * OAuth client to use the Drive backend from a self-built copy.
 */

import { logger } from "@/lib/utils/logger";
import { KEYS } from "@/lib/utils/storage";
import { browser } from "@/lib/utils/ext";

const CLIENT_ID = "754300898931-2gejbfi1k9ul3lct0n09ke128gtv4j8l.apps.googleusercontent.com";
const CLIENT_SECRET = import.meta.env.VITE_GOOGLE_CLIENT_SECRET ?? "";
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const STORAGE_KEY = KEYS.GDRIVE_SESSION;
const EXPIRY_BUFFER_MS = 60_000; // refresh a minute before the token actually expires

export interface GDriveSession {
  access_token: string;
  refresh_token?: string;
  expires_at: number; // epoch ms
  email: string;
  displayName: string;
  savedAt: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

function redirectUri(): string {
  return browser.identity.getRedirectURL("gdrive");
}

const DRIVE_UNSUPPORTED_MSG =
  "Google Drive sign-in isn't available in this browser. Use GitHub or WebDAV instead.";

/*
 * What the user is told when a sign-in ends without a session (#40). Each says only what
 * the code can know, and each names the two backends that need no Google sign-in, which is
 * true whatever went wrong.
 *
 * They used to say more than that. A closed window was "Sign-in cancelled", told to people
 * who had approved: the engine's cancel-shaped rejection means only that the window closed
 * before the browser saw the redirect, and a redirect_uri_mismatch on Google's error page or
 * a browser that navigates to the redirect instead of catching it ends exactly the same way.
 * And every other failure blamed an unregistered redirect URL, the right guess until the
 * bare `https://<extension-id>.chromiumapp.org/` form was registered on 2026-09-08 and a
 * wrong one since, which is part of why #24 ran for a week.
 */

/** The window closed before the sign-in came back. Declining, a Google error page and a
 *  browser that never hands the redirect back all end here, so it names none of them. */
const DRIVE_WINDOW_CLOSED_MSG =
  "The Google sign-in window closed before the sign-in came back to Konode. Try again, or " +
  "use GitHub or WebDAV, which need no Google sign-in.";

/** The flow failed some other way. The browser's own words go to the log, not the screen. */
const DRIVE_SIGNIN_FAILED_MSG =
  "Google sign-in didn't complete. What the browser reported is in Settings → Activity. " +
  "Try again, or use GitHub or WebDAV, which need no Google sign-in.";

/** The one case where someone certainly declined: Google says so in the redirect. */
const DRIVE_DECLINED_MSG =
  "Sign-in was cancelled on Google's consent screen. Try again to connect Google Drive, or " +
  "use GitHub or WebDAV, which need no Google sign-in.";

/** How Chromium ("The user did not approve access.") and Firefox ("User cancelled or denied
 *  access.") reject when the auth window closes before a redirect they recognise. */
const WINDOW_CLOSED_RE = /cancel|denied|did not approve/i;

/** An engine whose auth bridge refuses the call outright, rather than a flow that ran
 *  and failed. iOS WebKit (Orion) exposes launchWebAuthFlow but throws a native
 *  TypeError-shaped error the moment it's invoked. */
const UNSUPPORTED_RE = /not an object|not a function|parameters\.length/i;

/**
 * Whether interactive Google sign-in can even be attempted here.
 *
 * `chrome.identity.launchWebAuthFlow` is absent on some engines, so the UI uses
 * this to disable the Drive option up front rather than failing mid-flow. Note it
 * can't catch every case: on iOS WebKit (e.g. Orion) the method is *present* but
 * throws an opaque native error when actually invoked ("undefined is not an object
 * (evaluating 'parameters.length')") — that case is handled by the try/catch in
 * interactiveSignIn.
 *
 * It also can't tell whether this engine's redirect URL is one Google will accept:
 * that depends on the OAuth client's registered redirect URIs, which we can't read.
 * A mismatch therefore surfaces as a failed flow, not as an up-front block.
 */
export function isDriveAuthAvailable(): boolean {
  try {
    return typeof browser.identity?.launchWebAuthFlow === "function";
  } catch {
    return false;
  }
}

// ─── Session storage ────────────────────────────────────────────────────────

export async function loadGDriveSession(): Promise<GDriveSession | null> {
  const r = await browser.storage.local.get(STORAGE_KEY);
  return (r[STORAGE_KEY] as GDriveSession | undefined) ?? null;
}

async function saveGDriveSession(s: GDriveSession): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEY]: s });
}

export async function clearGDriveSession(): Promise<void> {
  await browser.storage.local.remove(STORAGE_KEY);
}

export async function getStoredGDriveUser(): Promise<{ email: string; displayName: string } | null> {
  const s = await loadGDriveSession();
  return s ? { email: s.email, displayName: s.displayName } : null;
}

// ─── PKCE helpers ─────────────────────────────────────────────────────────────

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomVerifier(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(64)));
}

async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

// ─── Token endpoint ───────────────────────────────────────────────────────────

async function exchange(params: Record<string, string>): Promise<TokenResponse> {
  const body = new URLSearchParams({ client_id: CLIENT_ID, ...params });
  // Only send a client_secret when one is configured. The Web-app client requires it
  // for the token exchange (PKCE alone isn't accepted for a Web client), so official
  // builds inject it via VITE_GOOGLE_CLIENT_SECRET. A source build without the var
  // sends no secret (and would need its own public/desktop OAuth client to work).
  if (CLIENT_SECRET) body.set("client_secret", CLIENT_SECRET);
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({} as Record<string, string>));
    throw new Error(`Google token request failed: ${res.status} ${e.error ?? ""} ${e.error_description ?? ""}`.trim());
  }
  return res.json() as Promise<TokenResponse>;
}

async function fetchUserInfo(accessToken: string): Promise<{ email: string; displayName: string }> {
  try {
    const res = await fetch("https://www.googleapis.com/drive/v3/about?fields=user", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return { email: "", displayName: "" };
    const d = await res.json();
    return { email: d.user?.emailAddress ?? "", displayName: d.user?.displayName ?? "" };
  } catch {
    return { email: "", displayName: "" };
  }
}

// ─── Interactive sign-in (one-time consent → refresh token) ───────────────────

/**
 * One Activity line for every way a sign-in ends without a session, saying which way.
 *
 * Only two of the five exits used to log, with the same words, so a user asked to check
 * Settings → Activity could not tell us which one they had hit, and neither could we. The
 * redirect URI goes in every line: it is the exact string Google's client must have
 * registered, it is invisible anywhere else, and it is what settled #24. The engine's own
 * words stay here and out of the UI.
 */
function logSignInEnd(branch: string, detail: string): void {
  logger.warn("GDrive.oauth", `Sign-in ended (${branch}) for redirect ${redirectUri()}: ${detail}`);
}

export async function interactiveSignIn(): Promise<GDriveSession> {
  if (!isDriveAuthAvailable()) throw new Error(DRIVE_UNSUPPORTED_MSG);
  // Whatever session is already stored survives until this flow SUCCEEDS. It used to be
  // cleared up front, which made closing the consent window destructive: the refresh token
  // was already gone, so a cancelled attempt left a device that had been syncing a moment
  // earlier unable to sync at all, while Settings went on showing the account as connected
  // (it only drops what it displays on an explicit disconnect). Nothing needed the early
  // clear: `prompt=consent` asks Google for fresh consent regardless of what is stored
  // here, and a flow that reaches the end overwrites the session below.
  const previous = await loadGDriveSession();
  const verifier = randomVerifier();
  const challenge = await codeChallenge(verifier);
  const authUrl =
    `${AUTH_ENDPOINT}?client_id=${encodeURIComponent(CLIENT_ID)}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(redirectUri())}` +
    `&scope=${encodeURIComponent(SCOPE)}` +
    `&code_challenge=${challenge}&code_challenge_method=S256` +
    // offline + consent → Google returns (and keeps returning) a refresh token.
    `&access_type=offline&prompt=consent`;

  // The polyfill returns a promise that resolves to the redirect URL (and rejects
  // on cancel / error) on both Chromium and Firefox — no chrome.runtime.lastError.
  let responseUrl: string | undefined;
  try {
    responseUrl = await browser.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Only claim the platform is unsupported when the auth bridge itself refused.
    if (err instanceof TypeError || UNSUPPORTED_RE.test(msg)) {
      logSignInEnd("browser refused", msg);
      throw new Error(DRIVE_UNSUPPORTED_MSG);
    }
    if (WINDOW_CLOSED_RE.test(msg)) {
      logSignInEnd("window closed", msg);
      throw new Error(DRIVE_WINDOW_CLOSED_MSG);
    }
    logSignInEnd("flow failed", msg);
    throw new Error(DRIVE_SIGNIN_FAILED_MSG);
  }
  // An engine that resolves with nothing has the same thing to tell us as a closed window.
  if (!responseUrl) {
    logSignInEnd("no redirect", "the browser returned no URL");
    throw new Error(DRIVE_WINDOW_CLOSED_MSG);
  }

  const parsed = new URL(responseUrl);
  const code = parsed.searchParams.get("code");
  if (!code) {
    const error = parsed.searchParams.get("error");
    logSignInEnd("Google answered", error ? `error=${error}` : "no code and no error");
    if (error === "access_denied") throw new Error(DRIVE_DECLINED_MSG);
    throw new Error(
      `Google sign-in failed: ${error ?? "no code"}. Try again, or use GitHub or WebDAV, which need no Google sign-in.`
    );
  }

  const tok = await exchange({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
    code_verifier: verifier,
  });
  const user = await fetchUserInfo(tok.access_token);
  // Google returns a refresh token for `access_type=offline&prompt=consent`, but if it
  // ever omits one, the token we already hold beats no token: losing it is precisely what
  // forces the re-consent that just happened. Only for the SAME account though, and only
  // when we can name it, because inheriting another account's refresh token would quietly
  // renew us into the wrong Drive.
  const sameAccount = !!user.email && previous?.email === user.email;
  const session: GDriveSession = {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token ?? (sameAccount ? previous?.refresh_token : undefined),
    expires_at: Date.now() + (tok.expires_in ?? 3600) * 1000,
    email: user.email,
    displayName: user.displayName,
    savedAt: Date.now(),
  };
  await saveGDriveSession(session);
  // Don't persist the account email in the audit log (PR-L2) — the signed-in
  // account is already shown in the UI; the log just needs the outcome.
  const tokenNote = tok.refresh_token
    ? "stored"
    : session.refresh_token
      ? "not returned, kept the one we had"
      : "MISSING (re-consent needed)";
  logger.event("GDrive.oauth", `Signed in. Refresh token ${tokenNote}`);
  return session;
}

// ─── Get a valid access token, refreshing silently when possible ──────────────

export async function getAccessToken(interactive = false): Promise<string> {
  const session = await loadGDriveSession();

  if (session?.access_token && session.expires_at > Date.now() + EXPIRY_BUFFER_MS) {
    return session.access_token;
  }

  if (session?.refresh_token) {
    try {
      const tok = await exchange({ grant_type: "refresh_token", refresh_token: session.refresh_token });
      const updated: GDriveSession = {
        ...session,
        access_token: tok.access_token,
        expires_at: Date.now() + (tok.expires_in ?? 3600) * 1000,
        refresh_token: tok.refresh_token ?? session.refresh_token, // Google may omit it
        savedAt: Date.now(),
      };
      await saveGDriveSession(updated);
      logger.info("GDrive.oauth", "Access token refreshed");
      return updated.access_token;
    } catch (err) {
      logger.warn("GDrive.oauth", `Refresh failed: ${err instanceof Error ? err.message : String(err)}`);
      // Fall through — interactive re-consent or a clear error.
    }
  }

  if (interactive) return (await interactiveSignIn()).access_token;
  throw new Error("Google session expired. Open Konode and sign in again.");
}

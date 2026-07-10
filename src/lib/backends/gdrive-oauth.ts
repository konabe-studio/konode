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
 * The client_secret below is NOT confidential: Google issues it for a "Web
 * application" client, and for an installed app it necessarily ships in the
 * bundle (extractable). It is scoped to drive.file (only Konode's own files) and
 * can be rotated in the Google Cloud Console at any time.
 */

import { logger } from "@/lib/utils/logger";
import { KEYS } from "@/lib/utils/storage";

const CLIENT_ID = "290320131573-l79rlp36rgmuc5bkisoqfcjc4k9t58dq.apps.googleusercontent.com";
const CLIENT_SECRET = "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";
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
  return chrome.identity.getRedirectURL("gdrive");
}

// ─── Session storage ────────────────────────────────────────────────────────

export async function loadGDriveSession(): Promise<GDriveSession | null> {
  const r = await chrome.storage.local.get(STORAGE_KEY);
  return (r[STORAGE_KEY] as GDriveSession | undefined) ?? null;
}

async function saveGDriveSession(s: GDriveSession): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: s });
}

export async function clearGDriveSession(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
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
  // Only send a client_secret when one is configured. The preferred setup is a
  // PUBLIC OAuth client with NO secret — PKCE's code_verifier is the proof — in
  // which case CLIENT_SECRET is "" and this line drops out of the request. With the
  // current Web-app client the secret is still present, so behavior is unchanged
  // until the client is swapped (PR-H1): set the new public client_id + empty
  // CLIENT_SECRET, and no code here changes.
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

export async function interactiveSignIn(): Promise<GDriveSession> {
  await clearGDriveSession();
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

  const responseUrl = await new Promise<string>((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, (url) => {
      if (chrome.runtime.lastError || !url) {
        reject(new Error(chrome.runtime.lastError?.message ?? "Sign-in cancelled"));
      } else {
        resolve(url);
      }
    });
  });

  const parsed = new URL(responseUrl);
  const code = parsed.searchParams.get("code");
  if (!code) {
    throw new Error(`Google sign-in failed: ${parsed.searchParams.get("error") ?? "no code"}`);
  }

  const tok = await exchange({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
    code_verifier: verifier,
  });
  const user = await fetchUserInfo(tok.access_token);
  const session: GDriveSession = {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at: Date.now() + (tok.expires_in ?? 3600) * 1000,
    email: user.email,
    displayName: user.displayName,
    savedAt: Date.now(),
  };
  await saveGDriveSession(session);
  // Don't persist the account email in the audit log (PR-L2) — the signed-in
  // account is already shown in the UI; the log just needs the outcome.
  logger.info(
    "GDrive.oauth",
    `Signed in — refresh token ${tok.refresh_token ? "stored" : "MISSING (re-consent needed)"}`
  );
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
  throw new Error("Google session expired — open Konode and sign in again.");
}

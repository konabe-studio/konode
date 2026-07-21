// ─── URL scheme guards used across sync boundaries ─────────────────────────

/**
 * A URL is safe to open/import as synced *content* (a restored tab, a history
 * entry) only if it is plain web navigation. A tampered or peer-supplied packet
 * could otherwise carry a `javascript:` / `data:` / `file:` URL that a session
 * restore would execute or expose — the checksum only proves the file matches
 * what its author wrote, not that the author is trustworthy. So we hard-whitelist
 * http(s) on import.
 */
export function isSafeContentUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  try {
    const scheme = new URL(url).protocol;
    return scheme === "http:" || scheme === "https:";
  } catch {
    return false;
  }
}

// Query/fragment param names that carry an authentication secret. A URL exposing
// any of these must be kept out of synced history — even E2EE'd, uploading a live
// OAuth token (or a reset/one-time token) to third-party storage is more data than
// necessary. `token` also covers `access_token` / `refresh_token` / `csrf_token`
// as a substring, but the explicit names document intent.
const SENSITIVE_URL_PARAMS = [
  "access_token", "id_token", "refresh_token", "client_secret",
  "token", "password", "otp", "api_key", "apikey",
];

/**
 * True if a URL carries an auth secret in its query OR fragment (many OAuth
 * providers return the token in the `#fragment`, e.g.
 * `.../callback#access_token=…`). Used to exclude such URLs from history sync.
 * Matches a sensitive name as a param KEY (`name=`), so a value that merely
 * contains the word doesn't trip it. Unparseable URLs are treated as not sensitive
 * (they're rejected elsewhere by isSafeContentUrl).
 */
export function isSensitiveUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    const haystacks = [u.search.toLowerCase(), u.hash.toLowerCase()];
    return SENSITIVE_URL_PARAMS.some((p) => haystacks.some((h) => h.includes(`${p}=`)));
  } catch {
    return false;
  }
}

/**
 * A stable identity key for a bookmark URL, used ONLY for cross-device dedup /
 * merge matching — never for what we store or open (we keep the original string).
 *
 * Different browser engines canonicalize a bare origin differently: Chromium and
 * Firefox store `https://telex.hu/` (trailing slash on the empty path), while
 * WebKit (Safari / Orion) stores `https://telex.hu` (no slash). A merge that keys
 * on the raw string then treats the two as distinct bookmarks and re-adds the
 * peer's form every sync — an unbounded duplication of bare-origin bookmarks.
 * `new URL(url).href` normalizes both to the same value (and only the empty path
 * gets the slash — `/a` and `/a/` stay distinct, so real paths aren't merged).
 * Falls back to the raw string for anything unparseable.
 */
export function canonicalUrlKey(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

/**
 * A WebDAV backend URL is secure enough to send Basic-auth credentials to only
 * over HTTPS — or over HTTP to a loopback host (localhost / 127.0.0.1 / ::1),
 * where there is no network path to sniff (self-hosted local testing). Any other
 * `http://` is rejected: Basic auth is reversible base64 sent on every request.
 */
export function isSecureBackendUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (u.protocol === "https:") return true;
    if (u.protocol === "http:") {
      const h = u.hostname;
      return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
    }
    return false;
  } catch {
    return false;
  }
}

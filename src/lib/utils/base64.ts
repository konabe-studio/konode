// ─── UTF-8 safe base64 ──────────────────────────────────────────────────────
// `btoa` takes a *binary string*: it throws on any code point above U+00FF and
// silently treats U+0080–U+00FF as single ISO-8859-1 bytes. Neither is what you want
// for text. Both failure modes were live:
//
//  - WebDAV Basic auth used raw `btoa("user:password")`, so a password containing
//    `ő`, `ű`, `ł`, `€`, Cyrillic or an emoji threw InvalidCharacterError and every
//    sync failed hard; a merely accented one (`á`, `ö`, `ü`) encoded as Latin-1 while
//    Nextcloud/ownCloud/SabreDAV decode UTF-8, so a CORRECT password was rejected
//    forever with "Authentication failed".
//  - The GitHub backend got it right, but via `btoa(unescape(encodeURIComponent(s)))`
//    — correct yet built on deprecated `unescape`, and duplicated per call site.
//
// One helper, so the two can't drift apart again.

/** Base64 of a string's UTF-8 bytes. */
export function utf8ToBase64(input: string): string {
  const bytes = new TextEncoder().encode(input);
  // Chunked: `String.fromCharCode(...bytes)` spreads every byte as its own argument
  // and throws RangeError on large payloads (a full bookmark tree, a history export).
  let binary = "";
  const CHUNK = 0x8000; // 32 KiB, well under the argument-count limit
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

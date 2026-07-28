import { describe, it, expect } from "vitest";
import { utf8ToBase64 } from "@/lib/utils/base64";

/** base64 → the original text, going through UTF-8 bytes. */
function decode(b64: string): string {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

describe("utf8ToBase64", () => {
  it("round-trips ASCII", () => {
    expect(decode(utf8ToBase64("user:password"))).toBe("user:password");
    expect(utf8ToBase64("")).toBe("");
  });

  it("handles code points raw btoa() REJECTS outright (above U+00FF)", () => {
    // Each of these made btoa throw InvalidCharacterError, which is neither an
    // HttpError nor a network TypeError — so the retry logic gave up and the sync
    // failed hard, permanently. `ű` is U+0171, just past the Latin-1 ceiling.
    for (const s of ["Árvíztűrő", "паролü", "🔐pass", "10€", "hasło"]) {
      expect(() => btoa(s)).toThrow();               // the old behaviour
      expect(decode(utf8ToBase64(s))).toBe(s);        // the new one
    }
  });

  it("emits UTF-8 bytes, not Latin-1, for U+0080–U+00FF", () => {
    // The quieter half: these do NOT throw under raw btoa — they silently produce
    // ISO-8859-1, which Nextcloud/ownCloud/SabreDAV decode as UTF-8, so a CORRECT
    // password never matched. Note "tükörfúrógép" is entirely within Latin-1, so it
    // lands here rather than in the throwing case above — the two halves of the
    // Hungarian pangram hit the two different failure modes.
    for (const s of ["tükörfúrógép", "bén:jámín", "señor", "größe"]) {
      expect(() => btoa(s)).not.toThrow();      // it "worked" — just with wrong bytes
      expect(utf8ToBase64(s)).not.toBe(btoa(s)); // and we now send different ones
      expect(decode(utf8ToBase64(s))).toBe(s);
    }
    expect(atob(utf8ToBase64("ö")).length).toBe(2); // 0xC3 0xB6 — UTF-8
    expect(atob(btoa("ö")).length).toBe(1);         // 0xF6 — what we used to send
  });

  it("is byte-identical to the legacy unescape(encodeURIComponent(…)) idiom", () => {
    // Proves swapping the GitHub backend onto this helper changes nothing on the wire.
    const legacy = (s: string): string => btoa(unescape(encodeURIComponent(s)));
    for (const s of ["plain", "Árvíztűrő tükörfúrógép", '{"url":"https://példa.hu/ó"}', "🔐"]) {
      expect(utf8ToBase64(s)).toBe(legacy(s));
    }
  });

  it("does not blow the argument limit on a large payload", () => {
    // A full bookmark tree or history export goes through here; the unchunked
    // String.fromCharCode(...bytes) spread throws RangeError well below this size.
    const big = "á".repeat(200_000); // 400 KB of UTF-8
    expect(decode(utf8ToBase64(big))).toBe(big);
  });
});

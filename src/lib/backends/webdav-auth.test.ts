import { describe, it, expect, afterEach, vi } from "vitest";
import { WebDAVBackend } from "./webdav-backend";
import type { BackendConfig, SyncPacket } from "@/lib/types";

// A WebDAV password with non-ASCII characters used to break sync outright: raw btoa()
// throws above U+00FF (`ő`, `ű`, `€`, Cyrillic, emoji) and that DOMException is neither
// an HttpError nor a network TypeError, so withRetry gave up and the sync failed hard.
// For `á`/`ö`/`ü` it didn't throw but sent ISO-8859-1 bytes, which Nextcloud/ownCloud/
// SabreDAV decode as UTF-8 — a CORRECT password rejected forever.

const HUNGARIAN_PASS = "Árvíztűrő-tükörfúrógép";

const config = (username: string, password: string): BackendConfig => ({
  type: "webdav",
  label: "WebDAV",
  enabled: true,
  webdav: { url: "https://cloud.example.com/remote.php/dav/files/ben/", username, password },
});

const packet = (): SyncPacket => ({
  version: "1.0",
  device_id: "dev-1",
  timestamp: "2026-07-28T10:00:00.000Z",
  data_type: "bookmarks",
  checksum: "a".repeat(64),
  encrypted: false,
  payload: "[]",
});

/** The credentials the server would actually recover from the header. */
function credsFrom(header: string): string {
  const bytes = Uint8Array.from(atob(header.replace(/^Basic /, "")), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Captures the Authorization header of every request. */
function captureAuth(): string[] {
  const seen: string[] = [];
  vi.stubGlobal("fetch", (_url: string, init?: { headers?: Record<string, string> }) => {
    const h = init?.headers ?? {};
    if (h.Authorization) seen.push(h.Authorization);
    return Promise.resolve({
      ok: true,
      status: 207,
      text: () => Promise.resolve(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"></d:multistatus>`),
    } as Response);
  });
  return seen;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WebDAV Basic auth is UTF-8, and doesn't throw on non-ASCII", () => {
  it("sends a Hungarian password as UTF-8 on upload", async () => {
    const seen = captureAuth();

    await new WebDAVBackend(config("bén", HUNGARIAN_PASS)).upload(packet());

    expect(seen).not.toHaveLength(0);
    expect(credsFrom(seen[0])).toBe(`bén:${HUNGARIAN_PASS}`);
  });

  it("uses the same encoding on the peer-file download path", async () => {
    // This was inlined separately from headers(), so it could drift on its own.
    const seen = captureAuth();

    await new WebDAVBackend(config("bén", HUNGARIAN_PASS)).downloadAll("bookmarks", "me");

    expect(seen).not.toHaveLength(0);
    for (const h of seen) expect(credsFrom(h)).toBe(`bén:${HUNGARIAN_PASS}`);
  });

  it("does not reject a password raw btoa() couldn't even encode", async () => {
    for (const pass of ["ő-ű-jelszó", "пароль", "10€uro", "🔐key"]) {
      const seen = captureAuth();
      // The whole operation must complete — this used to reject with
      // "The string to be encoded contains characters outside of the Latin1 range."
      await expect(new WebDAVBackend(config("user", pass)).upload(packet())).resolves.toBeUndefined();
      expect(credsFrom(seen[0])).toBe(`user:${pass}`);
      vi.unstubAllGlobals();
    }
  });

  it("keeps a plain ASCII password byte-for-byte unchanged", async () => {
    const seen = captureAuth();

    await new WebDAVBackend(config("ben", "plain-app-password")).upload(packet());

    expect(seen[0]).toBe(`Basic ${btoa("ben:plain-app-password")}`);
  });
});

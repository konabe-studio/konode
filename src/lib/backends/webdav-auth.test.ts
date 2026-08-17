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

// A 401 was reported as "Authentication failed. Check username/password" whatever the
// server meant by it. ownCloud Infinite Scale ships HTTP Basic OFF
// (PROXY_ENABLE_BASIC_AUTH=false) and authenticates over OIDC, so it answers a correct
// username and password with 401 + `WWW-Authenticate: Bearer` forever. A field report
// came in from exactly that: the reporter went looking at their password, which was fine
// the whole time. The challenge header is the server telling us which scheme it accepts,
// and we were throwing it away.

/** Stub every fetch with one status + headers, and count the calls. */
function stub401(status: number, headers: Record<string, string>): { calls: number } {
  const state = { calls: 0 };
  vi.stubGlobal("fetch", () => {
    state.calls++;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      redirected: false,
      headers: new Headers(headers),
      text: () => Promise.resolve(""),
    } as Response);
  });
  return state;
}

describe("WebDAV 401: a refused SCHEME is not a wrong password", () => {
  it("names the scheme the server asked for instead of blaming the credentials", async () => {
    stub401(401, { "WWW-Authenticate": 'Bearer realm="ocis", error="invalid_token"' });

    const res = await new WebDAVBackend(config("ben", "correct-password")).testConnection();

    expect(res.ok).toBe(false);
    expect(res.message).toContain("Bearer");
    expect(res.message).not.toContain("Check username/password");
    // The actionable half: an app token goes in the same field, so say so.
    expect(res.message).toContain("PROXY_ENABLE_APP_AUTH");
  });

  it("still blames the credentials when the server does offer Basic", async () => {
    stub401(401, { "WWW-Authenticate": 'Basic realm="Nextcloud"' });

    const res = await new WebDAVBackend(config("ben", "wrong-password")).testConnection();

    expect(res.message).toBe("Authentication failed. Check username/password");
  });

  it("falls back to the ordinary message when there is no challenge at all", async () => {
    stub401(401, {});

    const res = await new WebDAVBackend(config("ben", "wrong-password")).testConnection();

    expect(res.message).toBe("Authentication failed. Check username/password");
  });

  it("does not mistake the word basic inside a realm for a Basic challenge", async () => {
    // The parser has to read scheme tokens, not the whole string: a realm is free text and
    // a server may well call its realm "basic auth disabled".
    stub401(401, { "WWW-Authenticate": 'Bearer realm="basic auth disabled"' });

    const res = await new WebDAVBackend(config("ben", "correct-password")).testConnection();

    expect(res.message).toContain("Bearer");
    expect(res.message).not.toContain("Check username/password");
  });

  it("reports auth, not the sync folder, when the FIRST SYNC hits a 401", async () => {
    // The worst version of this. Onboarding saves and fires SYNC_NOW instead of running
    // Test connection, so the message a new user actually sees came from ensureFolder:
    // "Couldn't create the sync folder ... Check the path and that the account may write
    // to it" — folder permissions, for an authentication failure.
    const state = stub401(401, { "WWW-Authenticate": "Bearer" });

    await expect(new WebDAVBackend(config("ben", "correct-password")).connect())
      .rejects.toThrow(/won't take a username and password/);

    // And it stops at the MKCOL: the PROPFIND existence check can only 401 as well, so
    // asking again just costs a round trip on every failing sync.
    expect(state.calls).toBe(1);
  });

  it("keeps the folder message for a non-auth MKCOL failure", async () => {
    const state = stub401(403, {});

    await expect(new WebDAVBackend(config("ben", "pw")).connect())
      .rejects.toThrow(/Couldn't create the sync folder/);

    expect(state.calls).toBe(2); // MKCOL, then the PROPFIND that asks whether it exists
  });
});

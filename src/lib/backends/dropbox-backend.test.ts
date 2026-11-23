import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { DropboxBackend, dropboxArg } from "./dropbox-backend";
import { KEYS } from "@/lib/utils/storage";
import { browser } from "@/lib/utils/ext";
import type { BackendConfig, SyncPacket } from "@/lib/types";

// The Dropbox backend against a fake of the HTTP API v2: list_folder (+ /continue),
// download, upload, delete_v2, get_current_account, and the token endpoint for refreshes.

const cfg = (account?: string): BackendConfig => ({ type: "dropbox", label: "Dropbox", enabled: true, dropbox: { account } });

const packet = (device_id: string, data_type = "history"): SyncPacket => ({
  version: "1.0", device_id, timestamp: "2026-11-23T10:00:00.000Z",
  data_type: data_type as SyncPacket["data_type"], checksum: "a".repeat(64), encrypted: false, payload: "[]",
});

const session = (over: Record<string, unknown> = {}) => ({
  access_token: "at1", refresh_token: "rt1", expires_at: Date.now() + 3_600_000,
  account_id: "dbid:A", email: "a@example.com", displayName: "Ann", savedAt: 0, ...over,
});

type Call = { url: string; init?: RequestInit; arg?: Record<string, unknown>; body?: unknown; auth?: string };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

function serve(answer: (c: Call) => Response | undefined): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    const h = (init?.headers ?? {}) as Record<string, string>;
    const c: Call = {
      url: String(url), init, auth: h.Authorization,
      arg: h["Dropbox-API-Arg"] ? JSON.parse(h["Dropbox-API-Arg"]) : undefined,
      body: typeof init?.body === "string" && h["Content-Type"] === "application/json" ? JSON.parse(init.body) : init?.body,
    };
    calls.push(c);
    const r = answer(c);
    if (!r) throw new Error(`unexpected request ${c.url}`);
    return Promise.resolve(r);
  });
  return calls;
}

const file = (name: string, hash: string, extra: Record<string, unknown> = {}) => ({
  ".tag": "file", name, path_lower: `/${name.toLowerCase()}`, rev: `rev-${hash}`, content_hash: hash,
  server_modified: "2026-11-23T09:00:00Z", ...extra,
});

beforeEach(async () => {
  await browser.storage.local.set({ [KEYS.DROPBOX_SESSION]: session() });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Dropbox: the listing and the #96 marker", () => {
  it("pages through list_folder/continue, skips our own file and unchanged peers, and downloads the rest", async () => {
    const calls = serve((c) => {
      if (c.url.endsWith("/files/list_folder")) {
        return json({ entries: [
          file("konode_history_me.json", "h-me"),
          file("konode_history_a.json", "h-a"),
          { ".tag": "folder", name: "stray", path_lower: "/stray" },
        ], cursor: "c1", has_more: true });
      }
      if (c.url.endsWith("/files/list_folder/continue")) {
        expect(c.body).toEqual({ cursor: "c1" });
        return json({ entries: [
          file("konode_history_b.json", "h-b"),
          file("konode_bookmarks_b.json", "h-bm"),
          file("konode_snap_bookmarks_1.json", "h-s"),
        ], cursor: "c2", has_more: false });
      }
      if (c.url.endsWith("/files/download")) {
        const id = /konode_history_(\w+)\.json/.exec(String(c.arg?.path))![1];
        return new Response(JSON.stringify(packet(id)), { status: 200 });
      }
    });

    const pull = await new DropboxBackend(cfg()).downloadChanged("history", "me", { a: "h-a", b: "stale" });

    expect(pull.unchanged).toEqual([{ device_id: "a", marker: "h-a", exact: true }]);
    expect(pull.fetched.map((f) => f.file)).toEqual([{ device_id: "b", marker: "h-b", exact: true }]);
    expect(pull.fetched[0].packet.device_id).toBe("b");
    const downloads = calls.filter((c) => c.url.endsWith("/files/download"));
    expect(downloads.map((c) => c.arg)).toEqual([{ path: "/konode_history_b.json" }]);
    expect(downloads[0].url).toBe("https://content.dropboxapi.com/2/files/download");
    // Root of the App folder, files only.
    expect(calls[0].body).toMatchObject({ path: "", recursive: false });
  });

  it("falls back to rev as the marker, and downloads a file whose listing has neither", async () => {
    serve((c) => {
      if (c.url.endsWith("/files/list_folder")) {
        return json({ entries: [
          file("konode_sessions_a.json", "", { content_hash: undefined, rev: "015f" }),
          file("konode_sessions_b.json", "", { content_hash: undefined, rev: undefined }),
        ], has_more: false });
      }
      const id = /konode_sessions_(\w+)\.json/.exec(String(c.arg?.path))![1];
      return new Response(JSON.stringify(packet(id, "sessions")), { status: 200 });
    });
    const pull = await new DropboxBackend(cfg()).downloadChanged("sessions", "me", { a: "015f" });
    expect(pull.unchanged).toEqual([{ device_id: "a", marker: "015f", exact: true }]);
    expect(pull.fetched.map((f) => f.file)).toEqual([{ device_id: "b", marker: null, exact: true }]);
  });

  it("treats a missing App folder as an empty one", async () => {
    serve(() => json({ error_summary: "path/not_found/..", error: { ".tag": "path" } }, 409));
    expect(await new DropboxBackend(cfg()).downloadAll("bookmarks", "me")).toEqual([]);
    expect(await new DropboxBackend(cfg()).listFiles("konode_snap_")).toEqual([]);
  });

  it("leaves out a peer whose file vanished between listing and download", async () => {
    serve((c) => c.url.endsWith("/files/list_folder")
      ? json({ entries: [file("konode_history_a.json", "h")], has_more: false })
      : json({ error_summary: "path/not_found/." }, 409));
    const pull = await new DropboxBackend(cfg()).downloadChanged("history", "me", {});
    expect(pull).toEqual({ fetched: [], unchanged: [] });
  });

  it("lists names by prefix, with Dropbox's server_modified as the time", async () => {
    serve(() => json({ entries: [
      file("konode_snap_bookmarks_100.json", "x", { server_modified: "2026-11-20T08:00:00Z" }),
      file("konode_snap_index.json", "y", { server_modified: "nonsense" }),
      file("konode_history_a.json", "z"),
    ], has_more: false }));
    const b = new DropboxBackend(cfg());
    expect(await b.listFiles("konode_snap_")).toEqual(["konode_snap_bookmarks_100.json", "konode_snap_index.json"]);
    expect(await b.listFilesWithTimes!("konode_snap_")).toEqual([
      { name: "konode_snap_bookmarks_100.json", modified: Date.parse("2026-11-20T08:00:00Z") },
      { name: "konode_snap_index.json", modified: null },
    ]);
  });
});

describe("Dropbox: reading and writing files", () => {
  it("uploads in overwrite mode, muted, as raw bytes, into the App folder root", async () => {
    const calls = serve(() => json({ name: "konode_bookmarks_me.json" }));
    await new DropboxBackend(cfg()).upload(packet("me", "bookmarks"));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://content.dropboxapi.com/2/files/upload");
    expect(calls[0].arg).toEqual({ path: "/konode_bookmarks_me.json", mode: "overwrite", autorename: false, mute: true });
    expect((calls[0].init?.headers as Record<string, string>)["Content-Type"]).toBe("application/octet-stream");
    expect(JSON.parse(String(calls[0].body)).device_id).toBe("me");
    expect(calls[0].auth).toBe("Bearer at1");
  });

  it("says plainly when the Dropbox is full", async () => {
    serve(() => json({ error_summary: "path/insufficient_space/..." }, 409));
    await expect(new DropboxBackend(cfg()).putFile("x.json", "{}")).rejects.toThrow(/Dropbox is full/);
  });

  it("reads a file, and answers null for one that isn't there", async () => {
    serve((c) => c.arg?.path === "/konode_snap_index.json"
      ? new Response('{"x":1}', { status: 200 })
      : json({ error_summary: "path/not_found/.." }, 409));
    const b = new DropboxBackend(cfg());
    expect(await b.getFile("konode_snap_index.json")).toBe('{"x":1}');
    expect(await b.getFile("nope.json")).toBeNull();
  });

  it("deletes through delete_v2, and a file already gone is not an error", async () => {
    const calls = serve(() => json({ error_summary: "path_lookup/not_found/.." }, 409));
    await new DropboxBackend(cfg()).deleteFile("konode_sent_x.json");
    expect(calls[0].url).toBe("https://api.dropboxapi.com/2/files/delete_v2");
    expect(calls[0].body).toEqual({ path: "/konode_sent_x.json" });
  });

  it("escapes non-ASCII in the Dropbox-API-Arg header", () => {
    expect(dropboxArg({ path: "/é😀.json" })).toBe('{"path":"/\\u00e9\\ud83d\\ude00.json"}');
    expect(JSON.parse(dropboxArg({ path: "/é😀.json" }))).toEqual({ path: "/é😀.json" });
  });
});

describe("Dropbox: tokens, rate limits, retries", () => {
  it("refreshes once after a 401 and repeats the request with the new token", async () => {
    const calls = serve((c) => {
      if (c.url.endsWith("/oauth2/token")) return json({ access_token: "at2", expires_in: 14400 });
      if (c.auth === "Bearer at1") return json({ error_summary: "expired_access_token/", error: { ".tag": "expired_access_token" } }, 401);
      return new Response('{"ok":true}', { status: 200 });
    });
    expect(await new DropboxBackend(cfg()).getFile("a.json")).toBe('{"ok":true}');
    expect(calls.map((c) => c.url.replace(/^https:\/\/[^/]+/, ""))).toEqual(["/2/files/download", "/oauth2/token", "/2/files/download"]);
    expect(calls[2].auth).toBe("Bearer at2");
    const stored = (await browser.storage.local.get(KEYS.DROPBOX_SESSION))[KEYS.DROPBOX_SESSION];
    expect(stored.access_token).toBe("at2");
  });

  it("does not refresh for a missing scope, which no token can fix", async () => {
    const calls = serve(() => json({ error_summary: "missing_scope/..", error: { ".tag": "missing_scope", required_scope: "files.content.write" } }, 401));
    await expect(new DropboxBackend(cfg()).putFile("a.json", "{}")).rejects.toThrow(/lacks a permission/);
    expect(calls).toHaveLength(1);
  });

  it("asks for a new sign-in when the refreshed token is refused too", async () => {
    serve((c) => c.url.endsWith("/oauth2/token")
      ? json({ access_token: "at2", expires_in: 14400 })
      : json({ error: { ".tag": "invalid_access_token" } }, 401));
    await expect(new DropboxBackend(cfg()).getFile("a.json")).rejects.toThrow(/sign in to Dropbox again/);
  });

  it("waits out a short Retry-After and tries again", async () => {
    let n = 0;
    serve(() => (++n === 1
      ? json({ error_summary: "too_many_write_operations/" }, 429, { "Retry-After": "0" })
      : json({ name: "a.json" })));
    await new DropboxBackend(cfg()).putFile("a.json", "{}");
    expect(n).toBe(2);
  });

  it("gives up at once on a Retry-After longer than a sync waits, with the rate-limit advice", async () => {
    let n = 0;
    serve(() => { n++; return json({ error_summary: "too_many_requests/" }, 429, { "Retry-After": "300" }); });
    await expect(new DropboxBackend(cfg()).listFiles("x")).rejects.toThrow(/Too many requests: Dropbox/);
    expect(n).toBe(1);
  });

  it("retries a 5xx", async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      serve(() => (++n < 3 ? json({}, 503) : json({ entries: [], has_more: false })));
      const p = new DropboxBackend(cfg()).listFiles("x");
      await vi.runAllTimersAsync();
      expect(await p).toEqual([]);
      expect(n).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Dropbox: connect and test", () => {
  it("refuses to sync into an account other than the saved one", async () => {
    await expect(new DropboxBackend(cfg("dbid:OTHER")).connect()).rejects.toThrow(/not the one in the saved settings/);
    await expect(new DropboxBackend(cfg("dbid:A")).connect()).resolves.toBeUndefined();
    await expect(new DropboxBackend(cfg()).connect()).resolves.toBeUndefined();
  });

  it("tests the connection against Dropbox itself, the account and the folder", async () => {
    const calls = serve((c) => c.url.endsWith("/users/get_current_account")
      ? json({ account_id: "dbid:A", email: "a@example.com", name: { display_name: "Ann B" } })
      : json({ entries: [], has_more: false }));
    const r = await new DropboxBackend(cfg()).testConnection();
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/Connected as Ann B \(a@example.com\)/);
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.dropboxapi.com/2/users/get_current_account",
      "https://api.dropboxapi.com/2/files/list_folder",
    ]);
  });

  it("fails the test when nobody signed in", async () => {
    await browser.storage.local.remove(KEYS.DROPBOX_SESSION);
    expect(await new DropboxBackend(cfg()).testConnection()).toEqual({ ok: false, message: "Not signed in to Dropbox yet." });
  });
});

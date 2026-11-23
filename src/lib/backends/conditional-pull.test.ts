import { describe, it, expect, afterEach, vi } from "vitest";
import { WebDAVBackend, parsePropfindEtags } from "./webdav-backend";
import { GitHubBackend } from "./github-backend";
import { GDriveBackend } from "./gdrive-backend";
import { KEYS } from "@/lib/utils/storage";
import type { BackendConfig } from "@/lib/types";

// #96. Every sync downloaded every peer's file in full. Each backend's listing already
// carries a change marker per file, so a file whose marker is the one the engine remembers
// is left on the server: Drive's md5Checksum, GitHub's blob sha, a WebDAV ETag.

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const packet = (device_id: string) => ({
  version: "1.0", device_id, timestamp: "2026-11-20T10:00:00.000Z",
  data_type: "history", checksum: "a".repeat(64), encrypted: false, payload: "[]",
});

/** Records every URL fetched; `listing` answers the listing, every other URL a packet. */
function serve(listing: (url: string, init?: RequestInit) => Response | null): string[] {
  const fetched: string[] = [];
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    fetched.push(String(url));
    const l = listing(String(url), init);
    if (l) return Promise.resolve(l);
    const id = /konode_history_([^/.?]+)\.json/.exec(String(url))?.[1] ?? /files\/([^/?]+)\?alt=media/.exec(String(url))?.[1] ?? "?";
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(packet(id))) } as Response);
  });
  return fetched;
}

describe("WebDAV: the ETag in the listing", () => {
  const cfg: BackendConfig = {
    type: "webdav", label: "WebDAV", enabled: true,
    webdav: { url: "https://dav.example.com/dav/", username: "u", password: "p" },
  };
  const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
    <d:response><d:href>/dav/konode/</d:href><d:propstat><d:prop><d:getetag>"dir"</d:getetag></d:prop></d:propstat></d:response>
    <d:response><d:href>/dav/konode/konode_history_a.json</d:href><d:propstat><d:prop><d:getetag>"5f3c-1a4"</d:getetag></d:prop></d:propstat></d:response>
    <d:response><d:href>/dav/konode/konode_history_b.json</d:href><d:propstat><d:prop><d:getetag>&quot;66aa&quot;</d:getetag></d:prop></d:propstat></d:response>
    <d:response><d:href>/dav/konode/konode_history_c.json</d:href><d:propstat><d:prop><d:getetag>W/"77bb"</d:getetag></d:prop></d:propstat></d:response>
    <d:response><d:href>/dav/konode/konode_history_d.json</d:href><d:propstat><d:prop/></d:propstat></d:response>
    <d:response><d:href>/dav/konode/konode_history_me.json</d:href><d:propstat><d:prop><d:getetag>"own"</d:getetag></d:prop></d:propstat></d:response>
  </d:multistatus>`;

  it("parses the ETag under any prefix, and treats a weak one as none", () => {
    expect(parsePropfindEtags(xml).map((f) => [f.name, f.etag])).toEqual([
      ["", `"dir"`],
      ["konode_history_a.json", `"5f3c-1a4"`],
      ["konode_history_b.json", "&quot;66aa&quot;"],
      ["konode_history_c.json", null],
      ["konode_history_d.json", null],
      ["konode_history_me.json", `"own"`],
    ]);
    const apache = `<D:multistatus xmlns:D="DAV:"><D:response xmlns:lp1="DAV:"><D:href>/x/konode_history_z.json</D:href>
      <D:propstat><D:prop><lp1:getetag>"2a-5f3c"</lp1:getetag></D:prop></D:propstat></D:response></D:multistatus>`;
    expect(parsePropfindEtags(apache)).toEqual([{ name: "konode_history_z.json", href: "/x/konode_history_z.json", etag: `"2a-5f3c"` }]);
  });

  it("asks for getetag and skips a file whose ETag is the known one", async () => {
    let body = "";
    const fetched = serve((_url, init) => {
      if (init?.method !== "PROPFIND") return null;
      body = String(init.body);
      return { ok: true, status: 207, text: () => Promise.resolve(xml) } as Response;
    });

    const pull = await new WebDAVBackend(cfg).downloadChanged("history", "me", { a: `"5f3c-1a4"`, b: "&quot;old&quot;", c: `W/"77bb"` });

    expect(body).toContain("getetag");
    expect(pull.unchanged).toEqual([{ device_id: "a", marker: `"5f3c-1a4"`, exact: false }]);
    // b moved, c's weak ETag and d's missing one cannot stand for anything, own file excluded.
    expect(pull.fetched.map((f) => [f.file.device_id, f.file.marker, f.file.exact])).toEqual([
      ["b", "&quot;66aa&quot;", false],
      ["c", null, false],
      ["d", null, false],
    ]);
    expect(fetched.filter((u) => u.endsWith(".json")).map((u) => u.split("/").pop())).toEqual([
      "konode_history_b.json", "konode_history_c.json", "konode_history_d.json",
    ]);
  });

  it("downloadAll still downloads everything", async () => {
    serve((_url, init) => init?.method === "PROPFIND" ? { ok: true, status: 207, text: () => Promise.resolve(xml) } as Response : null);
    const packets = await new WebDAVBackend(cfg).downloadAll("history", "me");
    expect(packets.map((p) => p.device_id)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("GitHub: the blob sha in the contents listing", () => {
  const cfg: BackendConfig = { type: "github", label: "GitHub", enabled: true, github: { token: "t", repo: "owner/repo" } };

  it("skips a file whose sha is the known one, and calls the sha exact", async () => {
    const fetched = serve((url) => url.includes(".json") ? null : {
      ok: true, status: 200,
      json: () => Promise.resolve([
        { name: "konode_history_a.json", sha: "sha-a" },
        { name: "konode_history_b.json", sha: "sha-b2" },
        { name: "konode_history_me.json", sha: "sha-me" },
        { name: "konode_bookmarks_a.json", sha: "sha-bm" },
      ]),
    } as Response);

    const pull = await new GitHubBackend(cfg).downloadChanged("history", "me", { a: "sha-a", b: "sha-b1" });

    expect(pull.unchanged).toEqual([{ device_id: "a", marker: "sha-a", exact: true }]);
    expect(pull.fetched.map((f) => [f.packet.device_id, f.file.marker, f.file.exact])).toEqual([["b", "sha-b2", true]]);
    expect(fetched.filter((u) => u.includes(".json")).map((u) => u.split("/").pop()?.split("?")[0])).toEqual(["konode_history_b.json"]);
  });
});

describe("Drive: md5Checksum in the file list", () => {
  it("asks for md5Checksum, skips a file whose checksum is the known one, and calls it exact", async () => {
    await chrome.storage.local.set({
      [KEYS.GDRIVE_SESSION]: { access_token: "t", expires_at: Date.now() + 3_600_000, email: "", displayName: "", savedAt: Date.now() },
    });
    const cfg: BackendConfig = { type: "gdrive", label: "Google Drive", enabled: true, gdrive: { folderId: "pinned" } };
    let listUrl = "";
    const fetched = serve((url) => {
      if (url.includes("alt=media")) return null;
      listUrl = url;
      return {
        ok: true, status: 200,
        json: () => Promise.resolve({
          files: [
            { id: "a", name: "konode_history_a.json", md5Checksum: "m-a" },
            { id: "b", name: "konode_history_b.json", md5Checksum: "m-b2" },
            // A stale duplicate of a's file, listed after its current one: never read.
            { id: "a-old", name: "konode_history_a.json", md5Checksum: "m-a-old" },
            { id: "c", name: "konode_history_c.json" },
          ],
        }),
      } as Response;
    });

    const pull = await new GDriveBackend(cfg).downloadChanged("history", "me", { a: "m-a", b: "m-b1" });

    expect(decodeURIComponent(listUrl)).toContain("md5Checksum");
    expect(pull.unchanged).toEqual([{ device_id: "a", marker: "m-a", exact: true }]);
    expect(pull.fetched.map((f) => [f.file.device_id, f.file.marker])).toEqual([["b", "m-b2"], ["c", null]]);
    expect(fetched.filter((u) => u.includes("alt=media"))).toHaveLength(2);
  });
});

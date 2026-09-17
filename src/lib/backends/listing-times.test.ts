import { describe, it, expect, afterEach, vi } from "vitest";
import { GDriveBackend } from "./gdrive-backend";
import { WebDAVBackend, parsePropfindListing } from "./webdav-backend";
import { KEYS } from "@/lib/utils/storage";
import type { BackendConfig } from "@/lib/types";

// #30. The device list's "last upload" was the timestamp of whichever file it read for the
// device's name. Drive and WebDAV already send a modification time with every file in the
// listing the list makes anyway, so the real last upload costs no extra request.

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("WebDAV listing with modification times", () => {
  it("reads getlastmodified whatever namespace prefix the server uses", () => {
    const nextcloud = `<?xml version="1.0"?>
      <d:multistatus xmlns:d="DAV:">
        <d:response><d:href>/remote.php/dav/files/u/Konode/</d:href>
          <d:propstat><d:prop><d:getlastmodified>Wed, 16 Sep 2026 08:00:00 GMT</d:getlastmodified></d:prop></d:propstat></d:response>
        <d:response><d:href>/remote.php/dav/files/u/Konode/konode_bookmarks_abc.json</d:href>
          <d:propstat><d:prop><d:getlastmodified>Thu, 17 Sep 2026 10:15:00 GMT</d:getlastmodified></d:prop></d:propstat></d:response>
      </d:multistatus>`;
    const apache = `<?xml version="1.0"?>
      <D:multistatus xmlns:D="DAV:"><D:response xmlns:lp1="DAV:">
        <D:href>/dav/Konode/konode_history_x.json</D:href>
        <D:propstat><D:prop><lp1:getlastmodified>Tue, 15 Sep 2026 07:00:00 GMT</lp1:getlastmodified></D:prop></D:propstat>
      </D:response></D:multistatus>`;
    const unprefixed = `<multistatus xmlns="DAV:"><response><href>/Konode/konode_sessions_y.json</href>
      <propstat><prop><getlastmodified>Mon, 14 Sep 2026 06:00:00 GMT</getlastmodified></prop></propstat></response></multistatus>`;

    expect(parsePropfindListing(nextcloud)).toEqual([
      { name: "", modified: Date.parse("2026-09-16T08:00:00Z") },
      { name: "konode_bookmarks_abc.json", modified: Date.parse("2026-09-17T10:15:00Z") },
    ]);
    expect(parsePropfindListing(apache)).toEqual([
      { name: "konode_history_x.json", modified: Date.parse("2026-09-15T07:00:00Z") },
    ]);
    expect(parsePropfindListing(unprefixed)).toEqual([
      { name: "konode_sessions_y.json", modified: Date.parse("2026-09-14T06:00:00Z") },
    ]);
  });

  it("names a file whose response carries no time, rather than dropping it", () => {
    const xml = `<d:multistatus xmlns:d="DAV:"><d:response><d:href>/Konode/konode_extensions_z.json</d:href>
      <d:propstat><d:prop/><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response></d:multistatus>`;

    expect(parsePropfindListing(xml)).toEqual([{ name: "konode_extensions_z.json", modified: null }]);
  });

  it("lists only the files under the prefix, decoded, without the folder itself", async () => {
    const xml = `<d:multistatus xmlns:d="DAV:">
      <d:response><d:href>/dav/Konode/</d:href></d:response>
      <d:response><d:href>/dav/Konode/konode_bookmarks_%C3%A9.json</d:href>
        <d:propstat><d:prop><d:getlastmodified>Thu, 17 Sep 2026 10:15:00 GMT</d:getlastmodified></d:prop></d:propstat></d:response>
      <d:response><d:href>/dav/Konode/notes.txt</d:href></d:response>
    </d:multistatus>`;
    vi.stubGlobal("fetch", () => Promise.resolve({ ok: true, status: 207, text: () => Promise.resolve(xml) } as Response));
    const cfg: BackendConfig = {
      type: "webdav", label: "WebDAV", enabled: true,
      webdav: { url: "https://dav.example.com/dav/", username: "u", password: "p" },
    };

    expect(await new WebDAVBackend(cfg).listFilesWithTimes("konode_")).toEqual([
      { name: "konode_bookmarks_é.json", modified: Date.parse("2026-09-17T10:15:00Z") },
    ]);
  });
});

describe("Drive listing with modification times", () => {
  it("asks for modifiedTime and returns it per file", async () => {
    await chrome.storage.local.set({
      [KEYS.GDRIVE_SESSION]: {
        access_token: "test-token", expires_at: Date.now() + 3_600_000,
        email: "a@b.c", displayName: "Tester", savedAt: Date.now(),
      },
    });
    const be = new GDriveBackend({ type: "gdrive", label: "Google Drive", enabled: true, gdrive: { folderId: "pinned" } });
    await be.connect();
    const urls: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      urls.push(url);
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({
          files: [
            { name: "konode_bookmarks_abc.json", modifiedTime: "2026-09-17T10:15:00.000Z" },
            { name: "konode_extensions_abc.json" },
            { name: "Konode notes" },
          ],
        }),
      } as Response);
    });

    const files = await be.listFilesWithTimes("konode_");

    expect(urls[0]).toContain("modifiedTime");
    expect(files).toEqual([
      { name: "konode_bookmarks_abc.json", modified: Date.parse("2026-09-17T10:15:00Z") },
      { name: "konode_extensions_abc.json", modified: null },
    ]);
  });
});

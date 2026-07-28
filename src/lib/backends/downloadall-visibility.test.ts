import { describe, it, expect, afterEach, vi } from "vitest";
import { WebDAVBackend } from "./webdav-backend";
import { GitHubBackend } from "./github-backend";
import { GDriveBackend } from "./gdrive-backend";
import { KEYS } from "@/lib/utils/storage";
import type { BackendConfig } from "@/lib/types";

// A peer whose file can't be downloaded used to drop out of the sync in COMPLETE silence:
// `if (!r.ok) continue;` with no log line. Its bookmarks weren't merged, its extensions
// weren't listed, and the sync still reported success — with fewer devices than the folder
// actually held. A field report showed exactly that shape: three konode_extensions_* files
// on the server, one peer folded in, and nothing anywhere explaining the other.

const PEER = "konode_extensions_bdacfda8-0d75-4a11-9c2e-1f3b5d7e9a01.json";

async function auditText(): Promise<string> {
  await new Promise((r) => setTimeout(r, 0)); // logger fires appendAudit unawaited
  const r = await chrome.storage.local.get(KEYS.AUDIT_LOG);
  return JSON.stringify(r[KEYS.AUDIT_LOG] ?? []);
}

/** Listing succeeds and names one peer file; downloading that file fails with `status`. */
function listOkDownloadFails(status: number, body: string): void {
  vi.stubGlobal("fetch", (url: string, init?: { method?: string }) => {
    const isListing = init?.method === "PROPFIND" || !String(url).includes(".json");
    if (isListing) {
      return Promise.resolve({
        ok: true, status: 207,
        text: () => Promise.resolve(body),
        json: () => Promise.resolve(JSON.parse(body)),
      } as Response);
    }
    return Promise.resolve({ ok: false, status, text: () => Promise.resolve("") } as Response);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("downloadAll — a peer we can't fetch must not vanish quietly", () => {
  it("WebDAV: says which file failed, with the status and the consequence", async () => {
    const cfg: BackendConfig = {
      type: "webdav", label: "WebDAV", enabled: true,
      webdav: { url: "https://dav.example.com/dav/", username: "u", password: "p" },
    };
    listOkDownloadFails(
      403,
      `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
         <d:response><d:href>/dav/konode/${PEER}</d:href></d:response>
       </d:multistatus>`
    );

    const packets = await new WebDAVBackend(cfg).downloadAll("extensions", "me");

    expect(packets).toEqual([]); // degraded, not fatal — the sync goes on
    const log = await auditText();
    expect(log).toContain(PEER);
    expect(log).toContain("403");
    expect(log).toContain("left out of this sync"); // the CONSEQUENCE, not just a status
  });

  it("GitHub: same", async () => {
    const cfg: BackendConfig = {
      type: "github", label: "GitHub", enabled: true,
      github: { token: "t", repo: "owner/repo" },
    };
    listOkDownloadFails(500, JSON.stringify([{ name: PEER }]));

    const packets = await new GitHubBackend(cfg).downloadAll("extensions", "me");

    expect(packets).toEqual([]);
    const log = await auditText();
    expect(log).toContain(PEER);
    expect(log).toContain("500");
  });

  it("Drive: same", async () => {
    await chrome.storage.local.set({
      [KEYS.GDRIVE_SESSION]: {
        access_token: "t", expires_at: Date.now() + 3_600_000,
        email: "", displayName: "", savedAt: Date.now(),
      },
    });
    const cfg: BackendConfig = {
      type: "gdrive", label: "Google Drive", enabled: true, gdrive: { folderId: "pinned" },
    };
    // Drive lists via a files?q= URL (no ".json"), then fetches files/<id>?alt=media.
    vi.stubGlobal("fetch", (url: string) => {
      if (String(url).includes("alt=media")) {
        return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve("") } as Response);
      }
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({ files: [{ id: "fid", name: PEER }] }),
      } as Response);
    });

    const packets = await new GDriveBackend(cfg).downloadAll("extensions", "me");

    expect(packets).toEqual([]);
    const log = await auditText();
    expect(log).toContain(PEER);
    expect(log).toContain("404");
  });

  it("WebDAV: an unreadable file still doesn't stop the readable peers", async () => {
    // One peer 403s, another parses fine. The good one must still come through — a single
    // bad file must never take the whole sync down.
    const good = "konode_extensions_787e6589-f96b-4c22-8d31-2a5c7e9f0b13.json";
    const packet = {
      version: "1.0", device_id: "787e6589", timestamp: "2026-07-28T10:00:00.000Z",
      data_type: "extensions", checksum: "a".repeat(64), encrypted: false, payload: "[]",
    };
    vi.stubGlobal("fetch", (url: string, init?: { method?: string }) => {
      if (init?.method === "PROPFIND") {
        return Promise.resolve({
          ok: true, status: 207,
          text: () => Promise.resolve(
            `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
               <d:response><d:href>/dav/konode/${PEER}</d:href></d:response>
               <d:response><d:href>/dav/konode/${good}</d:href></d:response>
             </d:multistatus>`
          ),
        } as Response);
      }
      if (String(url).includes(good)) {
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(packet)) } as Response);
      }
      return Promise.resolve({ ok: false, status: 403, text: () => Promise.resolve("") } as Response);
    });

    const cfg: BackendConfig = {
      type: "webdav", label: "WebDAV", enabled: true,
      webdav: { url: "https://dav.example.com/dav/", username: "u", password: "p" },
    };
    const packets = await new WebDAVBackend(cfg).downloadAll("extensions", "me");

    expect(packets.map((p) => p.device_id)).toEqual(["787e6589"]);
    expect(await auditText()).toContain(PEER); // and the one we lost is named
  });
});

import { describe, it, expect, afterEach, vi } from "vitest";
import { WebDAVBackend } from "./webdav-backend";
import { KEYS } from "@/lib/utils/storage";
import type { BackendConfig, SyncPacket } from "@/lib/types";

// The audit log is device-local but PERSISTED, so it must not accumulate more backend
// detail than troubleshooting needs. A Nextcloud/ownCloud files-DAV URL embeds the
// account username (…/remote.php/dav/files/<user>/…), and the upload used to log the
// whole URL — while connect() deliberately logged the hostname only (PR-L2).

const USERNAME = "ben.stone";
const HOST = "cloud.example.com";
const DAV_URL = `https://${HOST}/remote.php/dav/files/${USERNAME}/`;

const config = (): BackendConfig => ({
  type: "webdav",
  label: "WebDAV",
  enabled: true,
  webdav: { url: DAV_URL, username: USERNAME, password: "app-password" },
});

const packet = (): SyncPacket => ({
  version: "1.0",
  device_id: "11111111-2222-3333-4444-555555555555",
  timestamp: "2026-07-28T10:00:00.000Z",
  data_type: "bookmarks",
  checksum: "a".repeat(64),
  encrypted: false,
  payload: "[]",
});

async function auditText(): Promise<string> {
  // logger.* fires appendAudit without awaiting, so let the serialized write land.
  await new Promise((r) => setTimeout(r, 0));
  const r = await chrome.storage.local.get(KEYS.AUDIT_LOG);
  return JSON.stringify(r[KEYS.AUDIT_LOG] ?? []);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WebDAV logging keeps the account out of the audit log", () => {
  it("logs the file name on upload, not the DAV URL", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve({ ok: true, status: 201 } as Response));

    await new WebDAVBackend(config()).upload(packet());

    const log = await auditText();
    expect(log).toContain("konode_bookmarks_11111111-2222-3333-4444-555555555555.json");
    expect(log).not.toContain(USERNAME);
    expect(log).not.toContain("remote.php");
    expect(log).not.toContain(DAV_URL);
  });

  it("logs only the host on connect", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve({ ok: true, status: 201 } as Response));

    await new WebDAVBackend(config()).connect();

    const log = await auditText();
    expect(log).toContain(HOST);
    expect(log).not.toContain(USERNAME);
    expect(log).not.toContain("remote.php");
  });

  it("logs the file name, not the DAV path, when skipping a corrupt peer file", async () => {
    const peerFile = "konode_bookmarks_99999999-8888-7777-6666-555555555555.json";
    const propfind = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
      <d:response><d:href>/remote.php/dav/files/${USERNAME}/konode/${peerFile}</d:href></d:response>
    </d:multistatus>`;

    vi.stubGlobal("fetch", (_url: string, init?: { method?: string }) => {
      if (init?.method === "PROPFIND") {
        return Promise.resolve({ ok: true, status: 207, text: () => Promise.resolve(propfind) } as Response);
      }
      // The peer file itself is corrupt → the JSON.parse in downloadAll throws.
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("}{ not json") } as Response);
    });

    const packets = await new WebDAVBackend(config()).downloadAll("bookmarks", "me");
    expect(packets).toEqual([]); // skipped, not fatal

    const log = await auditText();
    expect(log).toContain(peerFile);
    expect(log).not.toContain(USERNAME);
    expect(log).not.toContain("remote.php");
  });
});

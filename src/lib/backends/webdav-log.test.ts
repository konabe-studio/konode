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

/** Everything the routine (console-only) log lines emitted, as one string. Those lines
 *  no longer reach the audit log, but they must still not carry the account name. */
function consoleSpy(): { text: () => string; restore: () => void } {
  const seen: string[] = [];
  const spy = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
    seen.push(args.map(String).join(" "));
  });
  return { text: () => seen.join("\n"), restore: () => spy.mockRestore() };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("WebDAV logging keeps the account name out of every sink", () => {
  it("names the file, never the DAV URL, on upload", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve({ ok: true, status: 201 } as Response));
    const con = consoleSpy();

    await new WebDAVBackend(config()).upload(packet());
    const line = con.text();
    con.restore();

    expect(line).toContain("konode_bookmarks_11111111-2222-3333-4444-555555555555.json");
    expect(line).not.toContain(USERNAME);
    expect(line).not.toContain("remote.php");
    expect(line).not.toContain(DAV_URL);
    // Routine per-sync detail is console-only, so it can't evict the warnings the
    // recovery banner points at — and nothing is persisted here at all.
    expect(await auditText()).not.toContain("konode_bookmarks_");
  });

  it("names only the host on connect", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve({ ok: true, status: 201 } as Response));
    const con = consoleSpy();

    await new WebDAVBackend(config()).connect();
    const line = con.text();
    con.restore();

    expect(line).toContain(HOST);
    expect(line).not.toContain(USERNAME);
    expect(line).not.toContain("remote.php");
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

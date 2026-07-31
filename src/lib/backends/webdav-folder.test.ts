import { describe, it, expect, afterEach, vi } from "vitest";
import { WebDAVBackend } from "./webdav-backend";
import { KEYS } from "@/lib/utils/storage";
import type { BackendConfig } from "@/lib/types";

// ensureFolder only ever WARNED. So connect() went on to log "WebDAV connected" and Test
// connection reported success even when the sync folder had not been created — and every
// upload afterwards failed against a folder that wasn't there. It also waved a bare 301
// through as if it meant success.

const cfg: BackendConfig = {
  type: "webdav", label: "WebDAV", enabled: true,
  webdav: { url: "https://dav.example.com/dav/", username: "u", password: "p" },
};

async function auditText(): Promise<string> {
  await new Promise((r) => setTimeout(r, 0)); // logger fires appendAudit unawaited
  const r = await chrome.storage.local.get(KEYS.AUDIT_LOG);
  return JSON.stringify(r[KEYS.AUDIT_LOG] ?? []);
}

/** MKCOL answers `mkcol`; the follow-up PROPFIND answers `propfind`. */
function server(mkcol: number, propfind = 404, redirected = false): void {
  vi.stubGlobal("fetch", (_url: string, init?: { method?: string }) => {
    const status = init?.method === "PROPFIND" ? propfind : mkcol;
    return Promise.resolve({
      ok: status >= 200 && status < 300, status, redirected,
      text: () => Promise.resolve(""),
    } as Response);
  });
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("WebDAV: ensuring the sync folder exists", () => {
  it("connects when MKCOL creates it", async () => {
    server(201);
    await expect(new WebDAVBackend(cfg).connect()).resolves.toBeUndefined();
  });

  it("connects when the folder is already there (405)", async () => {
    server(405);
    await expect(new WebDAVBackend(cfg).connect()).resolves.toBeUndefined();
  });

  it("does NOT report a successful connection when the folder couldn't be created", async () => {
    server(403, 404); // may not create it, and it isn't there
    await expect(new WebDAVBackend(cfg).connect()).rejects.toThrow(/sync folder/);
  });

  it("accepts a refused MKCOL when the folder does in fact exist", async () => {
    // A 403 can mean "you may not create collections here" on a path that already exists,
    // so the status alone can't decide it — ask the server instead of guessing.
    server(403, 207);
    await expect(new WebDAVBackend(cfg).connect()).resolves.toBeUndefined();
  });

  it("treats a bare 301 as a failure, not as success", async () => {
    // fetch follows redirects by default, so a 301 only reaches us when it could NOT be
    // followed — which is a failure. It used to be listed alongside 405 as "fine".
    server(301, 404);
    await expect(new WebDAVBackend(cfg).connect()).rejects.toThrow(/301/);
  });

  it("warns when the configured URL redirects, and still connects", async () => {
    // Plenty of servers and proxies drop the Authorization header across a redirect, which
    // surfaces later as a 401 on a password that is perfectly correct.
    server(201, 207, true);

    await expect(new WebDAVBackend(cfg).connect()).resolves.toBeUndefined();

    const log = await auditText();
    expect(log).toContain("redirects");
    expect(log).toContain("dav.example.com");
    expect(log).not.toContain("://u:"); // never the credentials
  });
});

import { describe, it, expect, vi, afterEach } from "vitest";
import { logger, setLoggerDebug } from "@/lib/utils/logger";
import { KEYS } from "@/lib/utils/storage";

// The audit log is what the popup's recovery banner sends the user to read ("Review in
// Settings → Activity"). While `logger.info` was audited too, an idle sync of four data
// types wrote ~11 entries a minute, so the 200-entry ring turned over in about 17
// minutes and the "unusual deletion blocked" warning was usually gone before the user
// looked. Routine detail is console-only now; the audited set is small on purpose.

async function auditLog(): Promise<Array<{ action: string; ok: boolean }>> {
  await new Promise((r) => setTimeout(r, 0)); // logger fires appendAudit unawaited
  const r = await chrome.storage.local.get(KEYS.AUDIT_LOG);
  return (r[KEYS.AUDIT_LOG] as Array<{ action: string; ok: boolean }>) ?? [];
}

afterEach(() => {
  vi.restoreAllMocks();
  setLoggerDebug(false);
});

describe("logger — which levels reach the audit log", () => {
  it("does NOT persist routine info", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});

    logger.info("SyncEngine", "Syncing: bookmarks");
    logger.info("SyncEngine", "bookmarks: unchanged since last upload, skipping");
    logger.info("ServiceWorker", "Initialized");

    expect(await auditLog()).toEqual([]);
  });

  it("persists a notable event", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});

    logger.event("Snapshots", "Created konode_snap_bookmarks_1.json (12 bookmarks)");

    const log = await auditLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ action: "Snapshots", ok: true });
  });

  it("ALWAYS persists warnings and errors — that's what the banner points at", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    logger.warn("mergeBookmarks", "Skipped deleting 900 bookmarks: exceeds the mass-delete guard");
    logger.error("SyncEngine.sync", new Error("network down"));

    const log = await auditLog();
    expect(log.map((e) => e.action)).toEqual(["SyncEngine.sync", "mergeBookmarks"]); // newest first
    expect(log.every((e) => e.ok === false)).toBe(true);
  });

  it("a burst of routine info can no longer evict a warning", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    logger.warn("mergeBookmarks", "Skipped deleting 900 bookmarks");
    // Well past the 200-entry cap — roughly a day of idle syncing under the old rules.
    for (let i = 0; i < 500; i++) logger.info("SyncEngine", `Syncing: cycle ${i}`);

    const log = await auditLog();
    expect(log).toHaveLength(1);
    expect(log[0].action).toBe("mergeBookmarks");
  });

  it("still writes routine info to the console", async () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});

    logger.info("SyncEngine", "Syncing: bookmarks");

    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0].join(" ")).toContain("Syncing: bookmarks");
  });

  it("keeps debug gated behind Debug mode", async () => {
    const spy = vi.spyOn(console, "debug").mockImplementation(() => {});

    logger.debug("SyncEngine", "verbose");
    expect(spy).not.toHaveBeenCalled();

    setLoggerDebug(true);
    logger.debug("SyncEngine", "verbose");
    expect(spy).toHaveBeenCalled();

    expect(await auditLog()).toEqual([]); // never persisted either way
  });
});

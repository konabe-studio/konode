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

  it("puts debug lines into the Activity log WHILE Debug mode is on", async () => {
    // Support asks users to enable Debug mode and send Settings → Activity. That produced
    // nothing: debug only reached the service-worker console, which nobody is going to
    // open — hiding exactly the lines that explain a missing device.
    vi.spyOn(console, "debug").mockImplementation(() => {});

    logger.debug("SyncEngine", "Skipping plaintext peer abc123 (E2EE on here)");
    expect(await auditLog()).toEqual([]); // off by default

    setLoggerDebug(true);
    logger.debug("SyncEngine", "Skipping plaintext peer abc123 (E2EE on here)");

    const log = await auditLog();
    expect(log).toHaveLength(1);
    expect(JSON.stringify(log)).toContain("Skipping plaintext peer");
  });

  it("stops persisting the moment Debug mode goes off", async () => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    setLoggerDebug(true);
    logger.debug("SyncEngine", "one");
    setLoggerDebug(false);
    logger.debug("SyncEngine", "two");

    expect(await auditLog()).toHaveLength(1);
  });

  it("serialises non-string debug data instead of storing [object Object]", async () => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    setLoggerDebug(true);

    logger.debug("SyncEngine", { peers: 2, type: "bookmarks" });

    expect(JSON.stringify(await auditLog())).toContain("peers");
  });

  it("keeps debug gated behind Debug mode", async () => {
    const spy = vi.spyOn(console, "debug").mockImplementation(() => {});

    logger.debug("SyncEngine", "verbose");
    expect(spy).not.toHaveBeenCalled();

    setLoggerDebug(true);
    logger.debug("SyncEngine", "verbose");
    expect(spy).toHaveBeenCalled();
  });
});

describe("what an audit entry MEANS, not just whether it went well", () => {
  // `ok` is two states; warn and error both wrote `ok: false`, so a deliberate skip and a
  // real failure were identical in STORAGE, not merely rendered alike. Since almost every
  // "we're not syncing this" path is a warn, a routine import painted the log red — a
  // field report had 176 of 188 entries flagged as errors, nearly all of them harmless.
  const entries = async (): Promise<Array<{ action: string; ok: boolean; level?: string }>> => {
    await new Promise((r) => setTimeout(r, 0));
    const r = await chrome.storage.local.get(KEYS.AUDIT_LOG);
    return (r[KEYS.AUDIT_LOG] as Array<{ action: string; ok: boolean; level?: string }>) ?? [];
  };

  it("tells a deliberate skip apart from a failure", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});

    logger.warn("importHistory", "Skipping an unsafe URL");
    logger.error("SyncEngine.sync", new Error("network down"));
    logger.event("Snapshots", "Created a restore point");

    const byAction = Object.fromEntries((await entries()).map((e) => [e.action, e]));
    expect(byAction["importHistory"].level).toBe("notice");
    expect(byAction["SyncEngine.sync"].level).toBe("error");
    expect(byAction["Snapshots"].level).toBe("ok");
  });

  it("keeps writing `ok`, so nothing that already reads it breaks", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    logger.warn("importHistory", "Skipping an unsafe URL");

    const [e] = await entries();
    expect(e.ok).toBe(false); // a notice is still not a success
  });
});

describe("a warning that lasts is one entry, not one per sync", () => {
  // Most warnings are a STATE re-checked every sync: a permission taken away, a peer whose
  // passphrase differs, a file that will not download. Each wrote a line per cycle for as
  // long as it lasted, and a passphrase mismatch one per peer per data type, so three peers
  // filled all 200 entries in about 17 minutes and evicted whatever explained them.
  type Entry = { action: string; detail?: string; level?: string; timestamp: string; count?: number; last?: string };
  const entries = async (): Promise<Entry[]> => {
    await new Promise((r) => setTimeout(r, 0));
    const r = await chrome.storage.local.get(KEYS.AUDIT_LOG);
    return (r[KEYS.AUDIT_LOG] as Entry[]) ?? [];
  };
  const T0 = Date.parse("2026-09-29T10:00:00.000Z");
  const minutes = (n: number): number => T0 + n * 60_000;
  const REVOKED = "No extension-management API here, so the extension list isn't published this sync";

  afterEach(() => {
    vi.useRealTimers();
  });
  function quiet(): void {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ["Date"] });
  }

  it("counts a warning repeated every sync on its first entry", async () => {
    quiet();
    for (let i = 0; i < 12; i++) {
      vi.setSystemTime(minutes(i));
      logger.warn("exportExtensions", REVOKED);
    }

    const log = await entries();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      count: 12, timestamp: new Date(minutes(0)).toISOString(), last: new Date(minutes(11)).toISOString(),
    });
  });

  it("keeps one entry per peer, which is what the reader needs to tell them apart", async () => {
    quiet();
    // Three peers on another passphrase, four data types, five syncs: 60 lines before.
    for (let cycle = 0; cycle < 5; cycle++) {
      vi.setSystemTime(minutes(cycle));
      for (let type = 0; type < 4; type++) {
        for (const peer of ["p1", "p2", "p3"]) {
          logger.warn("SyncEngine", `Encryption mismatch, skipping peer ${peer}: wrong passphrase`);
        }
      }
    }

    const log = await entries();
    expect(log.map((e) => e.detail).sort()).toEqual([
      "Encryption mismatch, skipping peer p1: wrong passphrase",
      "Encryption mismatch, skipping peer p2: wrong passphrase",
      "Encryption mismatch, skipping peer p3: wrong passphrase",
    ]);
    expect(log.every((e) => e.count === 20)).toBe(true);
  });

  it("can no longer evict the event that explains the warning", async () => {
    quiet();
    vi.setSystemTime(minutes(0));
    logger.event("Settings", "Encryption turned on");
    // A day of syncs at the default minute. Before, the event was gone after 200 of them.
    for (let i = 1; i <= 1440; i++) {
      vi.setSystemTime(minutes(i));
      logger.warn("SyncEngine", "Encryption mismatch, skipping peer p1: wrong passphrase");
    }

    const log = await entries();
    expect(log.map((e) => e.action)).toEqual(["SyncEngine", "Settings"]);
    expect(log[0].count).toBe(1440);
  });

  it("stays where the warning began, below the other warnings of the same syncs", async () => {
    quiet();
    for (let i = 0; i < 3; i++) {
      vi.setSystemTime(minutes(i));
      logger.warn("exportExtensions", REVOKED);
      logger.warn("GDrive", "2 copies of konode_history_x.json in the Konode folder; updating the oldest.");
    }

    const log = await entries();
    expect(log.map((e) => [e.action, e.count])).toEqual([["GDrive", 3], ["exportExtensions", 3]]);
  });

  it("starts a new entry once something has happened in between", async () => {
    // The listing failed, worked again (an event says so), and failed again: a new incident,
    // which folded into the first would read as having come before the recovery.
    quiet();
    vi.setSystemTime(minutes(0));
    logger.warn("findOwnMissingFiles", "Couldn't list the sync folder");
    vi.setSystemTime(minutes(1));
    logger.event("findOwnMissingFiles", "The sync folder can be listed again");
    vi.setSystemTime(minutes(2));
    logger.warn("findOwnMissingFiles", "Couldn't list the sync folder");

    const log = await entries();
    expect(log.map((e) => e.level)).toEqual(["notice", "ok", "notice"]);
    expect(log.some((e) => e.count !== undefined)).toBe(false);
  });

  it("starts a new entry when the warning comes back after an hour without it", async () => {
    quiet();
    vi.setSystemTime(minutes(0));
    logger.warn("exportExtensions", REVOKED);
    vi.setSystemTime(minutes(61));
    logger.warn("exportExtensions", REVOKED);

    const log = await entries();
    expect(log).toHaveLength(2);
    expect(log.every((e) => e.count === undefined)).toBe(true);
  });

  it("folds errors the same way, and never into a warning with the same words", async () => {
    quiet();
    for (let i = 0; i < 3; i++) {
      vi.setSystemTime(minutes(i));
      logger.error("SyncEngine.sync", new Error("Can't reach the server"));
      logger.warn("SyncEngine.sync", "Can't reach the server");
    }

    const log = await entries();
    expect(log.map((e) => [e.level, e.count])).toEqual([["notice", 3], ["error", 3]]);
  });

  it("leaves events and Debug-mode lines as a timeline", async () => {
    quiet();
    vi.spyOn(console, "debug").mockImplementation(() => {});
    setLoggerDebug(true);
    for (let i = 0; i < 3; i++) {
      vi.setSystemTime(minutes(i));
      logger.event("Tombstones", "Recorded 1 deletion(s)");
      logger.debug("SyncEngine", "Syncing: bookmarks");
    }

    const log = await entries();
    expect(log).toHaveLength(6);
    expect(log.some((e) => e.count !== undefined)).toBe(false);
  });
});

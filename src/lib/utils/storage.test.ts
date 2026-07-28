import { describe, it, expect } from "vitest";
import {
  normalizeRemoteSessions, normalizeRemoteExtensions,
  acquireSyncLock, releaseSyncLock, clearStaleSyncLock,
  getImportedHistoryUrls, addImportedHistoryUrls,
  updateKey, appendAudit, KEYS,
} from "@/lib/utils/storage";
import { browser } from "@/lib/utils/ext";
import type { RemoteSessionEntry, RemoteExtensionEntry, SyncExtension } from "@/lib/types";

function entry(device: string, ts: string, tabCount = 1): RemoteSessionEntry {
  return {
    device_id: device,
    timestamp: ts,
    session: {
      id: `session_${device}`,
      device_id: device,
      savedAt: "",
      label: device,
      tabs: Array.from({ length: tabCount }, (_, i) => ({
        url: `https://example.com/${i}`,
        pinned: false,
      })),
    },
  };
}

describe("normalizeRemoteSessions", () => {
  it("returns [] for empty/undefined/non-object input", () => {
    expect(normalizeRemoteSessions(undefined)).toEqual([]);
    expect(normalizeRemoteSessions(null)).toEqual([]);
    expect(normalizeRemoteSessions("nope")).toEqual([]);
    expect(normalizeRemoteSessions({})).toEqual([]);
  });

  it("accepts the legacy single-object shape", () => {
    const legacy = entry("dev-a", "2026-06-20T10:00:00.000Z");
    const out = normalizeRemoteSessions(legacy);
    expect(out).toHaveLength(1);
    expect(out[0].device_id).toBe("dev-a");
  });

  it("drops a legacy entry with no tabs", () => {
    const legacy = entry("dev-a", "2026-06-20T10:00:00.000Z", 0);
    expect(normalizeRemoteSessions(legacy)).toEqual([]);
  });

  it("flattens the device-keyed map, newest first, dropping empty sessions", () => {
    const map = {
      "dev-a": entry("dev-a", "2026-06-20T10:00:00.000Z"),
      "dev-b": entry("dev-b", "2026-06-22T10:00:00.000Z"),
      "dev-c": entry("dev-c", "2026-06-21T10:00:00.000Z", 0), // no tabs → dropped
    };
    const out = normalizeRemoteSessions(map);
    expect(out.map((e) => e.device_id)).toEqual(["dev-b", "dev-a"]);
  });
});

function ext(id: string, type: SyncExtension["type"] = "extension"): SyncExtension {
  return { id, name: id, version: "1.0.0", enabled: true, storeUrl: `https://x/${id}`, type };
}

function extEntry(device: string, ids: string[]): RemoteExtensionEntry {
  return { device_id: device, timestamp: "2026-06-22T10:00:00.000Z", extensions: ids.map((i) => ext(i)) };
}

describe("normalizeRemoteExtensions", () => {
  it("returns [] for empty/undefined/non-object input", () => {
    expect(normalizeRemoteExtensions(undefined)).toEqual([]);
    expect(normalizeRemoteExtensions(null)).toEqual([]);
    expect(normalizeRemoteExtensions({})).toEqual([]);
  });

  it("accepts the legacy single-object shape", () => {
    const out = normalizeRemoteExtensions(extEntry("dev-a", ["e1", "e2"]));
    expect(out.map((e) => e.id).sort()).toEqual(["e1", "e2"]);
  });

  it("unions the device-keyed map and dedupes by id across peers", () => {
    const map = {
      "dev-a": extEntry("dev-a", ["e1", "e2"]),
      "dev-b": extEntry("dev-b", ["e2", "e3"]), // e2 overlaps → counted once
    };
    const out = normalizeRemoteExtensions(map);
    expect(out.map((e) => e.id).sort()).toEqual(["e1", "e2", "e3"]);
  });
});

describe("sync lock (CO-4)", () => {
  it("acquires when free, blocks a fresh lock, frees on release", async () => {
    expect(await acquireSyncLock(60_000)).toBe(true);
    expect(await acquireSyncLock(60_000)).toBe(false); // held & fresh → blocked
    await releaseSyncLock();
    expect(await acquireSyncLock(60_000)).toBe(true); // freed → acquirable
  });

  it("treats a lock older than the TTL as stale (self-heals)", async () => {
    await acquireSyncLock(60_000); // lockedAt = now
    expect(await acquireSyncLock(0)).toBe(true); // ttl 0 → any existing lock is stale
  });
});

describe("updateKey — serialized read-modify-write", () => {
  const read = async <T>(key: string, fallback: T): Promise<T> =>
    ((await browser.storage.local.get(key)) as Record<string, T>)[key] ?? fallback;

  it("(control) a naive get→set pair DOES lose concurrent writes here", async () => {
    // Proves this environment actually reproduces the race, so the serialized test
    // below is meaningful rather than vacuously green.
    const naive = async (n: number): Promise<void> => {
      const cur = await read<number[]>("race_naive", []);
      await browser.storage.local.set({ race_naive: [...cur, n] });
    };
    await Promise.all([1, 2, 3, 4, 5].map(naive));
    expect((await read<number[]>("race_naive", [])).length).toBeLessThan(5);
  });

  it("keeps every concurrent append on the same key", async () => {
    await Promise.all(
      [1, 2, 3, 4, 5].map((n) => updateKey<number[]>("race_safe", (cur) => [...cur, n], []))
    );
    expect((await read<number[]>("race_safe", [])).sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns the value it wrote, and keeps different keys independent", async () => {
    const [a, b] = await Promise.all([
      updateKey<number[]>("race_a", (cur) => [...cur, 1], []),
      updateKey<number[]>("race_b", (cur) => [...cur, 9], []),
    ]);
    expect(a).toEqual([1]);
    expect(b).toEqual([9]);
  });

  it("a failing update rejects but does not wedge the key", async () => {
    await updateKey<number[]>("race_fail", (cur) => [...cur, 1], []);
    await expect(
      updateKey<number[]>("race_fail", () => { throw new Error("boom"); }, [])
    ).rejects.toThrow("boom");
    // The chain must continue past the failure, and the failed update must not have
    // written anything.
    await expect(updateKey<number[]>("race_fail", (cur) => [...cur, 2], [])).resolves.toEqual([1, 2]);
  });

  it("appendAudit keeps every entry from a burst and caps at 200", async () => {
    // The logger fires appendAudit without awaiting, so a sync emits overlapping
    // appends; a get/set pair dropped all but the last.
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        appendAudit({ timestamp: `t${i}`, action: `a${i}`, ok: true })
      )
    );
    const log = await read<Array<{ action: string }>>(KEYS.AUDIT_LOG, []);
    expect(log).toHaveLength(12);
    expect(new Set(log.map((e) => e.action)).size).toBe(12);

    await Promise.all(
      Array.from({ length: 250 }, (_, i) =>
        appendAudit({ timestamp: `x${i}`, action: `x${i}`, ok: true })
      )
    );
    expect(await read<unknown[]>(KEYS.AUDIT_LOG, [])).toHaveLength(200);
  });
});

describe("imported-history set (CO-6)", () => {
  it("merges, de-dups, and reports imported URLs", async () => {
    await addImportedHistoryUrls(["https://a.com", "https://b.com"]);
    await addImportedHistoryUrls(["https://b.com", "https://c.com"]); // b.com is a dup
    expect((await getImportedHistoryUrls()).sort()).toEqual([
      "https://a.com", "https://b.com", "https://c.com",
    ]);
  });

  it("no-ops on an empty list", async () => {
    await addImportedHistoryUrls([]);
    expect(await getImportedHistoryUrls()).toEqual([]);
  });
});

describe("clearStaleSyncLock — recovery from a worker that died mid-sync", () => {
  // sync()'s finally releases the lock, but a worker torn down mid-sync never runs it.
  // The lock then sat for its full 2-minute TTL and every sync returned early — the
  // manual "Sync now" included, which still answered OK. init() reset the stuck
  // "syncing" status but not this, the other half of the same stranded state.

  it("drops a held lock and says so", async () => {
    expect(await acquireSyncLock(60_000)).toBe(true);
    expect(await clearStaleSyncLock()).toBe(true);
    // The next sync can start immediately instead of waiting out the TTL.
    expect(await acquireSyncLock(60_000)).toBe(true);
  });

  it("reports false when no lock was held, so startup stays quiet", async () => {
    expect(await clearStaleSyncLock()).toBe(false);
    await acquireSyncLock(60_000);
    await releaseSyncLock();
    expect(await clearStaleSyncLock()).toBe(false); // released, not held
  });

  it("ignores the TTL — a fresh worker means the lock is stale by definition", async () => {
    // MV3 runs one worker at a time and tears the whole JS context down, so nothing can
    // still be holding it however recently it was taken.
    await acquireSyncLock(60 * 60_000); // an hour-long TTL, taken just now
    expect(await clearStaleSyncLock()).toBe(true);
    expect(await acquireSyncLock(60 * 60_000)).toBe(true);
  });
});

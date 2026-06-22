import { describe, it, expect } from "vitest";
import { normalizeRemoteSessions, normalizeRemoteExtensions } from "@/lib/utils/storage";
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

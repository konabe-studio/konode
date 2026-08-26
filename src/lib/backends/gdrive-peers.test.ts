import { describe, it, expect, afterEach, vi } from "vitest";
import { GDriveBackend } from "./gdrive-backend";
import { KEYS } from "@/lib/utils/storage";
import type { BackendConfig, SyncPacket } from "@/lib/types";

// Drive keys files by id, not by name, so one folder can legitimately hold two files
// called konode_<type>_<device>.json: an upload that created where it should have patched,
// or two writes racing. Both came back as peers, and the stale one, folded in
// last, was the one that won. Its `name contains` filter is a loose token match as well,
// so the query can answer with names that merely share the words.

const cfg: BackendConfig = {
  type: "gdrive", label: "Google Drive", enabled: true, gdrive: { folderId: "pinned" },
};

function packet(deviceId: string, timestamp: string): SyncPacket {
  return {
    version: "1.0", device_id: deviceId, timestamp, data_type: "extensions",
    checksum: "a".repeat(64), encrypted: false, payload: "[]",
  };
}

/** Drive lists via a files?q= URL (no ".json"), then fetches files/<id>?alt=media. */
function driveHolds(
  files: Array<{ id: string; name: string }>,
  bodies: Record<string, SyncPacket>
): () => number {
  let downloads = 0;
  vi.stubGlobal("fetch", (url: string) => {
    const s = String(url);
    if (s.includes("alt=media")) {
      downloads++;
      const id = /files\/([^?]+)\?/.exec(s)?.[1] ?? "";
      const body = bodies[id];
      return Promise.resolve({
        ok: !!body, status: body ? 200 : 404,
        text: () => Promise.resolve(JSON.stringify(body ?? {})),
      } as Response);
    }
    return Promise.resolve({
      ok: true, status: 200, json: () => Promise.resolve({ files }),
    } as Response);
  });
  return () => downloads;
}

async function signedIn(): Promise<void> {
  await chrome.storage.local.set({
    [KEYS.GDRIVE_SESSION]: {
      access_token: "t", expires_at: Date.now() + 3_600_000,
      email: "", displayName: "", savedAt: Date.now(),
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Drive downloadAll: one file per device, and only files that are ours to read", () => {
  it("takes the newest of two files for the same device, and downloads only that one", async () => {
    await signedIn();
    // The listing is ordered modifiedTime desc, so the current file comes first.
    const downloads = driveHolds(
      [
        { id: "new", name: "konode_extensions_peer1.json" },
        { id: "old", name: "konode_extensions_peer1.json" },
      ],
      {
        new: packet("peer1", "2026-08-24T10:00:00.000Z"),
        old: packet("peer1", "2026-08-01T10:00:00.000Z"),
      }
    );

    const packets = await new GDriveBackend(cfg).downloadAll("extensions", "me");

    expect(packets.map((p) => p.timestamp)).toEqual(["2026-08-24T10:00:00.000Z"]);
    expect(downloads()).toBe(1); // the stale copy isn't even fetched
  });

  it("ignores a name the loose `contains` query matched but we never wrote", async () => {
    await signedIn();
    const downloads = driveHolds(
      [
        { id: "snap", name: "konode_snap_extensions_1756200000000.json" },
        { id: "peer", name: "konode_extensions_peer1.json" },
      ],
      { snap: packet("peer1", "2026-08-26T10:00:00.000Z"), peer: packet("peer1", "2026-08-24T10:00:00.000Z") }
    );

    const packets = await new GDriveBackend(cfg).downloadAll("extensions", "me");

    expect(packets.map((p) => p.timestamp)).toEqual(["2026-08-24T10:00:00.000Z"]);
    expect(downloads()).toBe(1);
  });

  it("still leaves our own file out", async () => {
    await signedIn();
    const downloads = driveHolds(
      [
        { id: "mine", name: "konode_extensions_me.json" },
        { id: "peer", name: "konode_extensions_peer1.json" },
      ],
      { mine: packet("me", "2026-08-26T10:00:00.000Z"), peer: packet("peer1", "2026-08-24T10:00:00.000Z") }
    );

    const packets = await new GDriveBackend(cfg).downloadAll("extensions", "me");

    expect(packets.map((p) => p.device_id)).toEqual(["peer1"]);
    expect(downloads()).toBe(1);
  });
});

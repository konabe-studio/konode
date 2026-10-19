import { describe, it, expect, vi, beforeEach } from "vitest";
import { noteCleanSync, rateCardDue, RATE_MIN_DAYS, RATE_MIN_SYNCS } from "./rate-prompt";
import {
  DEFAULT_SETTINGS, KEYS, getRateAnswered, getRateProgress, getState, setRateAnswered, setRateProgress,
} from "@/lib/utils/storage";
import type { DataType, IBackend, SyncPacket, SyncSettings } from "@/lib/types";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-10-01T12:00:00Z");

describe("rateCardDue", () => {
  const done = { first_at: new Date(T0).toISOString(), syncs: RATE_MIN_SYNCS };

  it("shows once both the time and the syncs are there", () => {
    expect(rateCardDue(done, null, T0 + RATE_MIN_DAYS * DAY)).toBe(true);
  });

  it("waits for two weeks even after many syncs", () => {
    expect(rateCardDue(done, null, T0 + RATE_MIN_DAYS * DAY - 1)).toBe(false);
  });

  it("waits for the syncs even after two weeks", () => {
    expect(rateCardDue({ ...done, syncs: RATE_MIN_SYNCS - 1 }, null, T0 + 60 * DAY)).toBe(false);
  });

  it("never shows again once answered, either way", () => {
    expect(rateCardDue(done, new Date(T0).toISOString(), T0 + 60 * DAY)).toBe(false);
  });

  it("does not show with nothing counted, or a start it cannot read", () => {
    expect(rateCardDue(null, null, T0 + 60 * DAY)).toBe(false);
    expect(rateCardDue({ first_at: "not a date", syncs: RATE_MIN_SYNCS }, null, T0 + 60 * DAY)).toBe(false);
  });
});

describe("noteCleanSync", () => {
  it("starts the clock at the first sync that counts and keeps it there", async () => {
    expect(await noteCleanSync(T0)).toBe(false);
    expect(await noteCleanSync(T0 + DAY)).toBe(false);
    expect(await getRateProgress()).toEqual({ first_at: new Date(T0).toISOString(), syncs: 2 });
  });

  it("stops writing once it has counted enough", async () => {
    await setRateProgress({ first_at: new Date(T0).toISOString(), syncs: RATE_MIN_SYNCS - 1 });
    expect(await noteCleanSync(T0)).toBe(true);
    const writes = vi.spyOn(chrome.storage.local, "set");
    try {
      expect(await noteCleanSync(T0)).toBe(true);
      expect(writes).not.toHaveBeenCalled();
    } finally {
      writes.mockRestore();
    }
    expect((await getRateProgress())?.syncs).toBe(RATE_MIN_SYNCS);
  });

  // The popup records the answer while the worker may be counting. Each owns its key, so
  // a count landing just after the answer cannot write the card back into existence.
  it("never touches the answer", async () => {
    await setRateAnswered(new Date(T0).toISOString());
    await noteCleanSync(T0 + DAY);
    expect(await getRateAnswered()).toBe(new Date(T0).toISOString());
    const all = await chrome.storage.local.get(KEYS.RATE_PROGRESS);
    expect(all[KEYS.RATE_PROGRESS]).not.toHaveProperty("answered");
  });
});

// ─── What the engine counts ─────────────────────────────────────────────────

/** One shared in-memory folder, handed to every engine by the mocked factory. */
class Folder implements IBackend {
  readonly type = "webdav" as const;
  packets = new Map<string, SyncPacket>();
  blobs = new Map<string, string>();
  failConnect = false;
  isConfigured(): boolean { return true; }
  connect(): Promise<void> {
    return this.failConnect ? Promise.reject(new Error("server said no")) : Promise.resolve();
  }
  disconnect(): Promise<void> { return Promise.resolve(); }
  testConnection(): Promise<{ ok: boolean; message: string }> { return Promise.resolve({ ok: true, message: "" }); }
  upload(p: SyncPacket): Promise<void> {
    const name = `konode_${p.data_type}_${p.device_id}.json`;
    this.packets.set(name, p);
    this.blobs.set(name, JSON.stringify(p));
    return Promise.resolve();
  }
  downloadAll(t: DataType, exclude?: string): Promise<SyncPacket[]> {
    return Promise.resolve([...this.packets.values()].filter((p) => p.data_type === t && p.device_id !== exclude));
  }
  putFile(name: string, content: string): Promise<void> { this.blobs.set(name, content); return Promise.resolve(); }
  getFile(name: string): Promise<string | null> { return Promise.resolve(this.blobs.get(name) ?? null); }
  listFiles(prefix: string): Promise<string[]> {
    return Promise.resolve([...this.blobs.keys()].filter((n) => n.startsWith(prefix)));
  }
  deleteFile(name: string): Promise<void> {
    this.blobs.delete(name);
    this.packets.delete(name);
    return Promise.resolve();
  }
}

let folder: Folder;
vi.mock("@/lib/backends/abstract-backend", async (orig) => ({
  ...(await orig<typeof import("@/lib/backends/abstract-backend")>()),
  createBackend: () => folder,
}));
const { SyncEngine } = await import("@/lib/sync/sync-engine");

function device(id: string) {
  const settings: SyncSettings = {
    ...DEFAULT_SETTINGS,
    device_id: id,
    device_label: id,
    conflict_strategy: "lww",
    encryption_enabled: false,
    active_backend: "webdav",
    backends: [{ type: "webdav", label: "WebDAV", enabled: true, webdav: { url: "https://dav.example.com/", username: "u", password: "p" } }],
  };
  return new SyncEngine(settings, () => {});
}

describe("SyncEngine counts a sync for the rating card", () => {
  beforeEach(async () => {
    folder = new Folder();
    // An empty tree publishes nothing, and then there is no other device to read.
    await chrome.bookmarks.create({ parentId: "1", title: "Example", url: "https://example.com/" });
  });

  it("not while this is the only device in the folder", async () => {
    await device("A").sync();
    expect((await getState()).status).toBe("success");
    expect(await getRateProgress()).toBeNull();
  });

  it("once another device's file is there", async () => {
    await device("B").sync(); // alone: does not count
    await device("A").sync(); // reads B: counts
    expect((await getState()).status).toBe("success");
    expect((await getRateProgress())?.syncs).toBe(1);
  });

  it("not when the sync failed", async () => {
    await device("B").sync();
    folder.failConnect = true;
    await device("A").sync();
    expect((await getState()).status).toBe("error");
    expect(await getRateProgress()).toBeNull();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SETTINGS, KEYS } from "@/lib/utils/storage";
import type { SyncSettings } from "@/lib/types";

// listDevices and forgetDevice go through withBackend, which builds its own backend from
// the active config rather than taking an injected one, so createBackend is mocked here
// instead of in sync-engine.test.ts (which injects a fake directly and needs no mock).

const h = vi.hoisted(() => ({
  files: new Map<string, string>(),
  fetched: [] as string[],
  unreadable: new Set<string>(),
}));

vi.mock("@/lib/backends/abstract-backend", () => ({
  createBackend: () => ({
    type: "webdav",
    isConfigured: () => true,
    connect: async () => {},
    disconnect: async () => {},
    listFiles: async (prefix: string) => [...h.files.keys()].filter((n) => n.startsWith(prefix)),
    getFile: async (name: string) => {
      h.fetched.push(name);
      if (h.unreadable.has(name)) throw new Error("403");
      return h.files.get(name) ?? null;
    },
    deleteFile: async (name: string) => {
      // Mirrors a real backend: deleting something that was never there is an error, which
      // is the normal case for a device that only ever synced two of the four types.
      if (!h.files.delete(name)) throw new Error("404");
    },
    upload: async () => {},
    downloadAll: async () => [],
    putFile: async () => {},
    listVersions: async () => [],
    testConnection: async () => ({ ok: true, message: "" }),
  }),
}));

const { SyncEngine } = await import("@/lib/sync/sync-engine");

function settings(): SyncSettings {
  return {
    ...DEFAULT_SETTINGS,
    device_id: "me",
    device_label: "My Laptop",
    active_backend: "webdav",
    backends: [{
      type: "webdav", label: "WebDAV", enabled: true,
      webdav: { url: "https://dav.example.com/dav/", username: "u", password: "p" },
    }],
  };
}

/** A packet as it lands on the backend: metadata plaintext, payload possibly not. */
function packet(device_id: string, data_type: string, label: string | undefined, at: string) {
  return JSON.stringify({
    version: "1.0", device_id, data_type,
    ...(label === undefined ? {} : { device_label: label }),
    timestamp: at, checksum: "a".repeat(64), encrypted: true, payload: "<ciphertext>",
  });
}

beforeEach(() => {
  h.files.clear();
  h.fetched.length = 0;
  h.unreadable.clear();
});

describe("listDevices", () => {
  it("names every device in the folder and puts this one first", async () => {
    h.files.set("konode_bookmarks_me.json", packet("me", "bookmarks", "My Laptop", "2026-08-03T10:00:00.000Z"));
    h.files.set("konode_bookmarks_peer1.json", packet("peer1", "bookmarks", "Work Mac", "2026-08-01T10:00:00.000Z"));
    h.files.set("konode_history_peer1.json", packet("peer1", "history", "Work Mac", "2026-08-01T10:00:00.000Z"));
    h.files.set("konode_extensions_peer2.json", packet("peer2", "extensions", "Old Phone", "2026-08-02T10:00:00.000Z"));

    const devices = await new SyncEngine(settings(), () => {}).listDevices();

    expect(devices.map((d) => d.label)).toEqual(["My Laptop", "Old Phone", "Work Mac"]);
    expect(devices[0].isSelf).toBe(true);
    expect(devices.filter((d) => d.isSelf)).toHaveLength(1);
    expect(devices.find((d) => d.label === "Work Mac")?.types).toEqual(["bookmarks", "history"]);
  });

  it("never downloads a history packet just to list devices", async () => {
    // The reported first sync was 3,737 entries; one device's history file was 1.3 MB. A
    // device list has no business fetching that, so it reads the cheapest type present.
    h.files.set("konode_history_peer1.json", packet("peer1", "history", "Big Machine", "2026-08-01T10:00:00.000Z"));
    h.files.set("konode_bookmarks_peer1.json", packet("peer1", "bookmarks", "Big Machine", "2026-08-01T10:00:00.000Z"));
    h.files.set("konode_extensions_peer1.json", packet("peer1", "extensions", "Big Machine", "2026-08-01T10:00:00.000Z"));

    await new SyncEngine(settings(), () => {}).listDevices();

    expect(h.fetched).toEqual(["konode_extensions_peer1.json"]);
  });

  it("reads the name and time even when the payload is encrypted", async () => {
    // device_label and timestamp sit OUTSIDE the ciphertext, so this works with E2EE on and
    // without the passphrase. If that ever stopped being true, the list would go blank.
    h.files.set("konode_extensions_peer1.json", packet("peer1", "extensions", "Encrypted Box", "2026-08-01T09:30:00.000Z"));

    const [d] = await new SyncEngine(settings(), () => {}).listDevices();

    expect(d.label).toBe("Encrypted Box");
    expect(d.lastSeen).toBe("2026-08-01T09:30:00.000Z");
  });

  it("costs one device its name, not the whole list, when its file can't be read", async () => {
    h.files.set("konode_extensions_peer1.json", packet("peer1", "extensions", "Readable", "2026-08-01T10:00:00.000Z"));
    h.files.set("konode_extensions_peer2.json", packet("peer2", "extensions", "Refused", "2026-08-02T10:00:00.000Z"));
    h.unreadable.add("konode_extensions_peer2.json");
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const devices = await new SyncEngine(settings(), () => {}).listDevices();

    expect(devices).toHaveLength(2);
    expect(devices.find((d) => d.device_id === "peer1")?.label).toBe("Readable");
    expect(devices.find((d) => d.device_id === "peer2")?.label).toBeNull();
  });

  it("still lists a device whose packets predate the name field", async () => {
    h.files.set("konode_extensions_peer1.json", packet("peer1", "extensions", undefined, "2026-08-01T10:00:00.000Z"));

    const [d] = await new SyncEngine(settings(), () => {}).listDevices();

    expect(d.label).toBeNull();
    expect(d.device_id).toBe("peer1");
  });

  it("ignores the snapshot files sitting in the same folder", async () => {
    h.files.set("konode_snap_index.json", "{}");
    h.files.set("konode_snap_bookmarks_1.json", "{}");
    h.files.set("konode_bookmarks_peer1.json", packet("peer1", "bookmarks", "Real", "2026-08-01T10:00:00.000Z"));

    const devices = await new SyncEngine(settings(), () => {}).listDevices();

    expect(devices.map((d) => d.device_id)).toEqual(["peer1"]);
  });
});

describe("forgetDevice", () => {
  it("deletes every file that device had, and leaves the others alone", async () => {
    h.files.set("konode_bookmarks_peer1.json", packet("peer1", "bookmarks", "Gone", "2026-08-01T10:00:00.000Z"));
    h.files.set("konode_history_peer1.json", packet("peer1", "history", "Gone", "2026-08-01T10:00:00.000Z"));
    h.files.set("konode_bookmarks_peer2.json", packet("peer2", "bookmarks", "Stays", "2026-08-01T10:00:00.000Z"));
    vi.spyOn(console, "info").mockImplementation(() => {});

    const removed = await new SyncEngine(settings(), () => {}).forgetDevice("peer1");

    expect(removed).toBe(2); // it only had two of the four types
    expect([...h.files.keys()]).toEqual(["konode_bookmarks_peer2.json"]);
  });

  it("clears that device out of the cached sessions and extensions too", async () => {
    // Otherwise the popup keeps listing a session for a device whose files are gone.
    await chrome.storage.local.set({
      [KEYS.REMOTE_SESSIONS]: { peer1: { device_id: "peer1" }, peer2: { device_id: "peer2" } },
      [KEYS.REMOTE_EXTENSIONS]: { peer1: { device_id: "peer1" } },
    });
    h.files.set("konode_bookmarks_peer1.json", packet("peer1", "bookmarks", "Gone", "2026-08-01T10:00:00.000Z"));
    vi.spyOn(console, "info").mockImplementation(() => {});

    await new SyncEngine(settings(), () => {}).forgetDevice("peer1");

    const r = await chrome.storage.local.get([KEYS.REMOTE_SESSIONS, KEYS.REMOTE_EXTENSIONS]);
    expect(Object.keys(r[KEYS.REMOTE_SESSIONS] as object)).toEqual(["peer2"]);
    expect(Object.keys(r[KEYS.REMOTE_EXTENSIONS] as object)).toEqual([]);
  });

  it("refuses to forget THIS device", async () => {
    // Deleting our own files removes this device's contribution from every peer's view,
    // which is not what anyone means by forgetting a device. Guarded in the engine as well
    // as hidden in the UI.
    h.files.set("konode_bookmarks_me.json", packet("me", "bookmarks", "My Laptop", "2026-08-03T10:00:00.000Z"));

    await expect(new SyncEngine(settings(), () => {}).forgetDevice("me")).rejects.toThrow(/this device/i);
    expect(h.files.has("konode_bookmarks_me.json")).toBe(true);
  });
});

describe("a device notices when its own file has gone missing", () => {
  // uploadIfChanged skips an upload when the LOCAL checksum record says this exact content
  // already went out. That record lives on this device, so it knows nothing about the file
  // being deleted at the other end — and a payload that doesn't change on its own is then
  // never re-uploaded. The installed-extension list is exactly that. Three ways this
  // happens for real: another device used Forget on us, the user tidied the folder by hand
  // at their provider (which we have actively suggested), or the provider lost a file.
  //
  // This pass only MARKS the type — `uploadIfChanged` does the re-upload and the logging,
  // because an empty payload is never uploaded at all and must therefore never be
  // announced (see sync-engine.test.ts). So these tests read the mark, and check that the
  // checksum record is left exactly as it was.
  type EnginePrivate = {
    findOwnMissingFiles: (b: unknown, types: string[]) => Promise<void>;
    ownFilesMissing: Set<string>;
  };
  const priv = (e: unknown): EnginePrivate => e as EnginePrivate;

  const backend = (opts: { fail?: boolean } = {}) => ({
    listFiles: async (prefix: string) => {
      if (opts.fail) throw new Error("503");
      return [...h.files.keys()].filter((n) => n.startsWith(prefix));
    },
  });

  const checksums = async (): Promise<Record<string, string>> => {
    const r = await chrome.storage.local.get(KEYS.UPLOAD_CHECKSUMS);
    return (r[KEYS.UPLOAD_CHECKSUMS] as Record<string, string>) ?? {};
  };

  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("marks the type so the next upload goes out regardless of the checksum", async () => {
    await chrome.storage.local.set({ [KEYS.UPLOAD_CHECKSUMS]: { extensions: "plain:abc" } });
    // The folder has our bookmarks but NOT our extensions.
    h.files.set("konode_bookmarks_me.json", packet("me", "bookmarks", "My Laptop", "2026-08-03T10:00:00.000Z"));

    const engine = new SyncEngine(settings(), () => {});
    await priv(engine).findOwnMissingFiles(backend(), ["extensions"]);

    expect([...priv(engine).ownFilesMissing]).toEqual(["extensions"]);
    // The record itself is untouched: uploadIfChanged decides, and it is the only thing
    // that knows whether an upload happens at all.
    expect((await checksums()).extensions).toBe("plain:abc");
  });

  it("marks nothing when the file is right where it should be", async () => {
    await chrome.storage.local.set({ [KEYS.UPLOAD_CHECKSUMS]: { extensions: "plain:abc" } });
    h.files.set("konode_extensions_me.json", packet("me", "extensions", "My Laptop", "2026-08-03T10:00:00.000Z"));

    const engine = new SyncEngine(settings(), () => {});
    await priv(engine).findOwnMissingFiles(backend(), ["extensions"]);

    expect([...priv(engine).ownFilesMissing]).toEqual([]);
    expect((await checksums()).extensions).toBe("plain:abc");
  });

  it("does nothing for a type this device has never uploaded", async () => {
    // No record means nothing has gone missing; the ordinary first-upload path handles it.
    const engine = new SyncEngine(settings(), () => {});
    await priv(engine).findOwnMissingFiles(backend(), ["history"]);

    expect([...priv(engine).ownFilesMissing]).toEqual([]);
    expect(await checksums()).toEqual({});
  });

  it("stays quiet and harmless when the folder can't be listed", async () => {
    // A sync that works is worth more than this check, so a failed listing means "don't
    // know" rather than "missing".
    await chrome.storage.local.set({ [KEYS.UPLOAD_CHECKSUMS]: { extensions: "plain:abc" } });

    const engine = new SyncEngine(settings(), () => {});
    await expect(
      priv(engine).findOwnMissingFiles(backend({ fail: true }), ["extensions"])
    ).resolves.toBeUndefined();
    expect([...priv(engine).ownFilesMissing]).toEqual([]);
    expect((await checksums()).extensions).toBe("plain:abc");
  });

  it("forgets last sync's marks, so a file that came back is not re-announced", async () => {
    // The set is engine state and `sync()` is called once a minute for the lifetime of the
    // service worker. A stale mark would force a pointless upload, or announce a file that
    // is sitting right there.
    await chrome.storage.local.set({ [KEYS.UPLOAD_CHECKSUMS]: { extensions: "plain:abc" } });
    const engine = new SyncEngine(settings(), () => {});
    await priv(engine).findOwnMissingFiles(backend(), ["extensions"]);
    expect([...priv(engine).ownFilesMissing]).toEqual(["extensions"]);

    h.files.set("konode_extensions_me.json", packet("me", "extensions", "My Laptop", "2026-08-03T10:00:00.000Z"));
    await priv(engine).findOwnMissingFiles(backend(), ["extensions"]);

    expect([...priv(engine).ownFilesMissing]).toEqual([]);
  });
});

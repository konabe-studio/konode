import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SETTINGS, getState } from "@/lib/utils/storage";
import type { DataType, SyncPacket, SyncSettings } from "@/lib/types";

// What the popup and the onboarding finish screen print comes from sync() as a whole, not
// from syncType, and sync() builds its own backend from the active config. So the backend
// is mocked here, the way devices.test.ts does it, instead of in sync-engine.test.ts.

const h = vi.hoisted(() => ({
  packets: [] as SyncPacket[],
  blobs: new Map<string, string>(),
}));

vi.mock("@/lib/backends/abstract-backend", () => ({
  createBackend: () => ({
    type: "webdav",
    isConfigured: () => true,
    connect: async () => {},
    disconnect: async () => {},
    upload: async (p: SyncPacket) => {
      h.blobs.set(`konode_${p.data_type}_${p.device_id}.json`, JSON.stringify(p));
    },
    downloadAll: async (dataType: DataType, exclude?: string) =>
      h.packets.filter((p) => p.data_type === dataType && p.device_id !== exclude),
    listFiles: async (prefix: string) => [...h.blobs.keys()].filter((n) => n.startsWith(prefix)),
    getFile: async (name: string) => h.blobs.get(name) ?? null,
    putFile: async (name: string, content: string) => { h.blobs.set(name, content); },
    deleteFile: async (name: string) => { h.blobs.delete(name); },
    listVersions: async () => [],
    testConnection: async () => ({ ok: true, message: "" }),
  }),
}));

const { SyncEngine } = await import("@/lib/sync/sync-engine");

function settings(): SyncSettings {
  return {
    ...DEFAULT_SETTINGS,
    device_id: "me",
    active_backend: "webdav",
    backends: [{
      type: "webdav", label: "WebDAV", enabled: true,
      webdav: { url: "https://dav.example.com/dav/", username: "u", password: "p" },
    }],
  };
}

/** An end-to-end encrypted peer's bookmarks. Only the `encrypted` flag matters here: a
 *  device with E2EE off refuses the packet before it would try to read the payload. */
function encryptedPeer(device_id: string): SyncPacket {
  return {
    version: "1.0", device_id, data_type: "bookmarks",
    timestamp: "2026-09-30T10:00:00.000Z", checksum: "a".repeat(64),
    encrypted: true, payload: "<ciphertext>",
  } as SyncPacket;
}

beforeEach(() => {
  h.packets.length = 0;
  h.blobs.clear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("SyncEngine.sync: the problem line says each thing once", () => {
  it("prints the E2EE message once however many encrypted devices are in the folder", async () => {
    // From the 1.4.x device QA: a new device without E2EE, set up on a folder that two
    // encrypted devices use, finished onboarding with "Some of your devices are end-to-end
    // encrypted..." twice in a row. The warning is kept per peer, and the sentence names
    // no device, so the two copies read as one message repeated.
    h.packets.push(encryptedPeer("dc0b7b0f-peer"), encryptedPeer("3cff6456-peer"));

    expect(await new SyncEngine(settings(), () => {}).sync()).toBe("ran");

    const st = await getState();
    expect(st.status).toBe("error");
    const msg = "Some of your devices are end-to-end encrypted.";
    expect(st.last_error?.split(msg).length).toBe(2); // exactly one occurrence
  });
});

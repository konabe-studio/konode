import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SyncEngine, PEER_MARKER_SETTLE_MS } from "@/lib/sync/sync-engine";
import {
  DEFAULT_SETTINGS,
  DEFAULT_STATE,
  KEYS,
  dropRemoteDevices,
  getRemoteSessions,
  peerFilesKey,
  type PeerFileMemory,
} from "@/lib/utils/storage";
import type {
  BackendConfig,
  DataType,
  IBackend,
  PeerFile,
  PeerPull,
  SyncPacket,
  SyncSession,
  SyncSettings,
  SyncState,
} from "@/lib/types";

/**
 * A peer file that has not changed since this device last read it is not downloaded again
 * (#96). Every sync used to fetch every peer's file in full: six devices with long histories
 * came to about 16 MB a minute, and Edge froze.
 *
 * The backend here keeps files as bytes, as a real folder does, and lists each with a
 * marker the way the three real ones do: a content hash (Drive, GitHub), or, with
 * `exact = false`, a WebDAV ETag that can stay the same across a same-second rewrite.
 */
class MarkerBackend implements IBackend {
  readonly type = "webdav" as const;
  blobs = new Map<string, string>();
  /** Markers set by hand, for an ETag that does not move when the content does. */
  pinned = new Map<string, string>();
  exact = true;
  /** Every file handed out in full, through the pull or getFile. */
  downloads: string[] = [];
  uploads: SyncPacket[] = [];

  isConfigured(): boolean { return true; }
  connect(): Promise<void> { return Promise.resolve(); }
  disconnect(): Promise<void> { return Promise.resolve(); }
  testConnection(): Promise<{ ok: boolean; message: string }> { return Promise.resolve({ ok: true, message: "" }); }
  upload(packet: SyncPacket): Promise<void> {
    this.uploads.push(packet);
    this.blobs.set(`konode_${packet.data_type}_${packet.device_id}.json`, JSON.stringify(packet));
    return Promise.resolve();
  }
  put(packet: SyncPacket): void {
    this.blobs.set(`konode_${packet.data_type}_${packet.device_id}.json`, JSON.stringify(packet));
  }
  marker(name: string): string {
    const pinned = this.pinned.get(name);
    if (pinned) return pinned;
    const text = this.blobs.get(name)!;
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
    return `"${(h >>> 0).toString(16)}-${text.length}"`;
  }
  private peers(data_type: DataType, exclude?: string): Array<{ name: string; device_id: string }> {
    const prefix = `konode_${data_type}_`;
    return [...this.blobs.keys()]
      .filter((n) => n.startsWith(prefix) && n.endsWith(".json"))
      .map((name) => ({ name, device_id: name.slice(prefix.length, -".json".length) }))
      .filter((f) => f.device_id !== exclude);
  }
  downloadAll(data_type: DataType, excludeDeviceId?: string): Promise<SyncPacket[]> {
    return this.downloadChanged(data_type, excludeDeviceId ?? "", {}).then((p) => p.fetched.map((f) => f.packet));
  }
  downloadChanged(data_type: DataType, excludeDeviceId: string, known: Record<string, string>): Promise<PeerPull> {
    const out: PeerPull = { fetched: [], unchanged: [] };
    for (const { name, device_id } of this.peers(data_type, excludeDeviceId)) {
      const file: PeerFile = { device_id, marker: this.marker(name), exact: this.exact };
      if (known[device_id] === file.marker) { out.unchanged.push(file); continue; }
      this.downloads.push(name);
      out.fetched.push({ packet: JSON.parse(this.blobs.get(name)!) as SyncPacket, file });
    }
    return Promise.resolve(out);
  }
  getFile(name: string): Promise<string | null> {
    const blob = this.blobs.get(name) ?? null;
    if (blob !== null) this.downloads.push(name);
    return Promise.resolve(blob);
  }
  putFile(name: string, content: string): Promise<void> { this.blobs.set(name, content); return Promise.resolve(); }
  listFiles(prefix: string): Promise<string[]> {
    return Promise.resolve([...this.blobs.keys()].filter((n) => n.startsWith(prefix)));
  }
  deleteFile(name: string): Promise<void> { this.blobs.delete(name); return Promise.resolve(); }
}

type EnginePrivate = {
  syncType(dataType: DataType, backend: IBackend, state: SyncState): Promise<void>;
  buildPacket(dataType: DataType, payload: unknown): Promise<SyncPacket>;
  bytesThisSync: number;
  historyIndexThisSync: unknown;
};
const priv = (e: SyncEngine): EnginePrivate => e as unknown as EnginePrivate;

const WEBDAV: BackendConfig = {
  type: "webdav", label: "WebDAV", enabled: true,
  webdav: { url: "https://dav.example/remote.php/dav/files/u", username: "u", password: "p" },
};

function makeEngine(over: Partial<SyncSettings> = {}): SyncEngine {
  return new SyncEngine({
    ...DEFAULT_SETTINGS,
    device_id: "me",
    conflict_strategy: "lww",
    encryption_enabled: false,
    backends: [WEBDAV],
    active_backend: "webdav",
    ...over,
  }, () => {});
}

/** What `sync()` resets before each run. */
function nextSync(engine: SyncEngine): void {
  priv(engine).bytesThisSync = 0;
  priv(engine).historyIndexThisSync = null;
}

const VISIT = Date.now() - 60_000;
async function historyPacket(engine: SyncEngine, deviceId: string, urls: string[]): Promise<SyncPacket> {
  const packet = await priv(engine).buildPacket(
    "history",
    urls.map((url) => ({ url, title: url, lastVisitTime: VISIT, visitCount: 1 }))
  );
  packet.device_id = deviceId; // the checksum is over the payload, so it stays valid
  return packet;
}

function session(deviceId: string, url = `https://${deviceId}.example/`): SyncSession {
  return { id: `s-${deviceId}`, device_id: deviceId, savedAt: "2026-11-20T10:00:00.000Z", label: deviceId, tabs: [{ url, pinned: false }] };
}
async function sessionPacket(
  engine: SyncEngine, deviceId: string, url?: string, timestamp = "2026-11-20T10:00:00.000Z"
): Promise<SyncPacket> {
  const packet = await priv(engine).buildPacket("sessions", session(deviceId, url));
  packet.device_id = deviceId;
  // Fixed, and the same length whatever the value, so a rewrite can keep the file's size.
  packet.timestamp = timestamp;
  return packet;
}

async function remembered(dataType: DataType): Promise<PeerFileMemory | undefined> {
  const key = peerFilesKey(dataType);
  return (await chrome.storage.local.get(key))[key] as PeerFileMemory | undefined;
}

beforeEach(() => {
  for (const m of ["info", "debug", "warn", "error", "log"] as const) vi.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe("an unchanged peer file is not downloaded again (#96)", () => {
  it("downloads nothing on a second sync of unchanged history, and counts no bytes for it", async () => {
    const engine = makeEngine();
    const backend = new MarkerBackend();
    backend.put(await historyPacket(engine, "peer1", ["https://one.example/"]));
    backend.put(await historyPacket(engine, "peer2", ["https://two.example/"]));
    const adds = vi.spyOn(chrome.history, "addUrl");

    await priv(engine).syncType("history", backend, DEFAULT_STATE);
    expect(backend.downloads.sort()).toEqual(["konode_history_peer1.json", "konode_history_peer2.json"]);
    expect(priv(engine).bytesThisSync).toBeGreaterThan(0);
    expect(adds).toHaveBeenCalledTimes(2);

    backend.downloads = [];
    nextSync(engine);
    await priv(engine).syncType("history", backend, DEFAULT_STATE);
    expect(backend.downloads).toEqual([]);
    expect(adds).toHaveBeenCalledTimes(2);
    // Our own upload is the only traffic, and it did not change either.
    expect(priv(engine).bytesThisSync).toBe(0);
  });

  it("keeps the history envelope only, never its payload", async () => {
    const engine = makeEngine();
    const backend = new MarkerBackend();
    const packet = await historyPacket(engine, "peer1", ["https://one.example/"]);
    backend.put(packet);

    await priv(engine).syncType("history", backend, DEFAULT_STATE);

    const record = (await remembered("history"))!.peers.peer1;
    expect(record.packet.payload).toBe("");
    expect(record.packet.checksum).toBe(packet.checksum);
    expect(record.settled).toBe(true);
  });

  it("downloads a changed peer again, and only that one", async () => {
    const engine = makeEngine();
    const backend = new MarkerBackend();
    backend.put(await historyPacket(engine, "peer1", ["https://one.example/"]));
    backend.put(await historyPacket(engine, "peer2", ["https://two.example/"]));
    await priv(engine).syncType("history", backend, DEFAULT_STATE);

    backend.put(await historyPacket(engine, "peer2", ["https://two.example/", "https://three.example/"]));
    backend.downloads = [];
    nextSync(engine);
    await priv(engine).syncType("history", backend, DEFAULT_STATE);

    expect(backend.downloads).toEqual(["konode_history_peer2.json"]);
    const visited = (await chrome.history.search({ text: "", startTime: 0, maxResults: 100 })).map((h) => h.url);
    expect(visited).toContain("https://three.example/");
  });

  it("fetches an unchanged history file after all when this device has lost track of importing it", async () => {
    const engine = makeEngine();
    const backend = new MarkerBackend();
    backend.put(await historyPacket(engine, "peer1", ["https://one.example/"]));
    await priv(engine).syncType("history", backend, DEFAULT_STATE);

    // The import record is gone (a reset, a cleared key): the remembered marker alone must
    // not stop the import, so the one file is fetched and imported.
    await chrome.storage.local.remove(KEYS.HIST_APPLIED);
    backend.downloads = [];
    nextSync(engine);
    await priv(engine).syncType("history", backend, DEFAULT_STATE);

    expect(backend.downloads).toEqual(["konode_history_peer1.json"]);
    const applied = (await chrome.storage.local.get(KEYS.HIST_APPLIED))[KEYS.HIST_APPLIED];
    expect(applied).toEqual({ peer1: JSON.parse(backend.blobs.get("konode_history_peer1.json")!).checksum });
  });

  it("does not remember a peer that failed, so the next sync downloads it again", async () => {
    const engine = makeEngine();
    const backend = new MarkerBackend();
    const packet = await historyPacket(engine, "peer1", ["https://one.example/"]);
    backend.put({ ...packet, checksum: "0".repeat(64) }); // fails verification

    await priv(engine).syncType("history", backend, DEFAULT_STATE);
    expect((await remembered("history"))?.peers.peer1).toBeUndefined();

    backend.downloads = [];
    nextSync(engine);
    await priv(engine).syncType("history", backend, DEFAULT_STATE);
    expect(backend.downloads).toEqual(["konode_history_peer1.json"]);
  });

  it("hands an unchanged session over from what it remembered, cache and all", async () => {
    const engine = makeEngine();
    const backend = new MarkerBackend();
    backend.put(await sessionPacket(engine, "peer1"));
    await priv(engine).syncType("sessions", backend, DEFAULT_STATE);
    expect((await getRemoteSessions()).map((e) => e.device_id)).toEqual(["peer1"]);

    // Even with the popup's cache emptied, the remembered packet fills it again, without a
    // download, exactly as the download would have.
    await dropRemoteDevices("sessions", ["peer1"]);
    backend.downloads = [];
    await priv(engine).syncType("sessions", backend, DEFAULT_STATE);
    expect(backend.downloads).toEqual([]);
    expect((await getRemoteSessions()).map((e) => e.session.tabs[0].url)).toEqual(["https://peer1.example/"]);
  });

  it("forgets the markers of a folder it no longer syncs with", async () => {
    const backend = new MarkerBackend();
    const first = makeEngine();
    backend.put(await sessionPacket(first, "peer1"));
    await priv(first).syncType("sessions", backend, DEFAULT_STATE);

    // Another server: an ETag only means something to the one that issued it.
    const moved = makeEngine({ backends: [{ ...WEBDAV, webdav: { ...WEBDAV.webdav!, url: "https://other.example/dav" } }] });
    backend.downloads = [];
    await priv(moved).syncType("sessions", backend, DEFAULT_STATE);
    expect(backend.downloads).toEqual(["konode_sessions_peer1.json"]);
  });

  it("counts a peer whose file was not downloaded as a peer of this sync", async () => {
    const engine = makeEngine();
    const backend = new MarkerBackend();
    backend.put(await sessionPacket(engine, "peer1"));
    await priv(engine).syncType("sessions", backend, DEFAULT_STATE);
    const peers = (engine as unknown as { peersThisSync: Set<string> }).peersThisSync;
    peers.clear();
    await priv(engine).syncType("sessions", backend, DEFAULT_STATE);
    expect([...peers]).toEqual(["peer1"]);
  });
});

describe("a WebDAV ETag stands in for a download only once a later read has confirmed it", () => {
  let now = 1_800_000_000_000;
  beforeEach(() => {
    now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
  });

  it("reads a file again until a read made well after its ETag first appeared", async () => {
    const engine = makeEngine();
    const backend = new MarkerBackend();
    backend.exact = false;
    backend.put(await sessionPacket(engine, "peer1"));

    await priv(engine).syncType("sessions", backend, DEFAULT_STATE);
    expect((await remembered("sessions"))!.peers.peer1.settled).toBe(false);

    // Too soon after the listing that first showed the ETag: read again, still not settled.
    now += 1_000;
    backend.downloads = [];
    await priv(engine).syncType("sessions", backend, DEFAULT_STATE);
    expect(backend.downloads).toEqual(["konode_sessions_peer1.json"]);
    expect((await remembered("sessions"))!.peers.peer1.settled).toBe(false);

    // Long enough after: this read confirms the ETag, and from then on it is trusted.
    now += PEER_MARKER_SETTLE_MS;
    await priv(engine).syncType("sessions", backend, DEFAULT_STATE);
    expect((await remembered("sessions"))!.peers.peer1.settled).toBe(true);
    backend.downloads = [];
    now += 60_000;
    await priv(engine).syncType("sessions", backend, DEFAULT_STATE);
    expect(backend.downloads).toEqual([]);
  });

  it("still takes a rewrite that kept the same ETag (same second, same length)", async () => {
    const engine = makeEngine();
    const backend = new MarkerBackend();
    backend.exact = false;
    const name = "konode_sessions_peer1.json";
    backend.put(await sessionPacket(engine, "peer1", "https://aaaa.example/"));
    backend.pinned.set(name, `"5f3c1a2b-1a4"`); // nginx style: mtime seconds and size

    await priv(engine).syncType("sessions", backend, DEFAULT_STATE);

    // The peer writes again inside the same second, at the same length. A server that
    // builds its ETag from the second and the size keeps the old one.
    backend.put(await sessionPacket(engine, "peer1", "https://bbbb.example/", "2026-11-20T10:00:00.500Z"));
    now += 60_000;
    await priv(engine).syncType("sessions", backend, DEFAULT_STATE);

    expect((await getRemoteSessions()).map((e) => e.session.tabs[0].url)).toEqual(["https://bbbb.example/"]);
  });
});

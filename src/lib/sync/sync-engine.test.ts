import { describe, it, expect } from "vitest";
import { SyncEngine, PassphraseError } from "@/lib/sync/sync-engine";
import { DEFAULT_SETTINGS, DEFAULT_STATE } from "@/lib/utils/storage";
import type {
  IBackend,
  DataType,
  SyncPacket,
  SyncState,
  SyncSettings,
  SyncBookmark,
  BookmarkPayload,
} from "@/lib/types";

// Integration test for SyncEngine.syncType against an in-memory backend +
// the chrome.bookmarks/storage fakes from test/setup.ts. Covers the
// pull → fold-every-peer (merge) → push-merged path for bookmarks.

class FakeBackend implements IBackend {
  readonly type = "github" as const;
  files = new Map<string, SyncPacket>();
  uploads: SyncPacket[] = [];
  isConfigured(): boolean { return true; }
  connect(): Promise<void> { return Promise.resolve(); }
  disconnect(): Promise<void> { return Promise.resolve(); }
  upload(packet: SyncPacket): Promise<void> {
    this.files.set(`${packet.data_type}_${packet.device_id}`, packet);
    this.uploads.push(packet);
    return Promise.resolve();
  }
  downloadAll(data_type: DataType, excludeDeviceId?: string): Promise<SyncPacket[]> {
    return Promise.resolve(
      [...this.files.values()].filter(
        (p) => p.data_type === data_type && p.device_id !== excludeDeviceId
      )
    );
  }
  listVersions(): Promise<string[]> { return Promise.resolve([]); }
  testConnection(): Promise<{ ok: boolean; message: string }> {
    return Promise.resolve({ ok: true, message: "" });
  }
}

// Typed view of the private members we drive directly in tests.
type EnginePrivate = {
  syncType(dataType: DataType, backend: IBackend, state: SyncState): Promise<void>;
  buildPacket(dataType: DataType, payload: unknown): Promise<SyncPacket>;
};
function priv(engine: SyncEngine): EnginePrivate {
  return engine as unknown as EnginePrivate;
}

function makeEngine(): SyncEngine {
  const settings: SyncSettings = {
    ...DEFAULT_SETTINGS,
    device_id: "me",
    conflict_strategy: "lww",
    encryption_enabled: false,
  };
  return new SyncEngine(settings, () => {});
}

function payload(barChildren: SyncBookmark[]): BookmarkPayload {
  return {
    tree: [
      {
        id: "0",
        parentId: null,
        title: "",
        dateAdded: 0,
        children: [
          { id: "1", parentId: "0", title: "Bookmarks bar", dateAdded: 0, children: barChildren },
          { id: "2", parentId: "0", title: "Other bookmarks", dateAdded: 0, children: [] },
          { id: "3", parentId: "0", title: "Mobile bookmarks", dateAdded: 0, children: [] },
        ],
      },
    ],
    tombstones: [],
  };
}

function link(title: string, url: string): SyncBookmark {
  return { id: `r-${url}`, parentId: "1", title, url, dateAdded: 1 };
}

function flatUrls(tree: SyncBookmark[]): string[] {
  const urls: string[] = [];
  const walk = (n: SyncBookmark) => { if (n.url) urls.push(n.url); n.children?.forEach(walk); };
  tree.forEach(walk);
  return urls.sort();
}

async function localUrls(): Promise<string[]> {
  const tree = await chrome.bookmarks.getTree();
  const urls: string[] = [];
  const walk = (n: chrome.bookmarks.BookmarkTreeNode) => {
    if (n.url) urls.push(n.url);
    n.children?.forEach(walk);
  };
  tree.forEach(walk);
  return urls.sort();
}

async function peerPacket(engine: SyncEngine, deviceId: string, p: BookmarkPayload): Promise<SyncPacket> {
  const packet = await priv(engine).buildPacket("bookmarks", p);
  packet.device_id = deviceId; // checksum is over the payload, so it stays valid
  return packet;
}

describe("SyncEngine.syncType — bookmarks", () => {
  it("uploads local data when there are no peers", async () => {
    const engine = makeEngine();
    const backend = new FakeBackend();
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com" });

    await priv(engine).syncType("bookmarks", backend, DEFAULT_STATE);

    expect(backend.uploads).toHaveLength(1);
    expect(backend.uploads[0].device_id).toBe("me");
    const sent = JSON.parse(backend.uploads[0].payload) as BookmarkPayload;
    expect(flatUrls(sent.tree)).toContain("https://a.com");
  });

  it("merges a peer's bookmarks into local and uploads the merged result", async () => {
    const engine = makeEngine();
    const backend = new FakeBackend();
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com" });
    backend.files.set(
      "bookmarks_peer1",
      await peerPacket(engine, "peer1", payload([link("B", "https://b.com")]))
    );

    await priv(engine).syncType("bookmarks", backend, DEFAULT_STATE);

    expect(await localUrls()).toEqual(["https://a.com", "https://b.com"]);
    const merged = JSON.parse(backend.uploads[backend.uploads.length - 1].payload) as BookmarkPayload;
    expect(flatUrls(merged.tree)).toEqual(["https://a.com", "https://b.com"]);
  });

  it("folds in multiple peers in a single cycle", async () => {
    const engine = makeEngine();
    const backend = new FakeBackend();
    backend.files.set("bookmarks_peer1", await peerPacket(engine, "peer1", payload([link("B", "https://b.com")])));
    backend.files.set("bookmarks_peer2", await peerPacket(engine, "peer2", payload([link("C", "https://c.com")])));

    await priv(engine).syncType("bookmarks", backend, DEFAULT_STATE);

    expect(await localUrls()).toEqual(["https://b.com", "https://c.com"]);
  });

  it("excludes our own file from the peer download", async () => {
    const engine = makeEngine();
    const backend = new FakeBackend();
    // A stale file under our own device id must not be folded back in.
    backend.files.set("bookmarks_me", await peerPacket(engine, "me", payload([link("Z", "https://z.com")])));

    await priv(engine).syncType("bookmarks", backend, DEFAULT_STATE);

    expect(await localUrls()).toEqual([]);
  });

  it("skips re-upload when nothing changed since the last upload", async () => {
    const engine = makeEngine();
    const backend = new FakeBackend();
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com" });

    await priv(engine).syncType("bookmarks", backend, DEFAULT_STATE);
    await priv(engine).syncType("bookmarks", backend, DEFAULT_STATE);

    // Second cycle found nothing new → no redundant commit (no 409 to race into).
    expect(backend.uploads).toHaveLength(1);
  });

  it("skips a peer whose file fails to apply (checksum mismatch) and folds in the rest", async () => {
    const engine = makeEngine();
    const backend = new FakeBackend();
    const good = await peerPacket(engine, "peer1", payload([link("B", "https://b.com")]));
    const bad = await peerPacket(engine, "peer2", payload([link("C", "https://c.com")]));
    bad.checksum = "0".repeat(64); // 64-char but wrong → checksum verification throws

    backend.files.set("bookmarks_peer1", good);
    backend.files.set("bookmarks_peer2", bad);

    // Must not throw; the good peer applies, the corrupt one is skipped.
    await priv(engine).syncType("bookmarks", backend, DEFAULT_STATE);

    expect(await localUrls()).toEqual(["https://b.com"]);
  });

  it("uploads again once the data changes", async () => {
    const engine = makeEngine();
    const backend = new FakeBackend();
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com" });
    await priv(engine).syncType("bookmarks", backend, DEFAULT_STATE);

    await chrome.bookmarks.create({ parentId: "1", title: "B", url: "https://b.com" });
    await priv(engine).syncType("bookmarks", backend, DEFAULT_STATE);

    expect(backend.uploads).toHaveLength(2);
  });
});

describe("SyncEngine.syncType — E2EE", () => {
  function encEngine(deviceId: string, passphrase: string): SyncEngine {
    return new SyncEngine(
      { ...DEFAULT_SETTINGS, device_id: deviceId, conflict_strategy: "lww",
        encryption_enabled: true, encryption_passphrase: passphrase },
      () => {}
    );
  }
  async function encPeer(passphrase: string, deviceId: string, p: BookmarkPayload): Promise<SyncPacket> {
    return priv(encEngine(deviceId, passphrase)).buildPacket("bookmarks", p);
  }

  it("round-trips a peer encrypted with the SAME passphrase and re-uploads encrypted", async () => {
    const engine = encEngine("me", "correct horse");
    const backend = new FakeBackend();
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com" });
    backend.files.set("bookmarks_peer1", await encPeer("correct horse", "peer1", payload([link("B", "https://b.com")])));

    await priv(engine).syncType("bookmarks", backend, DEFAULT_STATE);

    expect(await localUrls()).toEqual(["https://a.com", "https://b.com"]);
    const last = backend.uploads[backend.uploads.length - 1];
    expect(last.encrypted).toBe(true);
    expect(last.verifier).toBeTruthy();
  });

  it("surfaces a PassphraseError when a peer used a DIFFERENT passphrase (no silent fork)", async () => {
    const engine = encEngine("me", "my-passphrase");
    const backend = new FakeBackend();
    backend.files.set("bookmarks_peer1", await encPeer("their-different-one", "peer1", payload([link("B", "https://b.com")])));

    await expect(priv(engine).syncType("bookmarks", backend, DEFAULT_STATE)).rejects.toBeInstanceOf(PassphraseError);
  });
});

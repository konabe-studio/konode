import { describe, it, expect } from "vitest";
import { SyncEngine, statusAfterSync } from "@/lib/sync/sync-engine";
import { BADGE_TEXT, BADGE_COLORS } from "@/lib/constants";
import { createKeyVerifier } from "@/lib/crypto/encryption";
import { DEFAULT_SETTINGS, DEFAULT_STATE, getState, setState, setTombstones, acquireSyncLock, KEYS } from "@/lib/utils/storage";
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
    // Under the name a real backend writes, so a `listFiles` sees what an upload actually
    // produced — which is what the missing-own-file check reads.
    this.blobs.set(`konode_${packet.data_type}_${packet.device_id}.json`, JSON.stringify(packet));
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
  blobs = new Map<string, string>();
  putFile(name: string, content: string): Promise<void> { this.blobs.set(name, content); return Promise.resolve(); }
  getFile(name: string): Promise<string | null> { return Promise.resolve(this.blobs.get(name) ?? null); }
  listFiles(prefix: string): Promise<string[]> {
    return Promise.resolve([...this.blobs.keys()].filter((n) => n.startsWith(prefix)));
  }
  deleteFile(name: string): Promise<void> { this.blobs.delete(name); return Promise.resolve(); }
}

// Typed view of the private members we drive directly in tests.
type EnginePrivate = {
  syncType(dataType: DataType, backend: IBackend, state: SyncState): Promise<void>;
  syncAllTypes(types: DataType[], backend: IBackend, state: SyncState): Promise<string[]>;
  buildPacket(dataType: DataType, payload: unknown): Promise<SyncPacket>;
  recordBlockedDeletion(
    blocked: number,
    syncedBookmarks: boolean
  ): Promise<SyncState["recovery_notice"]>;
  encryptionWarnings: Map<string, string>;
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

function payload(
  barChildren: SyncBookmark[],
  tombstones: BookmarkPayload["tombstones"] = []
): BookmarkPayload {
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
    tombstones,
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

describe("SyncEngine.syncType — concurrent moves (C3)", () => {
  it("converges a 3-device concurrent move to the newest move's folder, no duplicate", async () => {
    const engine = makeEngine();
    const backend = new FakeBackend();
    // Local: X lives in "LocalF".
    const lf = await chrome.bookmarks.create({ parentId: "1", title: "LocalF" });
    await chrome.bookmarks.create({ parentId: lf.id, title: "X", url: "https://x.com" });

    const now = Date.now();
    const movePayload = (folderTitle: string, at: number): BookmarkPayload => ({
      tree: [{ id: "0", parentId: null, title: "", dateAdded: 0, children: [
        { id: "1", parentId: "0", title: "Bookmarks bar", dateAdded: 0, children: [
          { id: `f-${folderTitle}`, parentId: "1", title: folderTitle, dateAdded: 1, children: [link("X", "https://x.com")] },
        ] },
        { id: "2", parentId: "0", title: "Other bookmarks", dateAdded: 0, children: [] },
        { id: "3", parentId: "0", title: "Mobile bookmarks", dateAdded: 0, children: [] },
      ] }],
      tombstones: [],
      moves: [{ url: "https://x.com", at }],
    });

    // Peer B moved X to BFolder (older); peer C moved it to CFolder (newer).
    backend.files.set("bookmarks_peerB", await peerPacket(engine, "peerB", movePayload("BFolder", now - 10_000)));
    backend.files.set("bookmarks_peerC", await peerPacket(engine, "peerC", movePayload("CFolder", now - 1_000)));

    await priv(engine).syncType("bookmarks", backend, DEFAULT_STATE);

    // Newest move wins → X ends up under CFolder, exactly once.
    const bar = await chrome.bookmarks.getChildren("1");
    const cFolder = bar.find((c) => !c.url && c.title === "CFolder");
    expect(cFolder).toBeTruthy();
    const cKids = await chrome.bookmarks.getChildren(cFolder!.id);
    expect(cKids.some((c) => c.url === "https://x.com")).toBe(true);
    expect((await localUrls()).filter((u) => u === "https://x.com")).toHaveLength(1);
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
    // No verifier on uploads: encrypt(known-constant) on third-party storage is an
    // offline brute-force oracle on the passphrase. Mismatch detection relies on
    // the payload's GCM decrypt failure instead (tests below).
    expect(last.verifier).toBeUndefined();
  });

  it("skips (does not merge) a peer with a DIFFERENT passphrase and records a warning — no silent fork", async () => {
    const engine = encEngine("me", "my-passphrase");
    const backend = new FakeBackend();
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com" });
    backend.files.set("bookmarks_peer1", await encPeer("their-different-one", "peer1", payload([link("B", "https://b.com")])));

    // Non-fatal: no throw. The undecryptable peer is skipped, not merged...
    await priv(engine).syncType("bookmarks", backend, DEFAULT_STATE);
    expect(await localUrls()).toEqual(["https://a.com"]);
    // ...but the mismatch is recorded (surfaced by sync() as a visible warning)...
    expect(priv(engine).encryptionWarnings.has("peer1")).toBe(true);
    // ...and we still re-upload our own (encrypted) file, so the group can self-heal.
    const last = backend.uploads[backend.uploads.length - 1];
    expect(last.encrypted).toBe(true);
  });

  it("still checks a LEGACY peer's verifier (older builds upload one) on mismatch", async () => {
    const engine = encEngine("me", "my-passphrase");
    const backend = new FakeBackend();
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com" });
    // A peer on an older build: its packet carries the legacy verifier field.
    const legacy = await encPeer("their-different-one", "peer1", payload([link("B", "https://b.com")]));
    legacy.verifier = await createKeyVerifier("their-different-one");
    backend.files.set("bookmarks_peer1", legacy);

    await priv(engine).syncType("bookmarks", backend, DEFAULT_STATE);
    // Same non-fatal outcome as the decrypt-failure path: skipped, warned, self-heals.
    expect(await localUrls()).toEqual(["https://a.com"]);
    expect(priv(engine).encryptionWarnings.has("peer1")).toBe(true);
    expect(backend.uploads[backend.uploads.length - 1].encrypted).toBe(true);
  });

  it("SILENTLY skips a plaintext peer while E2EE is on here (stale/orphan file must not warn forever)", async () => {
    const engine = encEngine("me", "my-passphrase");
    const backend = new FakeBackend();
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com" });
    // Peer packet built by a NON-encrypting engine → encrypted:false (E2EE off there).
    backend.files.set("bookmarks_peer1", await peerPacket(makeEngine(), "peer1", payload([link("B", "https://b.com")])));

    await priv(engine).syncType("bookmarks", backend, DEFAULT_STATE);
    // The plaintext peer is neither merged...
    expect(await localUrls()).toEqual(["https://a.com"]);
    // ...NOR warned about — it's a stale/orphan file, not this device's problem.
    expect(priv(engine).encryptionWarnings.size).toBe(0);
    // We still upload our own encrypted file.
    expect(backend.uploads[backend.uploads.length - 1].encrypted).toBe(true);
  });

  it("nudges (non-fatal) to enable E2EE when E2EE is off here but a peer is encrypted", async () => {
    const engine = makeEngine(); // E2EE off, device "me"
    const backend = new FakeBackend();
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com" });
    backend.files.set("bookmarks_peer1", await encPeer("group-passphrase", "peer1", payload([link("B", "https://b.com")])));

    await priv(engine).syncType("bookmarks", backend, DEFAULT_STATE);
    // The encrypted peer can't be read here, so it's skipped (not merged)...
    expect(await localUrls()).toEqual(["https://a.com"]);
    // ...but the user is nudged on THIS device (the one that can enable E2EE)...
    expect(priv(engine).encryptionWarnings.has("peer1")).toBe(true);
    // ...and this device still uploads its own (plaintext) file — non-fatal.
    expect(backend.uploads[backend.uploads.length - 1].encrypted).toBe(false);
  });

  it("does NOT decrypt an encrypted peer when E2EE is off but a passphrase lingers (C1 downgrade)", async () => {
    // Turning E2EE off keeps the passphrase in settings; the device must still NOT
    // silently decrypt+absorb the encrypted group and re-publish it in plaintext.
    const engine = new SyncEngine(
      { ...DEFAULT_SETTINGS, device_id: "me", conflict_strategy: "lww",
        encryption_enabled: false, encryption_passphrase: "shared-pass" },
      () => {}
    );
    const backend = new FakeBackend();
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com" });
    backend.files.set("bookmarks_peer1", await encPeer("shared-pass", "peer1", payload([link("B", "https://b.com")])));

    await priv(engine).syncType("bookmarks", backend, DEFAULT_STATE);
    expect(await localUrls()).toEqual(["https://a.com"]);              // encrypted peer NOT absorbed
    expect(priv(engine).encryptionWarnings.has("peer1")).toBe(true);  // warned on this device
    expect(backend.uploads[backend.uploads.length - 1].encrypted).toBe(false); // own file stays plaintext
  });

  it("re-uploads encrypted when E2EE turns on even though the plaintext is unchanged (self-heal, Fix 1)", async () => {
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com" });
    const backend = new FakeBackend();
    // Same device uploads plaintext first (records a plain-form upload tag).
    await priv(makeEngine()).syncType("bookmarks", backend, DEFAULT_STATE);
    expect(backend.uploads[backend.uploads.length - 1].encrypted).toBe(false);
    // Now it turns E2EE on. The plaintext content is identical, but the encryption
    // FORM differs — so it must re-upload (not skip on the unchanged checksum),
    // encrypted this time. This is the root cause of the old mixed-state deadlock.
    await priv(encEngine("me", "pw")).syncType("bookmarks", backend, DEFAULT_STATE);
    expect(backend.uploads.length).toBe(2);
    expect(backend.uploads[backend.uploads.length - 1].encrypted).toBe(true);
  });
});

describe("SyncEngine — one data type's failure must not abort the others", () => {
  // A revoked optional permission (history / management) makes that type's export
  // throw. The bare per-type loop let the throw escape sync(), so every type AFTER the
  // failing one was skipped — turning off history in chrome://extensions silently
  // stopped BOOKMARKS from syncing — and the post-loop mass-delete recovery snapshot
  // never ran either.
  class FailingBackend extends FakeBackend {
    constructor(private readonly failFor: DataType[]) { super(); }
    downloadAll(dataType: DataType, exclude?: string): Promise<SyncPacket[]> {
      if (this.failFor.includes(dataType)) {
        return Promise.reject(new Error(`no ${dataType} permission`));
      }
      return super.downloadAll(dataType, exclude);
    }
  }

  it("syncs the remaining types and reports the one that failed", async () => {
    const engine = makeEngine();
    const backend = new FailingBackend(["history"]);
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com" });

    // history FIRST — a propagating throw would take bookmarks down with it, which is
    // the exact shape of the bug.
    const problems = await priv(engine).syncAllTypes(["history", "bookmarks"], backend, DEFAULT_STATE);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("history");
    expect(backend.uploads.map((u) => u.data_type)).toEqual(["bookmarks"]);
  });

  it("reports EVERY failing type, not just the first", async () => {
    const engine = makeEngine();
    const backend = new FailingBackend(["history", "extensions"]);
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com" });

    const problems = await priv(engine).syncAllTypes(
      ["history", "extensions", "bookmarks"], backend, DEFAULT_STATE
    );

    expect(problems).toHaveLength(2);
    expect(backend.uploads.map((u) => u.data_type)).toEqual(["bookmarks"]);
  });

  it("reports nothing when every type succeeds", async () => {
    const engine = makeEngine();
    const backend = new FakeBackend();
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com" });

    expect(await priv(engine).syncAllTypes(["bookmarks"], backend, DEFAULT_STATE)).toEqual([]);
  });

  it("skips a type this browser has no API for, and does NOT call it an error", async () => {
    // Firefox for Android has no bookmarks API, so `bookmarks` can never produce a byte
    // there. Reporting that once a minute would pin the extension to a red error state
    // forever over something the user cannot fix — and bury the real failures under it.
    // Settings is where this is explained, next to the toggle itself.
    const engine = makeEngine();
    const backend = new FakeBackend();
    const bookmarks = chrome.bookmarks;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (chrome as any).bookmarks;
    try {
      const problems = await priv(engine).syncAllTypes(["bookmarks", "sessions"], backend, DEFAULT_STATE);
      expect(problems).toEqual([]);
      expect(backend.uploads.map((u) => u.data_type)).not.toContain("bookmarks");
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (chrome as any).bookmarks = bookmarks;
    }
  });
});

describe("SyncEngine.syncType — a tab-less session is not published", () => {
  // Revoking the optional `tabs` permission doesn't throw: tabs.query resolves, but
  // every tab arrives without a url, so the export filters them all out. Uploading that
  // empty session OVERWRITES this device's previously-good session file for every peer.

  it("does not upload a session with no tabs", async () => {
    const engine = makeEngine();
    const backend = new FakeBackend();

    await priv(engine).syncType("sessions", backend, DEFAULT_STATE);

    expect(backend.uploads).toHaveLength(0);
  });

  it("still uploads a session that has tabs", async () => {
    const engine = makeEngine();
    const backend = new FakeBackend();
    await chrome.tabs.create({ url: "https://a.com" });

    await priv(engine).syncType("sessions", backend, DEFAULT_STATE);

    expect(backend.uploads).toHaveLength(1);
    expect(backend.uploads[0].data_type).toBe("sessions");
  });
});

describe("SyncEngine.syncType — a stale peer must not resurrect a deleted bookmark", () => {
  /** Stamp an explicit packet timestamp — that's what orders the fold. The checksum is
   *  over the payload only, so it stays valid. */
  async function agedPeer(
    engine: SyncEngine, deviceId: string, p: BookmarkPayload, ageMs: number
  ): Promise<SyncPacket> {
    const packet = await peerPacket(engine, deviceId, p);
    packet.timestamp = new Date(Date.now() - ageMs).toISOString();
    return packet;
  }

  it("does not re-add a bookmark a NEWER peer tombstoned, even from an OLDER peer's tree", async () => {
    const engine = makeEngine();
    const backend = new FakeBackend();
    // This device never held X — that's what makes it vulnerable: there is no local
    // copy for the tombstone to match against in Step A.
    const deletedAt = Date.now() - 1_000;

    // Stale peer (older file) still has X in its tree, and no tombstone.
    backend.files.set("bookmarks_stale",
      await agedPeer(engine, "stale", payload([link("X", "https://x.com")]), 60_000));
    // Fresh peer (newer file) dropped X and carries the tombstone.
    backend.files.set("bookmarks_fresh",
      await agedPeer(engine, "fresh", payload([], [{ url: "https://x.com", deletedAt }]), 0));

    await priv(engine).syncType("bookmarks", backend, DEFAULT_STATE);

    // X must NOT come back. Folded oldest-first it was created (with a fresh
    // dateAdded, which the API won't let us set to the peer's original), and that
    // fresh stamp then beat the older tombstone — so it survived AND got republished.
    expect(await localUrls()).toEqual([]);

    // And we must not advertise X to the rest of the mesh either.
    const sent = JSON.parse(backend.uploads[backend.uploads.length - 1].payload) as BookmarkPayload;
    expect(flatUrls(sent.tree)).toEqual([]);
    expect(sent.tombstones.map((t) => t.url)).toEqual(["https://x.com"]);
  });

  it("still adds a bookmark from an older peer when nobody deleted it", async () => {
    // The ordering change must not make the fold skip legitimate additions.
    const engine = makeEngine();
    const backend = new FakeBackend();

    backend.files.set("bookmarks_stale",
      await agedPeer(engine, "stale", payload([link("A", "https://a.com")]), 60_000));
    backend.files.set("bookmarks_fresh",
      await agedPeer(engine, "fresh", payload([link("B", "https://b.com")]), 0));

    await priv(engine).syncType("bookmarks", backend, DEFAULT_STATE);

    expect(await localUrls()).toEqual(["https://a.com", "https://b.com"]);
  });
});

describe("SyncEngine.syncType — a deletion-only payload still gets uploaded", () => {
  // The bookmark payload is a { tree, tombstones } envelope, and the deletion log is
  // content. Judging "empty" on the tree alone meant deleting EVERY bookmark produced
  // an "empty" payload that was never uploaded: the tombstones never left the device,
  // no peer learned of the deletion, and this device's stale remote file kept
  // advertising the whole old tree — which came back once the tombstones aged out.

  it("uploads the tombstones when every local bookmark has been deleted", async () => {
    const engine = makeEngine();
    const backend = new FakeBackend();
    // Local: no bookmarks left, but a deletion to announce.
    const future = Date.now() + 60_000;
    await setTombstones([{ url: "https://b.com", deletedAt: future }]);
    // The peer still holds the bookmark we deleted.
    backend.files.set("bookmarks_peer1", await peerPacket(engine, "peer1", payload([link("B", "https://b.com")])));

    await priv(engine).syncType("bookmarks", backend, DEFAULT_STATE);

    // The peer's copy is suppressed by our newer tombstone, so local stays empty...
    expect(await localUrls()).toEqual([]);
    // ...and the deletion must reach the backend, or it propagates to nobody.
    expect(backend.uploads).toHaveLength(1);
    const sent = JSON.parse(backend.uploads[0].payload) as BookmarkPayload;
    expect(flatUrls(sent.tree)).toEqual([]);
    expect(sent.tombstones.map((t) => t.url)).toEqual(["https://b.com"]);
  });

  it("still uploads nothing on a fresh device with no bookmarks and no deletions", async () => {
    // The guard must stay: a device with genuinely nothing to say writes no file.
    const engine = makeEngine();
    const backend = new FakeBackend();

    await priv(engine).syncType("bookmarks", backend, DEFAULT_STATE);

    expect(backend.uploads).toHaveLength(0);
  });
});

describe("SyncEngine — blocked mass-delete takes ONE restore point per incident", () => {
  // The guard re-blocks the same peer deletions on every merge, so a snapshot per
  // sync burned through the 10-slot ring in ~10 cycles and deleted the user's own
  // pre-incident restore points — the exact history they'd recover from.

  /** Counts recovery snapshots and optionally fails the first N attempts. */
  function countingEngine(failFirst = 0): { engine: SyncEngine; taken: () => number } {
    const engine = makeEngine();
    let calls = 0;
    (engine as unknown as { snapshotNow: () => Promise<unknown> }).snapshotNow = () => {
      calls++;
      if (calls <= failFirst) return Promise.reject(new Error("backend unreachable"));
      return Promise.resolve({ name: "konode_snap_bookmarks_1.json", timestamp: 1, count: 1 });
    };
    // `calls` counts attempts; for the success-count assertions failFirst is 0.
    return { engine, taken: () => calls };
  }

  it("writes ONE restore point even though the deletion is blocked every sync", async () => {
    const { engine, taken } = countingEngine();

    const first = await priv(engine).recordBlockedDeletion(50, true);
    const second = await priv(engine).recordBlockedDeletion(50, true);
    const third = await priv(engine).recordBlockedDeletion(50, true);

    expect(taken()).toBe(1);
    // ...but the banner keeps being surfaced while the situation persists.
    for (const n of [first, second, third]) expect(n?.blocked).toBe(50);
  });

  it("earns a new restore point after a clean bookmark sync ends the incident", async () => {
    const { engine, taken } = countingEngine();

    await priv(engine).recordBlockedDeletion(50, true);
    expect(taken()).toBe(1);

    // A sync that merged bookmarks and blocked nothing → incident over.
    expect(await priv(engine).recordBlockedDeletion(0, true)).toBeNull();

    // A later block is a NEW incident and deserves its own restore point.
    await priv(engine).recordBlockedDeletion(30, true);
    expect(taken()).toBe(2);
  });

  it("a sync that never merged bookmarks does NOT end the incident", async () => {
    const { engine, taken } = countingEngine();

    await priv(engine).recordBlockedDeletion(50, true);
    await priv(engine).recordBlockedDeletion(0, false); // e.g. sync(["history"])
    await priv(engine).recordBlockedDeletion(50, true);

    expect(taken()).toBe(1);
  });

  it("retries on the next sync when the restore-point write fails", async () => {
    const { engine, taken } = countingEngine(1); // first snapshotNow() rejects

    // A failed write must not throw out, and must not latch the incident closed.
    await expect(priv(engine).recordBlockedDeletion(50, true)).resolves.toMatchObject({ blocked: 50 });
    expect(taken()).toBe(1);

    // Next cycle tries again — and this time succeeds.
    await priv(engine).recordBlockedDeletion(50, true);
    expect(taken()).toBe(2);

    // Now it IS latched, so no third attempt.
    await priv(engine).recordBlockedDeletion(50, true);
    expect(taken()).toBe(2);
  });
});

describe("SyncEngine.syncType — upload dedup is per DESTINATION", () => {
  // The dedup checksum is over the payload, so it can't see a destination change.
  // Without the destination in the upload tag, pointing the device at a new provider /
  // repo / server left the old checksum matching: nothing was ever uploaded there and
  // the UI still reported a clean sync.
  function ghEngine(repo: string, path?: string): SyncEngine {
    return new SyncEngine(
      {
        ...DEFAULT_SETTINGS,
        device_id: "me",
        conflict_strategy: "lww",
        active_backend: "github",
        backends: [{ type: "github", label: "GitHub", enabled: true, github: { token: "t", repo, path } }],
      },
      () => {}
    );
  }

  it("re-uploads to a NEW repo even though the payload is unchanged", async () => {
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com" });

    const first = new FakeBackend();
    await priv(ghEngine("owner/repo-one")).syncType("bookmarks", first, DEFAULT_STATE);
    expect(first.uploads).toHaveLength(1);

    // Same device, same untouched bookmarks, different destination → must upload.
    const second = new FakeBackend();
    await priv(ghEngine("owner/repo-two")).syncType("bookmarks", second, DEFAULT_STATE);
    expect(second.uploads).toHaveLength(1);
  });

  it("re-uploads when only the subfolder path changes", async () => {
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com" });

    const first = new FakeBackend();
    await priv(ghEngine("owner/repo", "konode")).syncType("bookmarks", first, DEFAULT_STATE);
    const second = new FakeBackend();
    await priv(ghEngine("owner/repo", "backup/konode")).syncType("bookmarks", second, DEFAULT_STATE);

    expect(second.uploads).toHaveLength(1);
  });

  it("still skips the re-upload when destination and payload are both unchanged", async () => {
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com" });
    const backend = new FakeBackend();

    await priv(ghEngine("owner/repo-one")).syncType("bookmarks", backend, DEFAULT_STATE);
    await priv(ghEngine("owner/repo-one")).syncType("bookmarks", backend, DEFAULT_STATE);

    expect(backend.uploads).toHaveLength(1);
  });

  it("treats an equivalent repo URL and slug as the SAME destination", async () => {
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com" });
    const backend = new FakeBackend();

    // Re-typing the repo in URL form isn't a move — it must not force a re-upload.
    await priv(ghEngine("owner/repo-one")).syncType("bookmarks", backend, DEFAULT_STATE);
    await priv(ghEngine("https://github.com/owner/repo-one.git")).syncType("bookmarks", backend, DEFAULT_STATE);

    expect(backend.uploads).toHaveLength(1);
  });
});

describe("SyncEngine.syncType — manual conflicts (CO-7 / CO-8)", () => {
  function manualEngine(): SyncEngine {
    return new SyncEngine({ ...DEFAULT_SETTINGS, device_id: "me", conflict_strategy: "manual" }, () => {});
  }

  it("queues a conflict per diverging peer, each tagged with its device_id", async () => {
    const engine = manualEngine();
    const backend = new FakeBackend();
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com" });
    backend.files.set("bookmarks_peer1", await peerPacket(engine, "peer1", payload([link("B", "https://b.com")])));
    backend.files.set("bookmarks_peer2", await peerPacket(engine, "peer2", payload([link("C", "https://c.com")])));

    await priv(engine).syncType("bookmarks", backend, DEFAULT_STATE);

    const conflicts = (await getState()).pending_conflicts;
    expect(conflicts.map((c) => c.device_id).sort()).toEqual(["peer1", "peer2"]);
  });

  it("does not re-queue the same peer conflict on the next cycle (dedupe)", async () => {
    const engine = manualEngine();
    const backend = new FakeBackend();
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com" });
    backend.files.set("bookmarks_peer1", await peerPacket(engine, "peer1", payload([link("B", "https://b.com")])));

    await priv(engine).syncType("bookmarks", backend, DEFAULT_STATE);
    await priv(engine).syncType("bookmarks", backend, DEFAULT_STATE);

    expect((await getState()).pending_conflicts).toHaveLength(1);
  });

  it("does not re-queue a RESOLVED conflict on the next cycle (sticky resolution)", async () => {
    const engine = manualEngine();
    const backend = new FakeBackend();
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com" });
    backend.files.set("bookmarks_peer1", await peerPacket(engine, "peer1", payload([link("B", "https://b.com")])));

    // First cycle queues the conflict; the user resolves it (keep local).
    await priv(engine).syncType("bookmarks", backend, DEFAULT_STATE);
    const conflict = (await getState()).pending_conflicts[0];
    await engine.resolveConflict(conflict.id, "local");
    expect((await getState()).pending_conflicts).toHaveLength(0);

    // Peer's file is unchanged (still diverging), but we already resolved against
    // this exact content — the next cycle must NOT re-queue and re-notify.
    await priv(engine).syncType("bookmarks", backend, DEFAULT_STATE);
    expect((await getState()).pending_conflicts).toHaveLength(0);
  });

  it("re-queues if the peer's content changes after a resolution", async () => {
    const engine = manualEngine();
    const backend = new FakeBackend();
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com" });
    backend.files.set("bookmarks_peer1", await peerPacket(engine, "peer1", payload([link("B", "https://b.com")])));

    await priv(engine).syncType("bookmarks", backend, DEFAULT_STATE);
    await engine.resolveConflict((await getState()).pending_conflicts[0].id, "local");
    expect((await getState()).pending_conflicts).toHaveLength(0);

    // The peer edits its bookmarks → new checksum → a fresh conflict must surface.
    backend.files.set("bookmarks_peer1", await peerPacket(engine, "peer1", payload([link("C", "https://c.com")])));
    await priv(engine).syncType("bookmarks", backend, DEFAULT_STATE);
    expect((await getState()).pending_conflicts).toHaveLength(1);
  });

  it("still publishes its OWN file while a conflict is pending (manual gates import, not export)", async () => {
    const engine = manualEngine();
    const backend = new FakeBackend();
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com" });
    backend.files.set("bookmarks_peer1", await peerPacket(engine, "peer1", payload([link("B", "https://b.com")])));

    await priv(engine).syncType("bookmarks", backend, DEFAULT_STATE);

    // The peer is NOT merged — that's what `manual` is for...
    expect(await localUrls()).toEqual(["https://a.com"]);
    // ...and the conflict is queued for the user...
    expect((await getState()).pending_conflicts).toHaveLength(1);
    // ...but our own data still reaches the backend. Each device owns its own file, so
    // this can't overwrite the peer — and without it our changes reach nobody, ever.
    expect(backend.uploads).toHaveLength(1);
    const sent = JSON.parse(backend.uploads[0].payload) as BookmarkPayload;
    expect(flatUrls(sent.tree)).toEqual(["https://a.com"]);
  });

  it("keeps publishing later local changes once the conflict is resolved/deduped", async () => {
    const engine = manualEngine();
    const backend = new FakeBackend();
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com" });
    backend.files.set("bookmarks_peer1", await peerPacket(engine, "peer1", payload([link("B", "https://b.com")])));

    await priv(engine).syncType("bookmarks", backend, DEFAULT_STATE);
    await engine.resolveConflict((await getState()).pending_conflicts[0].id, "local");

    // No fresh conflict will be queued now (the peer is deduped by checksum), which is
    // exactly the state in which the device used to go permanently silent.
    await chrome.bookmarks.create({ parentId: "1", title: "C", url: "https://c.com" });
    await priv(engine).syncType("bookmarks", backend, DEFAULT_STATE);

    expect((await getState()).pending_conflicts).toHaveLength(0);
    const last = JSON.parse(backend.uploads[backend.uploads.length - 1].payload) as BookmarkPayload;
    expect(flatUrls(last.tree)).toEqual(["https://a.com", "https://c.com"]);
  });

  it("refuses a manual resolve-remote of a PLAINTEXT peer while E2EE is on (no silent downgrade)", async () => {
    const engine = new SyncEngine(
      { ...DEFAULT_SETTINGS, device_id: "me", conflict_strategy: "manual",
        encryption_enabled: true, encryption_passphrase: "pw" },
      () => {}
    );
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com" });
    // A plaintext peer packet (built by a non-E2EE engine → encrypted: false).
    const plainPeer = await peerPacket(makeEngine(), "peer1", payload([link("B", "https://b.com")]));
    await setState({
      pending_conflicts: [{
        id: "c1", data_type: "bookmarks", device_id: "peer1",
        local_version: null, remote_version: null, remote_packet: plainPeer,
        timestamp: new Date().toISOString(), resolved: false,
      }],
    });

    await expect(engine.resolveConflict("c1", "remote")).rejects.toThrow(/not end-to-end encrypted/);
    expect(await localUrls()).toEqual(["https://a.com"]); // nothing imported
  });
});

describe("SyncEngine.sync — reports whether it actually ran", () => {
  // sync() returned void, so SYNC_NOW answered a blanket OK even when the sync never
  // started. Combined with a lock stranded by a worker that died mid-sync, the manual
  // "Sync now" button was a no-op that reported success for up to the 2-minute TTL.
  // These paths all return before createBackend(), so they need no real backend.

  function configured(): SyncEngine {
    return new SyncEngine(
      {
        ...DEFAULT_SETTINGS,
        device_id: "me",
        active_backend: "github",
        backends: [{ type: "github", label: "GitHub", enabled: true, github: { token: "t", repo: "o/r" } }],
      },
      () => {}
    );
  }

  it("reports no-backend when nothing is configured", async () => {
    expect(await makeEngine().sync()).toBe("no-backend");
  });

  it("reports no-backend when active_backend has no matching config", async () => {
    const engine = new SyncEngine(
      { ...DEFAULT_SETTINGS, device_id: "me", active_backend: "github", backends: [] },
      () => {}
    );
    expect(await engine.sync()).toBe("no-backend");
  });

  it("reports already-running when a lock is held", async () => {
    expect(await acquireSyncLock(60_000)).toBe(true); // e.g. stranded by a dead worker
    expect(await configured().sync()).toBe("already-running");
  });

  it("reports already-running while a sync is in flight in this worker", async () => {
    const engine = configured();
    engine.isSyncing = true;
    expect(await engine.sync()).toBe("already-running");
  });

  it("leaves isSyncing false after every early return, so it can't wedge", async () => {
    const a = makeEngine();
    await a.sync();
    expect(a.isSyncing).toBe(false);

    await acquireSyncLock(60_000);
    const b = configured();
    await b.sync();
    expect(b.isSyncing).toBe(false);
  });
});

describe("SyncEngine.restoreFromSnapshot — the follow-up sync must not be detached", () => {
  // MV3 keeps the worker alive for a PENDING message response. `void this.sync(...)`
  // let restoreFromSnapshot return first, so the worker could be suspended mid-upload:
  // the user was told "restored N bookmarks" while the peers received nothing. The
  // restore itself is covered by snapshots.test.ts; this pins the ordering.
  type Seam = {
    withBackend<T>(fn: (b: IBackend) => Promise<T>): Promise<T>;
  };
  const stubRestore = (engine: SyncEngine, restored: number): void => {
    (engine as unknown as Seam).withBackend = <T>() => Promise.resolve(restored as unknown as T);
  };

  it("does not resolve until the sync has finished", async () => {
    const engine = makeEngine();
    stubRestore(engine, 3);
    let syncFinished = false;
    engine.sync = async () => {
      await new Promise((r) => setTimeout(r, 5));
      syncFinished = true;
      return "ran";
    };

    const restored = await engine.restoreFromSnapshot("konode_snap_bookmarks_1.json");

    expect(restored).toBe(3);
    expect(syncFinished).toBe(true); // detached, this was still false
  });

  it("skips the sync entirely when nothing was restored", async () => {
    const engine = makeEngine();
    stubRestore(engine, 0);
    let called = false;
    engine.sync = async () => { called = true; return "ran"; };

    expect(await engine.restoreFromSnapshot("konode_snap_bookmarks_1.json")).toBe(0);
    expect(called).toBe(false);
  });

  it("still reports the restored count when the sync couldn't run", async () => {
    // e.g. a periodic sync holds the lock. The restore stands either way.
    const engine = makeEngine();
    stubRestore(engine, 7);
    engine.sync = async () => "already-running";

    expect(await engine.restoreFromSnapshot("konode_snap_bookmarks_1.json")).toBe(7);
  });
});

describe("SyncEngine — the conflict packet is parked outside konode_state", () => {
  // konode_state is rewritten in full by every setState() (several times per sync) and
  // broadcast to the popup by every STATE_UPDATE. A pending conflict used to carry the
  // whole local tree, the whole remote tree AND the raw packet inside it.
  function manualEngine2(): SyncEngine {
    return new SyncEngine({ ...DEFAULT_SETTINGS, device_id: "me", conflict_strategy: "manual" }, () => {});
  }
  const packetStore = async (): Promise<Record<string, SyncPacket>> =>
    ((await chrome.storage.local.get(KEYS.CONFLICT_PACKETS)) as Record<string, Record<string, SyncPacket>>)[
      KEYS.CONFLICT_PACKETS
    ] ?? {};

  it("keeps the tree out of the state but stores it under the conflict id", async () => {
    const engine = manualEngine2();
    const backend = new FakeBackend();
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com" });
    backend.files.set("bookmarks_peer1", await peerPacket(engine, "peer1", payload([link("B", "https://b.com")])));

    await priv(engine).syncType("bookmarks", backend, DEFAULT_STATE);

    const conflicts = (await getState()).pending_conflicts;
    expect(conflicts).toHaveLength(1);
    // Nothing bulky in the broadcast object.
    expect(JSON.stringify(conflicts)).not.toContain("https://b.com");
    // ...but the packet is retrievable for "use remote".
    const parked = await packetStore();
    expect(Object.keys(parked)).toEqual([conflicts[0].id]);
    expect(parked[conflicts[0].id].payload).toContain("https://b.com");
  });

  it("resolves 'use remote' from the parked packet and then drops it", async () => {
    const engine = manualEngine2();
    const backend = new FakeBackend();
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com" });
    backend.files.set("bookmarks_peer1", await peerPacket(engine, "peer1", payload([link("B", "https://b.com")])));
    await priv(engine).syncType("bookmarks", backend, DEFAULT_STATE);

    const id = (await getState()).pending_conflicts[0].id;
    await engine.resolveConflict(id, "remote");

    expect(await localUrls()).toEqual(["https://a.com", "https://b.com"]); // peer applied
    expect(await packetStore()).toEqual({}); // consumed → pruned
  });

  it("prunes the parked packet on 'keep local' too", async () => {
    const engine = manualEngine2();
    const backend = new FakeBackend();
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com" });
    backend.files.set("bookmarks_peer1", await peerPacket(engine, "peer1", payload([link("B", "https://b.com")])));
    await priv(engine).syncType("bookmarks", backend, DEFAULT_STATE);

    await engine.resolveConflict((await getState()).pending_conflicts[0].id, "local");

    expect(await localUrls()).toEqual(["https://a.com"]); // peer NOT applied
    expect(await packetStore()).toEqual({});
  });

  it("still resolves a conflict queued inline by an older build", async () => {
    const engine = manualEngine2();
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com" });
    const legacyPeer = await peerPacket(makeEngine(), "peer1", payload([link("B", "https://b.com")]));
    await setState({
      pending_conflicts: [{
        id: "legacy-1", data_type: "bookmarks", device_id: "peer1",
        remote_packet: legacyPeer, // inline, the old shape — nothing is parked for it
        timestamp: new Date().toISOString(), resolved: false,
      }],
    });

    await engine.resolveConflict("legacy-1", "remote");

    expect(await localUrls()).toEqual(["https://a.com", "https://b.com"]);
  });

  it("refuses to silently drop a conflict whose data is gone", async () => {
    const engine = manualEngine2();
    await setState({
      pending_conflicts: [{
        id: "orphan-1", data_type: "bookmarks", device_id: "peer1",
        timestamp: new Date().toISOString(), resolved: false,
      }],
    });

    await expect(engine.resolveConflict("orphan-1", "remote")).rejects.toThrow(/no longer available/i);
    // Still pending — it must not look resolved when nothing was applied.
    expect((await getState()).pending_conflicts).toHaveLength(1);
  });
});

describe("statusAfterSync — a queued conflict must not read as 'Synced'", () => {
  // sync() hard-coded `problems ? "error" : "success"`, overwriting the "conflict" status
  // syncType had just set. The popup header said "Synced" and the toolbar showed nothing
  // while unresolved conflicts waited for a decision.
  it("reports conflict when one is pending and nothing else went wrong", () => {
    expect(statusAfterSync(0, 1)).toBe("conflict");
    expect(statusAfterSync(0, 3)).toBe("conflict");
  });

  it("reports success only when there is genuinely nothing to act on", () => {
    expect(statusAfterSync(0, 0)).toBe("success");
  });

  it("lets an error outrank a conflict — it may mean nothing synced at all", () => {
    expect(statusAfterSync(1, 0)).toBe("error");
    expect(statusAfterSync(2, 5)).toBe("error");
  });
});

describe("BADGE_TEXT — every status the user must act on is visible on the toolbar", () => {
  it("gives a conflict its own badge", () => {
    // This rendered as "" — no badge at all — while BADGE_COLORS.conflict went unused.
    expect(BADGE_TEXT.conflict).not.toBe("");
    expect(BADGE_TEXT.conflict).not.toBe(BADGE_TEXT.error);
  });

  it("keeps the two quiet states quiet", () => {
    expect(BADGE_TEXT.idle).toBe("");
    expect(BADGE_TEXT.success).toBe("");
  });

  it("covers every status, and every colour has matching text", () => {
    for (const status of Object.keys(BADGE_COLORS) as Array<keyof typeof BADGE_COLORS>) {
      expect(BADGE_TEXT[status]).toBeDefined();
    }
  });
});

describe("SyncEngine.finishSync — tear-down must not strand its own guards", () => {
  // The finally block used to start with `await backend.disconnect()`, so a throw from it
  // skipped everything after: isSyncing stayed on for the rest of the worker's lifetime
  // (every later sync answering "already running") and the persisted lock sat until its
  // TTL. No backend's disconnect() can throw today — this is hardening, and the previous
  // ordering only looked safe by accident.
  type Finish = { finishSync(backend: IBackend): Promise<void> };
  const finish = (e: SyncEngine): Finish => e as unknown as Finish;

  class HostileBackend extends FakeBackend {
    disconnect(): Promise<void> { return Promise.reject(new Error("socket gone")); }
  }

  it("clears isSyncing and releases the lock even when disconnect throws", async () => {
    const engine = makeEngine();
    engine.isSyncing = true;
    expect(await acquireSyncLock(60_000)).toBe(true);

    await finish(engine).finishSync(new HostileBackend());

    expect(engine.isSyncing).toBe(false);
    // Released → the next sync can start immediately instead of waiting out the TTL.
    expect(await acquireSyncLock(60_000)).toBe(true);
  });

  it("does not let the failure escape into sync()'s caller", async () => {
    const engine = makeEngine();
    await expect(finish(engine).finishSync(new HostileBackend())).resolves.toBeUndefined();
  });

  it("still disconnects normally when nothing is wrong", async () => {
    const engine = makeEngine();
    engine.isSyncing = true;
    let disconnected = false;
    class Watched extends FakeBackend {
      disconnect(): Promise<void> { disconnected = true; return Promise.resolve(); }
    }

    await finish(engine).finishSync(new Watched());

    expect(disconnected).toBe(true);
    expect(engine.isSyncing).toBe(false);
  });
});

describe("SyncEngine.syncType — manual strategy reports encryption disagreements too", () => {
  // The manual branch never calls applyRemote, and BOTH detectable encryption
  // disagreements were only checked in there. So a device on `manual` was never told it
  // had dropped out of the encrypted group, and it queued conflicts for peers whose data
  // it could not read — offering the user a choice it couldn't honour.
  const manualPlain = (): SyncEngine =>
    new SyncEngine({ ...DEFAULT_SETTINGS, device_id: "me", conflict_strategy: "manual" }, () => {});
  const manualEnc = (pass: string): SyncEngine =>
    new SyncEngine(
      { ...DEFAULT_SETTINGS, device_id: "me", conflict_strategy: "manual",
        encryption_enabled: true, encryption_passphrase: pass },
      () => {}
    );

  it("nudges when a peer is encrypted and E2EE is off here — instead of saying nothing", async () => {
    const engine = manualPlain();
    const backend = new FakeBackend();
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com" });
    const encPeer = await priv(manualEnc("group-pass")).buildPacket("bookmarks", payload([link("B", "https://b.com")]));
    encPeer.device_id = "peer1"; // buildPacket stamps OUR id; the fake would filter it as own
    backend.files.set("bookmarks_peer1", encPeer);

    await priv(engine).syncType("bookmarks", backend, DEFAULT_STATE);

    expect(priv(engine).encryptionWarnings.has("peer1")).toBe(true);
    // No conflict: the user could not have applied that version anyway.
    expect((await getState()).pending_conflicts).toHaveLength(0);
    // ...and this device still publishes its own file (the manual-export fix).
    expect(backend.uploads).toHaveLength(1);
  });

  it("SILENTLY skips a plaintext peer while E2EE is on here (a stale file must not nag)", async () => {
    const engine = manualEnc("my-pass");
    const backend = new FakeBackend();
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com" });
    backend.files.set("bookmarks_peer1", await peerPacket(makeEngine(), "peer1", payload([link("B", "https://b.com")])));

    await priv(engine).syncType("bookmarks", backend, DEFAULT_STATE);

    expect(priv(engine).encryptionWarnings.size).toBe(0); // no warning, ever
    expect((await getState()).pending_conflicts).toHaveLength(0); // no useless conflict
    expect(backend.uploads[backend.uploads.length - 1].encrypted).toBe(true);
  });

  it("still queues a normal conflict when the encryption forms agree", async () => {
    // The narrowing must not swallow the case manual exists for.
    const engine = manualEnc("shared");
    const backend = new FakeBackend();
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com" });
    const peer = await priv(manualEnc("shared")).buildPacket("bookmarks", payload([link("B", "https://b.com")]));
    peer.device_id = "peer1";
    backend.files.set("bookmarks_peer1", peer);

    await priv(engine).syncType("bookmarks", backend, DEFAULT_STATE);

    expect((await getState()).pending_conflicts.map((c) => c.device_id)).toEqual(["peer1"]);
    expect(priv(engine).encryptionWarnings.size).toBe(0);
  });
});

describe("SyncEngine.syncType — an envelope change forces one re-upload", () => {
  // The dedup checksum covers the PAYLOAD, so a new field on the envelope is invisible to
  // it. Adding device_label therefore left every existing file on the backend without one,
  // permanently, because nothing about the bookmark tree had changed — and the device list
  // read "Unnamed device" for machines that were perfectly well named. Same class as the
  // destination bug above, and fixed the same way: fold it into the tag.
  function engine(): SyncEngine {
    return new SyncEngine(
      {
        ...DEFAULT_SETTINGS,
        device_id: "me",
        device_label: "Brave WINX",
        conflict_strategy: "lww",
        active_backend: "github",
        backends: [{ type: "github", label: "GitHub", enabled: true, github: { token: "t", repo: "owner/repo" } }],
      },
      () => {}
    );
  }

  it("uploads again when the recorded tag came from an older envelope", async () => {
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com" });
    const backend = new FakeBackend();
    await priv(engine()).syncType("bookmarks", backend, DEFAULT_STATE);
    expect(backend.uploads).toHaveLength(1);

    // Rewrite the stored tag as a previous envelope version would have left it: same
    // destination, same payload checksum, different envelope.
    const r = await chrome.storage.local.get(KEYS.UPLOAD_CHECKSUMS);
    const map = r[KEYS.UPLOAD_CHECKSUMS] as Record<string, string>;
    map.bookmarks = map.bookmarks.replace(/^env\d+\|/, "env1|");
    await chrome.storage.local.set({ [KEYS.UPLOAD_CHECKSUMS]: map });

    await priv(engine()).syncType("bookmarks", backend, DEFAULT_STATE);
    expect(backend.uploads).toHaveLength(2);
  });

  it("carries the device name on the packet, so peers can name it", async () => {
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com" });
    const backend = new FakeBackend();

    await priv(engine()).syncType("bookmarks", backend, DEFAULT_STATE);

    expect(backend.uploads[0].device_label).toBe("Brave WINX");
  });
});

describe("SyncEngine — putting back our own file after it has gone from the folder", () => {
  function engine(): SyncEngine {
    return new SyncEngine(
      {
        ...DEFAULT_SETTINGS,
        device_id: "me",
        device_label: "Helium WINX",
        conflict_strategy: "lww",
        active_backend: "github",
        backends: [{ type: "github", label: "GitHub", enabled: true, github: { token: "t", repo: "owner/repo" } }],
      },
      () => {}
    );
  }

  /** How many times the log has announced a missing own file. */
  async function announcements(): Promise<number> {
    const r = await chrome.storage.local.get(KEYS.AUDIT_LOG);
    const log = (r[KEYS.AUDIT_LOG] ?? []) as Array<{ detail?: string }>;
    return log.filter((e) => /no longer on the backend/.test(e.detail ?? "")).length;
  }

  it("uploads it again, and says so once", async () => {
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com" });
    const backend = new FakeBackend();
    await priv(engine()).syncAllTypes(["bookmarks"], backend, DEFAULT_STATE);
    expect(backend.uploads).toHaveLength(1);
    expect(await announcements()).toBe(0);

    // Another device used Forget on us (or the user tidied the folder by hand).
    backend.blobs.delete("konode_bookmarks_me.json");
    backend.files.clear();
    await priv(engine()).syncAllTypes(["bookmarks"], backend, DEFAULT_STATE);
    expect(backend.uploads).toHaveLength(2); // even though the payload is unchanged
    expect(await announcements()).toBe(1);

    // And now that it is back, it stops both uploading and talking about it.
    await priv(engine()).syncAllTypes(["bookmarks"], backend, DEFAULT_STATE);
    expect(backend.uploads).toHaveLength(2);
    expect(await announcements()).toBe(1);
  });

  it("stays silent about a type whose payload is empty, however many syncs run", async () => {
    // The report: this line repeated once a minute, forever, for `sessions` only. A browser
    // whose one open tab is the extension page has no syncable session, so isPayloadEmpty
    // skips the upload — the file can never come back, so a check that clears the checksum
    // and announces the re-upload up front announces it again on every single cycle. The
    // audit log is the one place we cannot afford noise, so nothing may be said about an
    // upload that is not going to happen.
    await chrome.storage.local.set({ [KEYS.UPLOAD_CHECKSUMS]: { sessions: "env2|github:owner/repo@main/konode|plain:old" } });
    const backend = new FakeBackend(); // no konode_sessions_me.json in it, and no open tabs

    for (let i = 0; i < 3; i++) await priv(engine()).syncAllTypes(["sessions"], backend, DEFAULT_STATE);

    expect(backend.uploads).toHaveLength(0);
    expect(await announcements()).toBe(0);
  });
});

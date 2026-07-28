import { describe, it, expect } from "vitest";
import { SyncEngine } from "@/lib/sync/sync-engine";
import { createKeyVerifier } from "@/lib/crypto/encryption";
import { DEFAULT_SETTINGS, DEFAULT_STATE, getState, setState, setTombstones } from "@/lib/utils/storage";
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

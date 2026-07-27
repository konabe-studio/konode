import { describe, it, expect, beforeEach } from "vitest";
import { createSnapshot, listSnapshots, restoreSnapshot, pruneSnapshots } from "@/lib/sync/snapshots";
import { DEFAULT_SETTINGS, KEYS } from "@/lib/utils/storage";
import type { IBackend, SyncSettings } from "@/lib/types";

// A minimal in-memory backend exposing just the named-file ops snapshots use.
class FileFake {
  blobs = new Map<string, string>();
  putFile(n: string, c: string): Promise<void> { this.blobs.set(n, c); return Promise.resolve(); }
  getFile(n: string): Promise<string | null> { return Promise.resolve(this.blobs.get(n) ?? null); }
  listFiles(p: string): Promise<string[]> { return Promise.resolve([...this.blobs.keys()].filter((k) => k.startsWith(p))); }
  deleteFile(n: string): Promise<void> { this.blobs.delete(n); return Promise.resolve(); }
}
const asBackend = (f: FileFake) => f as unknown as IBackend;

async function localUrls(): Promise<string[]> {
  const tree = await chrome.bookmarks.getTree();
  const urls: string[] = [];
  const walk = (n: chrome.bookmarks.BookmarkTreeNode) => { if (n.url) urls.push(n.url); n.children?.forEach(walk); };
  tree.forEach(walk);
  return urls.sort();
}

const settings = (over: Partial<SyncSettings> = {}): SyncSettings => ({ ...DEFAULT_SETTINGS, ...over });

describe("snapshots", () => {
  beforeEach(async () => {
    // The bookmarks/storage fakes reset per test (test/setup.ts); clear the index too.
    await chrome.storage.local.set({ [KEYS.SNAPSHOTS]: [] });
  });

  it("round-trips a bookmark deleted after the snapshot", async () => {
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com/" });
    await chrome.bookmarks.create({ parentId: "1", title: "B", url: "https://b.com/" });
    await chrome.bookmarks.create({ parentId: "1", title: "C", url: "https://c.com/" });

    const backend = new FileFake();
    const meta = await createSnapshot(asBackend(backend), settings());
    expect(meta.count).toBe(3);

    // Delete B, then restore — B comes back, A/C untouched (no duplicates).
    const bar = (await chrome.bookmarks.getTree())[0].children!.find((c) => c.id === "1")!;
    const b = bar.children!.find((c) => c.url === "https://b.com/")!;
    await chrome.bookmarks.remove(b.id);
    expect(await localUrls()).toEqual(["https://a.com/", "https://c.com/"]);

    const restored = await restoreSnapshot(asBackend(backend), meta.name, settings());
    expect(restored).toBe(1);
    expect(await localUrls()).toEqual(["https://a.com/", "https://b.com/", "https://c.com/"]);
  });

  it("lists snapshots newest-first with counts", async () => {
    const backend = new FileFake();
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com/" });
    const m = await createSnapshot(asBackend(backend), settings());
    const list = await listSnapshots(asBackend(backend));
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe(m.name);
    expect(list[0].count).toBe(1);
  });

  it("encrypts the snapshot and restores with the passphrase (wrong one throws)", async () => {
    await chrome.bookmarks.create({ parentId: "1", title: "Secret", url: "https://secret.example/" });
    const backend = new FileFake();
    const s = settings({ encryption_enabled: true, encryption_passphrase: "correct horse battery" });
    const meta = await createSnapshot(asBackend(backend), s);

    // Stored blob must not contain the plaintext URL.
    expect(backend.blobs.get(meta.name)).not.toContain("secret.example");

    const bar = (await chrome.bookmarks.getTree())[0].children!.find((c) => c.id === "1")!;
    await chrome.bookmarks.remove(bar.children!.find((c) => c.url === "https://secret.example/")!.id);

    await expect(restoreSnapshot(asBackend(backend), meta.name, settings({ encryption_enabled: true, encryption_passphrase: "wrong" })))
      .rejects.toThrow();

    const restored = await restoreSnapshot(asBackend(backend), meta.name, s);
    expect(restored).toBe(1);
    expect(await localUrls()).toContain("https://secret.example/");
  });

  it("prunes to the newest 10 snapshots", async () => {
    const backend = new FileFake();
    const index = [];
    for (let i = 0; i < 12; i++) {
      const ts = 1_700_000_000_000 + i;
      const name = `konode_snap_bookmarks_${ts}.json`;
      backend.blobs.set(name, "{}");
      index.push({ name, timestamp: ts, count: i });
    }
    await chrome.storage.local.set({ [KEYS.SNAPSHOTS]: index });

    await pruneSnapshots(asBackend(backend));

    const remaining = await listSnapshots(asBackend(backend));
    expect(remaining).toHaveLength(10);
    // The two oldest (ts …000 and …001) were deleted.
    expect(remaining.map((m) => m.timestamp).sort((a, b) => a - b)[0]).toBe(1_700_000_000_002);
  });
});

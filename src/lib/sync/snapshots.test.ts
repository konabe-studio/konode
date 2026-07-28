import { describe, it, expect } from "vitest";
import { createSnapshot, listSnapshots, restoreSnapshot, pruneSnapshots, deleteSnapshot } from "@/lib/sync/snapshots";
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

const INDEX_NAME = "konode_snap_index.json";

// Wipe device-local storage while leaving the backend intact — i.e. "the same
// account seen from a second device". Every cross-device assertion below runs
// after this, because the bug it guards was exactly a local-only index.
async function otherDevice(): Promise<void> {
  // Called with no keys the fake returns the whole store; chrome's own types don't
  // model that overload, hence the cast.
  const getAll = chrome.storage.local.get as unknown as () => Promise<Record<string, unknown>>;
  for (const k of Object.keys(await getAll())) await chrome.storage.local.remove(k);
}

async function localUrls(): Promise<string[]> {
  const tree = await chrome.bookmarks.getTree();
  const urls: string[] = [];
  const walk = (n: chrome.bookmarks.BookmarkTreeNode) => { if (n.url) urls.push(n.url); n.children?.forEach(walk); };
  tree.forEach(walk);
  return urls.sort();
}

const settings = (over: Partial<SyncSettings> = {}): SyncSettings => ({ ...DEFAULT_SETTINGS, ...over });
const e2ee = (pass = "correct horse battery") =>
  settings({ encryption_enabled: true, encryption_passphrase: pass });

const seedFiles = (backend: FileFake, n: number, base = 1_700_000_000_000): string[] => {
  const names: string[] = [];
  for (let i = 0; i < n; i++) {
    const name = `konode_snap_bookmarks_${base + i}.json`;
    backend.blobs.set(name, "{}");
    names.push(name);
  }
  return names;
};

describe("snapshots — restore", () => {
  it("round-trips a bookmark deleted after the snapshot", async () => {
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com/" });
    await chrome.bookmarks.create({ parentId: "1", title: "B", url: "https://b.com/" });
    await chrome.bookmarks.create({ parentId: "1", title: "C", url: "https://c.com/" });

    const backend = new FileFake();
    const meta = await createSnapshot(asBackend(backend), settings());
    expect(meta.count).toBe(3);

    const bar = (await chrome.bookmarks.getTree())[0].children!.find((c) => c.id === "1")!;
    const b = bar.children!.find((c) => c.url === "https://b.com/")!;
    await chrome.bookmarks.remove(b.id);
    expect(await localUrls()).toEqual(["https://a.com/", "https://c.com/"]);

    const restored = await restoreSnapshot(asBackend(backend), meta.name, settings());
    expect(restored).toBe(1);
    expect(await localUrls()).toEqual(["https://a.com/", "https://b.com/", "https://c.com/"]);
  });

  // The filename is the timestamp, so back-to-back snapshots used to land on the
  // same name and the second silently replaced the first.
  it("does not overwrite a snapshot taken in the same millisecond", async () => {
    const backend = new FileFake();
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com/" });
    const first = await createSnapshot(asBackend(backend), settings());
    const second = await createSnapshot(asBackend(backend), settings());

    expect(second.name).not.toBe(first.name);
    expect(backend.blobs.has(first.name)).toBe(true);
    expect(await listSnapshots(asBackend(backend), settings())).toHaveLength(2);
  });

  it("encrypts the snapshot and restores with the passphrase (wrong one throws)", async () => {
    await chrome.bookmarks.create({ parentId: "1", title: "Secret", url: "https://secret.example/" });
    const backend = new FileFake();
    const meta = await createSnapshot(asBackend(backend), e2ee());

    expect(backend.blobs.get(meta.name)).not.toContain("secret.example");

    const bar = (await chrome.bookmarks.getTree())[0].children!.find((c) => c.id === "1")!;
    await chrome.bookmarks.remove(bar.children!.find((c) => c.url === "https://secret.example/")!.id);

    await expect(restoreSnapshot(asBackend(backend), meta.name, e2ee("wrong"))).rejects.toThrow();

    expect(await restoreSnapshot(asBackend(backend), meta.name, e2ee())).toBe(1);
    expect(await localUrls()).toContain("https://secret.example/");
  });
});

// The reported bug: the count index was device-local, so the bookmark count showed
// on the machine that took the snapshot and nowhere else.
describe("snapshots — counts across devices", () => {
  it("shows the count on a device that never took the snapshot", async () => {
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com/" });
    await chrome.bookmarks.create({ parentId: "1", title: "B", url: "https://b.com/" });
    const backend = new FileFake();
    const m = await createSnapshot(asBackend(backend), settings());

    await otherDevice();

    const list = await listSnapshots(asBackend(backend), settings());
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe(m.name);
    expect(list[0].count).toBe(2);
  });

  it("keeps both devices' counts when each takes its own snapshot", async () => {
    const backend = new FileFake();
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com/" });
    const first = await createSnapshot(asBackend(backend), settings());

    await otherDevice();
    await chrome.bookmarks.create({ parentId: "1", title: "B", url: "https://b.com/" });
    const second = await createSnapshot(asBackend(backend), settings());

    await otherDevice(); // a third device, holding nothing of its own
    const byName = new Map((await listSnapshots(asBackend(backend), settings())).map((m) => [m.name, m.count]));
    expect(byName.get(first.name)).toBe(1);  // not clobbered by the second write
    expect(byName.get(second.name)).toBe(2);
  });

  it("carries counts across devices without putting them in plaintext", async () => {
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com/" });
    const backend = new FileFake();
    const m = await createSnapshot(asBackend(backend), e2ee());

    // Neither the filename nor the index blob may spell out the count.
    expect(m.name).not.toMatch(/_1\.json$/);
    expect(backend.blobs.get(INDEX_NAME)).not.toContain("count");

    await otherDevice();
    const list = await listSnapshots(asBackend(backend), e2ee());
    expect(list[0].count).toBe(1);
  });

  it("still lists restore points when the index can't be decrypted", async () => {
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com/" });
    const backend = new FileFake();
    const m = await createSnapshot(asBackend(backend), e2ee());

    await otherDevice();
    // Passphrase not entered on this device yet: the count is unknown, but losing
    // the annotation must not hide a restore point the user can still restore.
    const list = await listSnapshots(asBackend(backend), settings({ encryption_enabled: true }));
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe(m.name);
    expect(list[0].count).toBeUndefined();
  });

  it("drops index entries whose snapshot file is gone", async () => {
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com/" });
    const backend = new FileFake();
    const m = await createSnapshot(asBackend(backend), settings());

    backend.blobs.delete(m.name); // deleted by another device
    await otherDevice();

    expect(await listSnapshots(asBackend(backend), settings())).toHaveLength(0);
  });
});

// The second bug: prune walked the device-local index, so two devices each holding
// fewer than the cap between them pruned nothing and the folder grew unbounded.
describe("snapshots — prune", () => {
  it("prunes to the newest 10 from the backend list alone, with no local index", async () => {
    const backend = new FileFake();
    seedFiles(backend, 12);

    const kept = await pruneSnapshots(asBackend(backend));

    expect(kept).toHaveLength(10);
    const remaining = await listSnapshots(asBackend(backend), settings());
    expect(remaining).toHaveLength(10);
    expect(remaining.map((m) => m.timestamp).sort((a, b) => a - b)[0]).toBe(1_700_000_000_002);
  });

  it("prunes files this device never created", async () => {
    const backend = new FileFake();
    seedFiles(backend, 11);        // all written by other devices
    await otherDevice();           // nothing local at all

    await pruneSnapshots(asBackend(backend));

    expect(await listSnapshots(asBackend(backend), settings())).toHaveLength(10);
  });

  it("keeps everything while at or under the cap", async () => {
    const backend = new FileFake();
    seedFiles(backend, 10);
    expect(await pruneSnapshots(asBackend(backend))).toHaveLength(10);
    expect(await listSnapshots(asBackend(backend), settings())).toHaveLength(10);
  });

  it("ignores files that aren't restore points", async () => {
    const backend = new FileFake();
    seedFiles(backend, 3);
    backend.blobs.set("konode_snap_bookmarks_notanumber.json", "{}");

    await pruneSnapshots(asBackend(backend));

    expect(backend.blobs.has("konode_snap_bookmarks_notanumber.json")).toBe(true);
    expect(await listSnapshots(asBackend(backend), settings())).toHaveLength(3);
  });
});

describe("snapshots — delete", () => {
  it("removes the file and its index entry, leaving the rest intact", async () => {
    const backend = new FileFake();
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com/" });
    const first = await createSnapshot(asBackend(backend), settings());
    await chrome.bookmarks.create({ parentId: "1", title: "B", url: "https://b.com/" });
    const second = await createSnapshot(asBackend(backend), settings());

    await deleteSnapshot(asBackend(backend), settings(), first.name);

    expect(backend.blobs.has(first.name)).toBe(false);
    await otherDevice();
    const list = await listSnapshots(asBackend(backend), settings());
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe(second.name);
    expect(list[0].count).toBe(2); // the survivor keeps its count
  });

  it("refuses a name that isn't a restore point", async () => {
    const backend = new FileFake();
    backend.blobs.set("konode_bookmarks_device.json", "{}");

    await expect(deleteSnapshot(asBackend(backend), settings(), "konode_bookmarks_device.json"))
      .rejects.toThrow(/Not a restore point/);
    expect(backend.blobs.has("konode_bookmarks_device.json")).toBe(true);
  });
});

describe("snapshots — legacy index migration", () => {
  it("publishes the old device-local counts instead of discarding them", async () => {
    const backend = new FileFake();
    const [a, b] = seedFiles(backend, 2);
    await chrome.storage.local.set({
      [KEYS.LEGACY_SNAPSHOTS]: [
        { name: a, timestamp: 1_700_000_000_000, count: 41 },
        { name: b, timestamp: 1_700_000_000_001, count: 61 },
      ],
    });

    const list = await listSnapshots(asBackend(backend), settings());
    expect(list.map((m) => m.count)).toEqual([61, 41]); // newest first

    // Drained: the legacy key is gone and the counts now live on the backend.
    expect((await chrome.storage.local.get(KEYS.LEGACY_SNAPSHOTS))[KEYS.LEGACY_SNAPSHOTS]).toBeUndefined();
    await otherDevice();
    expect((await listSnapshots(asBackend(backend), settings())).map((m) => m.count)).toEqual([61, 41]);
  });

  it("is a no-op when there is nothing to migrate", async () => {
    const backend = new FileFake();
    seedFiles(backend, 1);
    const list = await listSnapshots(asBackend(backend), settings());
    expect(list).toHaveLength(1);
    expect(list[0].count).toBeUndefined();
    expect(backend.blobs.has(INDEX_NAME)).toBe(false); // no pointless index write
  });
});

describe("snapshots — an unreadable shared index is never overwritten", () => {
  // The index is only an ANNOTATION: the backend file list is what says which restore
  // points exist. So a lost count is cosmetic, while overwriting an index we couldn't
  // read destroys every other device's counts — or downgrades the group's encrypted
  // index to plaintext, the very thing the sync engine's applyRemote refuses.

  it("does not decrypt or rewrite an encrypted index when E2EE is OFF here", async () => {
    const backend = new FileFake();
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com/" });
    // Device 1 has E2EE on and publishes an encrypted index.
    await createSnapshot(asBackend(backend), e2ee());
    const encrypted = backend.blobs.get(INDEX_NAME)!;
    expect(JSON.parse(encrypted).encrypted).toBe(true);

    // Device 2: E2EE turned OFF, but the passphrase still lingers in settings — which
    // is exactly what the sync engine calls a C1 downgrade.
    await otherDevice();
    const lingering = settings({ encryption_enabled: false, encryption_passphrase: "correct horse battery" });
    await createSnapshot(asBackend(backend), lingering);

    // The index must be untouched — NOT rewritten in plaintext.
    expect(backend.blobs.get(INDEX_NAME)).toBe(encrypted);
  });

  it("does not rewrite an index it cannot decrypt (wrong passphrase)", async () => {
    const backend = new FileFake();
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com/" });
    await createSnapshot(asBackend(backend), e2ee("the real passphrase"));
    const before = backend.blobs.get(INDEX_NAME)!;

    await otherDevice();
    await createSnapshot(asBackend(backend), e2ee("a different passphrase"));

    expect(backend.blobs.get(INDEX_NAME)).toBe(before);
  });

  it("does not wipe other devices' counts when the index read fails transiently", async () => {
    const backend = new FileFake();
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com/" });
    await createSnapshot(asBackend(backend), settings());
    const before = backend.blobs.get(INDEX_NAME)!;
    expect(JSON.parse(before).payload).toContain("count");

    // A 500 from the backend is NOT "there is no index".
    await otherDevice();
    const flaky = new FileFake();
    flaky.blobs = backend.blobs;
    flaky.getFile = (n: string) =>
      n === INDEX_NAME ? Promise.reject(new Error("HTTP 500")) : Promise.resolve(flaky.blobs.get(n) ?? null);

    await createSnapshot(asBackend(flaky), settings());

    expect(flaky.blobs.get(INDEX_NAME)).toBe(before);
  });

  it("keeps the legacy counts when they could not be published", async () => {
    const backend = new FileFake();
    const [name] = seedFiles(backend, 1);
    // An encrypted index this device can't read (E2EE off, passphrase lingering).
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com/" });
    await createSnapshot(asBackend(backend), e2ee());
    await otherDevice();
    await chrome.storage.local.set({ [KEYS.LEGACY_SNAPSHOTS]: [{ name, timestamp: 1, count: 42 }] });

    await listSnapshots(asBackend(backend), settings({ encryption_passphrase: "correct horse battery" }));

    // The legacy key must SURVIVE — these counts exist nowhere else, and dropping it
    // after a failed publish deleted them for good.
    expect((await chrome.storage.local.get(KEYS.LEGACY_SNAPSHOTS))[KEYS.LEGACY_SNAPSHOTS]).toBeDefined();
  });

  it("still replaces an index that is garbage for every device", async () => {
    // Unparseable is not "unreadable by me" — nothing is lost by rewriting it, and
    // otherwise a corrupt index could never self-heal.
    const backend = new FileFake();
    backend.blobs.set(INDEX_NAME, "}{ not json");
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com/" });

    const meta = await createSnapshot(asBackend(backend), settings());

    const idx = JSON.parse(backend.blobs.get(INDEX_NAME)!);
    expect(idx.encrypted).toBe(false);
    expect(JSON.parse(idx.payload).map((m: { name: string }) => m.name)).toEqual([meta.name]);
  });

  it("still lists the restore points when the index is unreadable (counts only are lost)", async () => {
    const backend = new FileFake();
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com/" });
    const meta = await createSnapshot(asBackend(backend), e2ee());

    await otherDevice();
    const list = await listSnapshots(asBackend(backend), settings()); // no passphrase here

    expect(list.map((m) => m.name)).toEqual([meta.name]);
    expect(list[0].count).toBeUndefined();
  });
});

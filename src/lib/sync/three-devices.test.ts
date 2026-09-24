import { describe, it, expect, beforeEach } from "vitest";
import { SyncEngine } from "@/lib/sync/sync-engine";
import { createSnapshot } from "@/lib/sync/snapshots";
import { exportBookmarkPayload, registerBookmarkListeners } from "@/lib/handlers/bookmarks-handler";
import { sha256 } from "@/lib/crypto/encryption";
import {
  DEFAULT_SETTINGS,
  DEFAULT_STATE,
  getBulkDeleteApproval,
  getTombstones,
  setBulkDeleteApproval,
  setLastUploadChecksum,
} from "@/lib/utils/storage";
import type {
  BookmarkPayload,
  DataType,
  IBackend,
  ListedFile,
  SnapshotMeta,
  SyncPacket,
  SyncSettings,
  SyncState,
} from "@/lib/types";

/**
 * Three devices, one folder, several cycles.
 *
 * Every other suite here is one browser: it can prove a rule in isolation, which is
 * exactly what `bookmarks-relay.test.ts` does for #31's five rules. What it cannot
 * produce is the thing those rules were written against: a GROUP, where a deletion one
 * device refuses becomes a demand it makes of every other one, comes back around, and
 * cannot be killed from any single device. That loop ran for weeks in the field while
 * the suite was green, because no test could hold three browsers at once.
 *
 * This file can. `test/setup.ts` exposes a device switch (a device is a snapshot of a
 * bookmark tree, a `chrome.storage.local` and a history), and the scenarios below are the
 * runtime QA checklist's sections U through Z, plus J2 and N, played out against one
 * shared in-memory folder.
 *
 * It does not REPLACE the manual pass. A fake folder cannot tell you that Drive lists a
 * duplicate file, that Chromium's move lands one slot short, or that a real 1.3.1 build
 * behaves the way we remember it. What it can do is fail the moment the group-level rules
 * stop holding, which until now nothing did.
 */

// ─── The shared folder ──────────────────────────────────────────────────────

/** One `Konode` folder, seen by every device. The thing the QA steps tell you to open. */
class Folder implements IBackend {
  readonly type = "webdav" as const;
  /** Per-device sync files, under the name a real backend writes. */
  packets = new Map<string, SyncPacket>();
  /** Everything in the folder as bytes, restore points included. */
  blobs = new Map<string, string>();
  /** Modification times, because "the file's timestamp moved" is a QA assertion (Y). */
  times = new Map<string, number>();
  /** Every upload in order, so a test can say a device published nothing this cycle. */
  uploads: SyncPacket[] = [];
  private clock = 1_700_000_000_000;

  isConfigured(): boolean { return true; }
  connect(): Promise<void> { return Promise.resolve(); }
  disconnect(): Promise<void> { return Promise.resolve(); }
  testConnection(): Promise<{ ok: boolean; message: string }> {
    return Promise.resolve({ ok: true, message: "" });
  }

  upload(packet: SyncPacket): Promise<void> {
    const name = `konode_${packet.data_type}_${packet.device_id}.json`;
    this.packets.set(name, packet);
    this.uploads.push(packet);
    this.write(name, JSON.stringify(packet));
    return Promise.resolve();
  }
  downloadAll(data_type: DataType, excludeDeviceId?: string): Promise<SyncPacket[]> {
    return Promise.resolve(
      [...this.packets.values()].filter(
        (p) => p.data_type === data_type && p.device_id !== excludeDeviceId
      )
    );
  }
  putFile(name: string, content: string): Promise<void> {
    this.write(name, content);
    return Promise.resolve();
  }
  getFile(name: string): Promise<string | null> {
    return Promise.resolve(this.blobs.get(name) ?? null);
  }
  listFiles(prefix: string): Promise<string[]> {
    return Promise.resolve([...this.blobs.keys()].filter((n) => n.startsWith(prefix)));
  }
  listFilesWithTimes(prefix: string): Promise<ListedFile[]> {
    return Promise.resolve(
      [...this.blobs.keys()]
        .filter((n) => n.startsWith(prefix))
        .map((name) => ({ name, modified: this.times.get(name) ?? null }))
    );
  }
  deleteFile(name: string): Promise<void> {
    this.blobs.delete(name);
    this.times.delete(name);
    this.packets.delete(name);
    return Promise.resolve();
  }

  private write(name: string, content: string): void {
    this.blobs.set(name, content);
    // A real folder's clock moves between writes; this one moves a second at a time, so
    // "did this file change" is answerable without sleeping in a test.
    this.times.set(name, (this.clock += 1000));
  }
}

let folder: Folder;

// ─── Devices ────────────────────────────────────────────────────────────────

type DeviceSnapshot = unknown;
interface Hooks {
  snapshot(): DeviceSnapshot;
  restore(snap: DeviceSnapshot): void;
  fresh(seq: number): void;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hooks = (): Hooks => (globalThis as any).__konodeDevices as Hooks;

/** What the merge hands the engine when the guard refuses a peer's deletion. */
type Blocked = {
  blocked: number;
  cap: number;
  localTotal: number;
  pct: number;
  device_id?: string;
  device_label?: string | null;
} | null;

/** The engine members a cycle drives directly. `sync()` itself wants a real backend config
 *  and the lock; for bookmarks it is `syncType` followed by `recordBlockedDeletion`. */
interface EnginePrivate {
  syncType(dataType: DataType, backend: IBackend, state: SyncState): Promise<void>;
  recordBlockedDeletion(
    blocked: Blocked,
    syncedBookmarks: boolean
  ): Promise<SyncState["recovery_notice"]>;
  bulkBlockedThisSync: Blocked;
  bulkApprovedThisSync: number;
  /** The "what this device last uploaded" record, which is also part of being a device:
   *  a build that published something else wrote a different one. */
  uploadTag(payloadChecksum: string, useE2ee: boolean): string;
}
const priv = (e: SyncEngine): EnginePrivate => e as unknown as EnginePrivate;

interface Device {
  label: string;
  id: string;
  settings: SyncSettings;
  engine: SyncEngine;
  /** This browser, while another one is running. */
  snap: DeviceSnapshot;
}

/** A browser that has never seen Konode. `seq` puts its local bookmark ids in their own
 *  range, so no assertion can pass by accident on two devices agreeing about an id. */
function newDevice(label: string, seq: number): Device {
  hooks().fresh(seq);
  const settings: SyncSettings = {
    ...DEFAULT_SETTINGS,
    device_id: `id-${label}`,
    device_label: `Device ${label}`,
    conflict_strategy: "lww",
    bulk_delete_percent: 60,
    encryption_enabled: false,
  };
  const engine = new SyncEngine(settings, () => {});
  // The real one resolves a backend from settings; here every device already has the
  // folder. Restore points are the QA steps' other observable, so they are really written.
  (engine as unknown as { snapshotNow: () => Promise<SnapshotMeta> }).snapshotNow = () =>
    createSnapshot(folder, settings);
  return { label, id: settings.device_id, settings, engine, snap: hooks().snapshot() };
}

/** Let the fire-and-forget recorders (`swallow(...)` in the listeners) land before the
 *  browser is swapped out. Otherwise a tombstone is written into the NEXT device. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Run `fn` on `d`'s browser. Never nest these: each entry restores from the snapshot. */
async function at<T>(d: Device, fn: () => Promise<T>): Promise<T> {
  hooks().restore(d.snap);
  try {
    return await fn();
  } finally {
    await settle();
    d.snap = hooks().snapshot();
  }
}

/** One bookmark sync on `d`, in the order `sync()` runs it: read-and-clear the approval,
 *  merge every peer in, publish, then record what the guard refused. Returns the card the
 *  popup would show (`recovery_notice`), or null for a quiet cycle. */
async function syncOnce(d: Device): Promise<SyncState["recovery_notice"]> {
  return at(d, async () => {
    const p = priv(d.engine);
    p.bulkBlockedThisSync = null;
    p.bulkApprovedThisSync = await getBulkDeleteApproval();
    if (p.bulkApprovedThisSync > 0) await setBulkDeleteApproval(0);
    await p.syncType("bookmarks", folder, DEFAULT_STATE);
    return p.recordBlockedDeletion(p.bulkBlockedThisSync, true);
  });
}

/** A cycle of the group, in the order given. */
async function cycle(...devices: Device[]): Promise<Array<SyncState["recovery_notice"]>> {
  const out: Array<SyncState["recovery_notice"]> = [];
  for (const d of devices) out.push(await syncOnce(d));
  return out;
}

// ─── What the user does in front of a browser ───────────────────────────────

interface Fire {
  created?: (id: string, node: chrome.bookmarks.BookmarkTreeNode) => void;
  changed?: (id: string, info: chrome.bookmarks.BookmarkChangeInfo) => void;
  moved?: (id: string, info: chrome.bookmarks.BookmarkMoveInfo) => void;
  removed?: (id: string, info: chrome.bookmarks.BookmarkRemoveInfo) => void;
}
const fire: Fire = {};

/** Wire the extension's own listeners to callbacks the test can fire, the way the browser
 *  would. Registered once; each call writes into whichever device is loaded. */
function captureListeners(): void {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  (chrome.bookmarks.onCreated as any).addListener = (cb: never) => { fire.created = cb; };
  (chrome.bookmarks.onChanged as any).addListener = (cb: never) => { fire.changed = cb; };
  (chrome.bookmarks.onMoved as any).addListener = (cb: never) => { fire.moved = cb; };
  (chrome.bookmarks.onRemoved as any).addListener = (cb: never) => { fire.removed = cb; };
  /* eslint-enable @typescript-eslint/no-explicit-any */
  registerBookmarkListeners(() => {});
}

async function walk(): Promise<chrome.bookmarks.BookmarkTreeNode[]> {
  const out: chrome.bookmarks.BookmarkTreeNode[] = [];
  const visit = (n: chrome.bookmarks.BookmarkTreeNode): void => {
    out.push(n);
    n.children?.forEach(visit);
  };
  (await chrome.bookmarks.getTree()).forEach(visit);
  return out;
}
/** Every bookmark URL on this browser, sorted. */
async function urlsHere(): Promise<string[]> {
  return (await walk()).filter((n) => n.url).map((n) => n.url as string).sort();
}
async function nodeFor(url: string): Promise<chrome.bookmarks.BookmarkTreeNode> {
  const n = (await walk()).find((x) => x.url === url);
  if (!n) throw new Error(`no bookmark for ${url} on this device`);
  return n;
}
async function folderFor(title: string): Promise<chrome.bookmarks.BookmarkTreeNode> {
  const n = (await walk()).find((x) => !x.url && x.title === title);
  if (!n) throw new Error(`no folder named ${title} on this device`);
  return n;
}

async function add(title: string, url: string, parentId = "1"): Promise<void> {
  const node = await chrome.bookmarks.create({ parentId, title, url });
  fire.created?.(node.id, node);
  await settle();
}
async function addFolder(title: string, parentId = "1"): Promise<string> {
  const node = await chrome.bookmarks.create({ parentId, title });
  fire.created?.(node.id, node);
  await settle();
  return node.id;
}
async function del(url: string): Promise<void> {
  const node = await nodeFor(url);
  await chrome.bookmarks.remove(node.id);
  fire.removed?.(node.id, { parentId: node.parentId as string, index: node.index ?? 0, node });
  await settle();
}
/** A folder deleted the way Chromium reports it: one event, for the folder, carrying the
 *  whole subtree (`recurse=true` in chrome/browser/extensions/api/bookmarks/bookmarks_api.cc). */
async function delFolder(title: string): Promise<void> {
  const f = await folderFor(title);
  const [subtree] = await chrome.bookmarks.getSubTree(f.id);
  await chrome.bookmarks.removeTree(f.id);
  fire.removed?.(f.id, { parentId: f.parentId as string, index: f.index ?? 0, node: subtree });
  await settle();
}
/** The same deletion the way Firefox reports it: one event, for the folder ALONE. Nothing
 *  for what was inside it (every `isDescendantRemoval` is skipped) and no `children` on the
 *  node it does send (browser/components/extensions/parent/ext-bookmarks.js). */
async function delFolderLikeFirefox(title: string): Promise<void> {
  const f = await folderFor(title);
  await chrome.bookmarks.removeTree(f.id);
  const node = { id: f.id, parentId: f.parentId, index: f.index, title: f.title, type: "folder" };
  fire.removed?.(f.id, {
    parentId: f.parentId as string,
    index: f.index ?? 0,
    node: node as chrome.bookmarks.BookmarkTreeNode,
  });
  await settle();
}
async function renameBookmark(url: string, title: string): Promise<void> {
  const node = await nodeFor(url);
  await chrome.bookmarks.update(node.id, { title });
  fire.changed?.(node.id, { title });
  await settle();
}
async function renameFolder(from: string, to: string): Promise<void> {
  const f = await folderFor(from);
  await chrome.bookmarks.update(f.id, { title: to });
  fire.changed?.(f.id, { title: to });
  await settle();
}
async function moveInto(url: string, folderId: string): Promise<void> {
  const node = await nodeFor(url);
  const oldParentId = node.parentId as string;
  const oldIndex = node.index ?? 0;
  const moved = await chrome.bookmarks.move(node.id, { parentId: folderId });
  fire.moved?.(node.id, { parentId: folderId, index: moved.index ?? 0, oldParentId, oldIndex });
  await settle();
}

// ─── Reading the folder, the way the QA steps read it ───────────────────────

const fileOf = (d: Device): string => `konode_bookmarks_${d.id}.json`;

/** `konode_bookmarks_<device>.json`, parsed. The decisive observable in U, V and Y, and
 *  the reason those steps insist on E2EE being off. */
function filed(d: Device): BookmarkPayload {
  const packet = folder.packets.get(fileOf(d));
  if (!packet) throw new Error(`${d.label} has no file in the folder`);
  return JSON.parse(packet.payload as string) as BookmarkPayload;
}
function filedUrls(d: Device): string[] {
  const urls: string[] = [];
  const visit = (n: { url?: string; children?: unknown[] }): void => {
    if (n.url) urls.push(n.url);
    (n.children as Array<{ url?: string; children?: unknown[] }> | undefined)?.forEach(visit);
  };
  filed(d).tree.forEach((n) => visit(n));
  return urls.sort();
}
const filedTombstones = (d: Device): string[] => filed(d).tombstones.map((t) => t.url).sort();
const restorePoints = (): string[] =>
  [...folder.blobs.keys()].filter((n) => n.startsWith("konode_snap_bookmarks_"));

/** Publish `payload` as `d`'s file without going through the 1.3.2 export, which is how a device
 *  on an older build fills the same slot in the folder.
 *
 *  It also records the upload the way the engine does. A device skips an upload whose
 *  payload is unchanged since its last one, so the old build's record has to be the old
 *  build's payload: leave the 1.3.2 record in place and the updated device sees nothing to
 *  publish, which is a fake's artefact and not what an update does. Must run inside
 *  `at(d, ...)`, because it writes to that device's storage. */
async function publishAsOldBuild(d: Device, payload: BookmarkPayload): Promise<void> {
  const body = JSON.stringify(payload);
  await setLastUploadChecksum("bookmarks", priv(d.engine).uploadTag(await sha256(body), false));
  await folder.upload({
    version: "1.0",
    device_id: d.id,
    device_label: d.settings.device_label,
    timestamp: new Date().toISOString(),
    data_type: "bookmarks",
    checksum: await sha256(body),
    encrypted: false,
    payload: body,
  });
}

const site = (i: number): string => `https://site${i}.example/`;
const sites = (from: number, to: number): string[] =>
  Array.from({ length: to - from }, (_, i) => site(from + i)).sort();

/** Three devices holding the same `count` bookmarks, converged, Last Write Wins. */
async function seedGroup(count: number): Promise<[Device, Device, Device]> {
  const A = newDevice("A", 1000);
  const B = newDevice("B", 2000);
  const C = newDevice("C", 3000);
  await at(A, async () => {
    for (let i = 0; i < count; i++) await add(`B${i}`, site(i));
  });
  await cycle(A, B, C, A);
  for (const d of [A, B, C]) {
    await at(d, async () => {
      expect(await urlsHere(), `${d.label} did not converge on the seed`).toHaveLength(count);
    });
  }
  return [A, B, C];
}

beforeEach(() => {
  folder = new Folder();
  captureListeners();
});

// ─── U. A refused deletion is not passed on ─────────────────────────────────

describe("U. a refused deletion is not passed on", () => {
  it("leaves the 40 in A's file alone and in nobody else's", async () => {
    const [A, B, C] = await seedGroup(50);
    await at(A, async () => { for (let i = 0; i < 40; i++) await del(site(i)); });

    const [, blockedOnB, blockedOnC] = await cycle(A, B, C);

    // One warning each, naming A, with the arithmetic the QA step spells out: 40 refused
    // out of 50, against a cap of max(20, floor(50 * 60 / 100)) = 30.
    for (const notice of [blockedOnB, blockedOnC]) {
      expect(notice).toMatchObject({ blocked: 40, local_total: 50, cap: 30, device_label: "Device A" });
    }
    // One restore point each, and nothing was removed.
    expect(restorePoints()).toHaveLength(2);
    for (const d of [B, C]) {
      await at(d, async () => { expect(await urlsHere()).toHaveLength(50); });
    }

    // THE check this release is about. Only A asks for the 40.
    expect(filedTombstones(A)).toEqual(sites(0, 40));
    expect(filedTombstones(B)).toEqual([]);
    expect(filedTombstones(C)).toEqual([]);
  });

  it("holds B's own log and publishes none of it", async () => {
    const [A, B] = await seedGroup(50);
    await at(A, async () => { for (let i = 0; i < 40; i++) await del(site(i)); });
    await cycle(A, B);

    await at(B, async () => {
      // Absorbed, because that is what stops a stale peer handing them back...
      expect(await getTombstones()).toHaveLength(40);
      // ...and stamped as someone else's, so B never asks anyone for them. Before 1.3.2
      // this export was all 40, for bookmarks B still had and never deleted.
      expect((await exportBookmarkPayload()).tombstones).toEqual([]);
    });
  });

  it("does not drift over ten more minutes of cycles", async () => {
    const [A, B, C] = await seedGroup(50);
    await at(A, async () => { for (let i = 0; i < 40; i++) await del(site(i)); });
    await cycle(A, B, C);

    // Ten cycles is the checklist's ten minutes at the default interval. A count that
    // grows or a name that rotates IS the loop.
    for (let i = 0; i < 10; i++) {
      const [, onB, onC] = await cycle(A, B, C);
      for (const notice of [onB, onC]) {
        expect(notice).toMatchObject({ blocked: 40, device_label: "Device A" });
      }
    }
    // Still one incident per device: the latch means one restore point, not one a minute.
    expect(restorePoints()).toHaveLength(2);
    expect(filedTombstones(B)).toEqual([]);
    expect(filedTombstones(C)).toEqual([]);
    for (const d of [B, C]) {
      await at(d, async () => { expect(await urlsHere()).toHaveLength(50); });
    }
  });
});

// ─── V. A device still on 1.3.1 cannot drag the updated ones in ─────────────

describe("V. a device still on 1.3.1 cannot drag the updated ones in", () => {
  /** C refuses A's deletion and then republishes all 40 as its own, while its own tree
   *  still lists every one of them. That is the self-contradicting packet every
   *  pre-1.3.2 device in the wild is sending. */
  async function cOnTheOldBuild(C: Device): Promise<void> {
    await at(C, async () => {
      const mine = await exportBookmarkPayload();
      // The pre-1.3.2 export: the whole local log, provenance and all, published as C's.
      const everything = (await getTombstones()).map(({ url, deletedAt }) => ({ url, deletedAt }));
      await publishAsOldBuild(C, { tree: mine.tree, tombstones: everything });
    });
  }

  it("B ignores the packet that argues with itself", async () => {
    const [A, B, C] = await seedGroup(50);
    await at(A, async () => { for (let i = 0; i < 40; i++) await del(site(i)); });
    await cycle(A, B, C);
    await cOnTheOldBuild(C);

    // What C is now publishing: 40 tombstones for URLs the same file's tree still carries.
    expect(filedTombstones(C)).toEqual(sites(0, 40));
    expect(filedUrls(C)).toHaveLength(50);

    const [onB] = await cycle(B);
    // A only, never C, and the count is 40 rather than 80. Step A refuses C's half
    // because C's own tree contradicts it.
    expect(onB).toMatchObject({ blocked: 40, device_label: "Device A" });
    expect(filedTombstones(B)).toEqual([]);
    await at(B, async () => { expect(await urlsHere()).toHaveLength(50); });
  });

  it("B goes quiet once A's deletion is resolved, while C is still publishing the demand", async () => {
    const [A, B, C] = await seedGroup(50);
    await at(A, async () => { for (let i = 0; i < 40; i++) await del(site(i)); });
    await cycle(A, B, C);
    await cOnTheOldBuild(C);

    // Resolve it the way the popup does: the user presses Apply on B.
    await at(B, async () => { await setBulkDeleteApproval(40); });
    const [applied] = await cycle(B);
    expect(applied).toBeNull();
    await at(B, async () => { expect(await urlsHere()).toHaveLength(10); });

    // C has not moved: its file still demands the same 40. B must stay quiet anyway.
    // This is the outcome #16 promised and the step to be most sure about.
    expect(filedTombstones(C)).toEqual(sites(0, 40));
    for (let i = 0; i < 3; i++) {
      const [quiet] = await cycle(B);
      expect(quiet).toBeNull();
    }
    await at(B, async () => { expect(await urlsHere()).toHaveLength(10); });
  });

  it("C's first upload after the update drops all 40", async () => {
    const [A, B, C] = await seedGroup(50);
    await at(A, async () => { for (let i = 0; i < 40; i++) await del(site(i)); });
    await cycle(A, B, C);
    await cOnTheOldBuild(C);
    expect(filedTombstones(C)).toHaveLength(40);

    // C updates: the same device, now exporting through 1.3.2. Its tree still holds the
    // 40 (the guard is still refusing them), so its export publishes none of them, which
    // is what takes an already-poisoned log out of circulation.
    await cycle(C);
    expect(filedTombstones(C)).toEqual([]);
    expect(filedUrls(C)).toHaveLength(50);
  });
});

// ─── W. An ordinary deletion still travels ──────────────────────────────────

describe("W. an ordinary deletion still travels", () => {
  it("carries one deletion, then five in the other direction", async () => {
    const [A, B, C] = await seedGroup(50);

    await at(A, async () => { await del(site(0)); });
    await cycle(A, B, C);
    for (const d of [B, C]) {
      await at(d, async () => { expect(await urlsHere()).toHaveLength(49); });
    }

    await at(B, async () => { for (let i = 1; i < 6; i++) await del(site(i)); });
    await cycle(B, A, C);
    for (const d of [A, C]) {
      await at(d, async () => { expect(await urlsHere()).toHaveLength(44); });
    }
  });

  it("carries a bulk cleanup right up to the cap, with no warning anywhere", async () => {
    const [A, B, C] = await seedGroup(50);
    // 25 of 50 against a cap of 30: under it, so it propagates like any other deletion.
    await at(A, async () => { for (let i = 0; i < 25; i++) await del(site(i)); });

    const notices = await cycle(A, B, C);
    expect(notices.every((n) => n === null)).toBe(true);
    expect(restorePoints()).toEqual([]);
    for (const d of [B, C]) {
      await at(d, async () => { expect(await urlsHere()).toEqual(sites(25, 50)); });
    }
  });

  it("still carries a rename and a move end to end", async () => {
    const [A, B] = await seedGroup(5);
    await at(A, async () => {
      const id = await addFolder("Work");
      await moveInto(site(0), id);
      await renameBookmark(site(1), "Renamed here");
      await renameFolder("Work", "Work stuff");
    });
    await cycle(A, B);

    await at(B, async () => {
      const folderHere = await folderFor("Work stuff");
      const moved = await nodeFor(site(0));
      expect(moved.parentId).toBe(folderHere.id);
      expect((await nodeFor(site(1))).title).toBe("Renamed here");
      expect(await urlsHere()).toHaveLength(5);
    });
  });
});

// ─── X. A deletion reaches a device that was away ───────────────────────────

describe("X. a deletion reaches a device that was away", () => {
  it("reaches C from A's file directly, with B publishing nothing about it", async () => {
    const [A, B, C] = await seedGroup(50);

    // C is closed. A deletes 5 and B applies them.
    await at(A, async () => { for (let i = 0; i < 5; i++) await del(site(i)); });
    await cycle(A, B);
    await at(B, async () => { expect(await urlsHere()).toHaveLength(45); });
    expect(filedTombstones(B)).toEqual([]);

    // C comes back, reading every peer's file as it always does.
    await cycle(C);
    await at(C, async () => { expect(await urlsHere()).toEqual(sites(5, 50)); });
    expect(filedTombstones(A)).toEqual(sites(0, 5));
  });

  it("does not let the copies C held while it was away come back", async () => {
    const [A, B, C] = await seedGroup(50);
    await at(A, async () => { for (let i = 0; i < 5; i++) await del(site(i)); });
    await cycle(A, B);

    // C's file is still the stale one: it advertises all 50, including the 5 just
    // deleted. A and B keep A's log locally, which is the only thing standing between
    // that file and a resurrection, and the reason the fold exists at all.
    expect(filedUrls(C)).toHaveLength(50);
    await cycle(A, B, A, B);
    for (const d of [A, B]) {
      await at(d, async () => { expect(await urlsHere()).toEqual(sites(5, 50)); });
    }
  });
});

// ─── Y. A device retracts its own file ──────────────────────────────────────

describe("Y. a device whose last bookmark a peer deleted retracts its own file", () => {
  it("uploads the empty tree even though it has no deletions of its own to publish", async () => {
    // Five bookmarks each: under the floor of 20, so nothing can be blocked.
    const [A, B, C] = await seedGroup(5);
    const before = folder.times.get(fileOf(A));

    await at(B, async () => { for (let i = 0; i < 5; i++) await del(site(i)); });
    await cycle(B, A, C);

    for (const d of [A, C]) {
      await at(d, async () => { expect(await urlsHere()).toEqual([]); });
    }
    // A's file: an empty tree, no tombstones of its own, and a timestamp that moved. An
    // unchanged timestamp with the 5 still listed is the bug this step exists for. The
    // upload is the retraction of A's own file, and `isPayloadEmpty` has to ask the log A
    // HOLDS rather than the payload it is about to publish.
    expect(filedUrls(A)).toEqual([]);
    expect(filedTombstones(A)).toEqual([]);
    expect(folder.times.get(fileOf(A))).toBeGreaterThan(before as number);
  });

  it("hands the five back to nobody, five cycles later", async () => {
    const [A, B, C] = await seedGroup(5);
    await at(B, async () => { for (let i = 0; i < 5; i++) await del(site(i)); });
    await cycle(B, A, C);

    for (let i = 0; i < 5; i++) await cycle(A, B, C);
    for (const d of [A, B, C]) {
      await at(d, async () => { expect(await urlsHere()).toEqual([]); });
    }
  });
});

// ─── Z / J2. The guard and the approval path ────────────────────────────────

describe("Z. the guard and the approval path are unchanged", () => {
  it("blocks 40 against a cap of 30, names A, and applies them when the user says so", async () => {
    const [A, B] = await seedGroup(50);
    await at(A, async () => { for (let i = 0; i < 40; i++) await del(site(i)); });

    const [, card] = await cycle(A, B);
    // If the card never appears at all, the contradiction rule is over-matching and a
    // genuine mass deletion is being swallowed, which is worse than the bug it fixed.
    expect(card).toMatchObject({ blocked: 40, local_total: 50, cap: 30, device_label: "Device A" });
    expect(restorePoints()).toHaveLength(1);

    await at(B, async () => { await setBulkDeleteApproval(40); });
    const [applied] = await cycle(B);
    expect(applied).toBeNull();
    await at(B, async () => { expect(await urlsHere()).toEqual(sites(40, 50)); });
  });

  it("takes the emptied folders with the deletion it approves (#26)", async () => {
    // 1.3.1 left a bar of empty shells behind on exactly this path, which was the release's
    // headline button. 1.4.0 prunes them, and the approval is what authorises it.
    const [A, B] = await seedGroup(0);
    await at(A, async () => {
      const id = await addFolder("Reading");
      for (let i = 0; i < 40; i++) await add(`B${i}`, site(i), id);
    });
    await cycle(A, B);
    await at(B, async () => { expect(await urlsHere()).toHaveLength(40); });

    await at(A, async () => { await delFolder("Reading"); });
    const [, card] = await cycle(A, B);
    expect(card).toMatchObject({ blocked: 40, device_label: "Device A" });

    await at(B, async () => { await setBulkDeleteApproval(40); });
    await cycle(B);
    await at(B, async () => {
      expect(await urlsHere()).toEqual([]);
      await expect(folderFor("Reading")).rejects.toThrow();
    });
  });
});

describe("J2. the approval is one-shot", () => {
  it("does not wave through a larger deletion that arrived after the user decided", async () => {
    const [A, B] = await seedGroup(50);
    await at(A, async () => { for (let i = 0; i < 40; i++) await del(site(i)); });
    const [, card] = await cycle(A, B);
    expect(card).toMatchObject({ blocked: 40 });

    // The user approves the 40 they were shown. Before B's next sync, A deletes 8 more.
    await at(B, async () => { await setBulkDeleteApproval(40); });
    await at(A, async () => { for (let i = 40; i < 48; i++) await del(site(i)); });
    await cycle(A);

    const [held] = await cycle(B);
    // 48 is not the deletion anyone approved, so it is held back rather than applied.
    expect(held).toMatchObject({ blocked: 48, device_label: "Device A" });
    await at(B, async () => { expect(await urlsHere()).toHaveLength(50); });
    // Not asserted here: that the approval was spent by the sync that read it. The
    // read-and-clear belongs to `sync()`, which this harness imitates rather than calls, so
    // an assertion about it here would only be testing the harness. sync-engine.test.ts
    // covers the real one, including the cycle that never reaches a bookmark merge.
  });

  it("re-blocks the same incident on the next cycle, with one restore point for it", async () => {
    const [A, B] = await seedGroup(50);
    await at(A, async () => { for (let i = 0; i < 40; i++) await del(site(i)); });
    await cycle(A, B);
    expect(restorePoints()).toHaveLength(1);

    // An approval that is armed and then never reaches an over-cap merge is still spent:
    // arming it for a number the deletion exceeds is the same thing from the merge's side.
    await at(B, async () => { await setBulkDeleteApproval(10); });
    const [stillBlocked] = await cycle(B);
    expect(stillBlocked).toMatchObject({ blocked: 40 });
    await at(B, async () => { expect(await urlsHere()).toHaveLength(50); });
    // The incident is already on the record, so the latch holds the second restore point.
    expect(restorePoints()).toHaveLength(1);
  });
});

// ─── AA on Firefox. A removed folder arrives without its contents ────────────

describe("AA on Firefox: a deleted folder arrives as the folder alone", () => {
  /** Ten bookmarks in `Reading`, five loose on the bar, on both devices. */
  async function readingOnBoth(): Promise<[Device, Device]> {
    const [A, B] = await seedGroup(0);
    await at(A, async () => {
      const id = await addFolder("Reading");
      for (let i = 0; i < 10; i++) await add(`R${i}`, site(i), id);
      for (let i = 10; i < 15; i++) await add(`B${i}`, site(i));
    });
    await cycle(A, B);
    await at(B, async () => { expect(await urlsHere()).toHaveLength(15); });
    return [A, B];
  }

  it("keeps the folder deleted on the device that deleted it", async () => {
    const [A, B] = await readingOnBoth();
    await at(B, async () => { await delFolderLikeFirefox("Reading"); });

    // B's own next sync reads A's file, which still lists all ten. Without a deletion on
    // record for them, the merge put them straight back, folder and all: the report was
    // "I delete Reading on B and after a sync it is back", with `Merged +10` in B's log.
    await cycle(B);
    await at(B, async () => {
      expect(await urlsHere()).toEqual(sites(10, 15));
      await expect(folderFor("Reading")).rejects.toThrow();
    });
    expect(filedTombstones(B)).toEqual(sites(0, 10));
    void A;
  });

  it("takes the bookmarks and the folder from the other device too", async () => {
    const [A, B] = await readingOnBoth();
    await at(B, async () => { await delFolderLikeFirefox("Reading"); });

    await cycle(B, A);
    await at(A, async () => {
      expect(await urlsHere()).toEqual(sites(10, 15));
      await expect(folderFor("Reading")).rejects.toThrow();
    });
  });

  it("takes a subfolder's bookmarks with it", async () => {
    const [A, B] = await seedGroup(0);
    await at(A, async () => {
      const work = await addFolder("Work");
      for (let i = 0; i < 4; i++) await add(`W${i}`, site(i), work);
      const archive = await addFolder("Archive", work);
      for (let i = 4; i < 8; i++) await add(`A${i}`, site(i), archive);
    });
    await cycle(A, B);

    await at(B, async () => { await delFolderLikeFirefox("Work"); });
    await cycle(B, A);
    for (const d of [A, B]) {
      await at(d, async () => {
        expect(await urlsHere()).toEqual([]);
        await expect(folderFor("Work")).rejects.toThrow();
        await expect(folderFor("Archive")).rejects.toThrow();
      });
    }
  });
});

// ─── AA. A folder that was already empty when the other device deleted it ────

describe("AA: a folder the other device deleted after emptying it", () => {
  it("goes here too, though no merge empties it any more", async () => {
    const [A, B] = await seedGroup(0);
    await at(A, async () => {
      const work = await addFolder("Work");
      await add("W0", site(0), work);
      await add("W1", site(1), work);
    });
    await cycle(A, B);

    // First the bookmarks, keeping the folder: A keeps it too, empty, as AA's second step
    // says it must, because emptying a folder is not deleting it.
    await at(B, async () => { await del(site(0)); await del(site(1)); });
    await cycle(B, A);
    await at(A, async () => { expect((await folderFor("Work")).id).toBeTruthy(); });

    // Then the folder itself, the way the report did it: on Firefox, with nothing in it.
    // No merge will ever empty A's copy again, so a rule that only prunes what the merge
    // emptied left it standing on A for good while B had none.
    await at(B, async () => { await delFolderLikeFirefox("Work"); });
    await cycle(B, A);
    await at(A, async () => { await expect(folderFor("Work")).rejects.toThrow(); });
  });

  it("leaves a folder alone once something has been put back in it", async () => {
    const [A, B] = await seedGroup(0);
    await at(A, async () => { await add("W0", site(0), await addFolder("Work")); });
    await cycle(A, B);
    await at(B, async () => { await del(site(0)); });
    await cycle(B, A); // A keeps Work, empty, and remembers that a merge emptied it

    // A puts something in it before B's deletion of the folder arrives.
    await at(A, async () => { await add("Mine", site(9), (await folderFor("Work")).id); });
    await at(B, async () => { await delFolderLikeFirefox("Work"); });
    await cycle(B, A);
    await at(A, async () => {
      const kids = await chrome.bookmarks.getChildren((await folderFor("Work")).id);
      expect(kids.map((n) => n.url)).toEqual([site(9)]);
    });

    // Emptied again by the user, it is theirs: B's older record does not reach it.
    await at(A, async () => { await del(site(9)); });
    await cycle(A);
    await at(A, async () => { expect((await folderFor("Work")).id).toBeTruthy(); });
  });

  it("does not let an approved deletion take a folder an earlier merge emptied", async () => {
    const [A, B] = await seedGroup(0);
    await at(A, async () => {
      await add("K0", site(50), await addFolder("Keep"));
      const old = await addFolder("Old");
      for (let i = 0; i < 30; i++) await add(`O${i}`, site(i), old);
      for (let i = 30; i < 40; i++) await add(`L${i}`, site(i));
    });
    await cycle(A, B);

    // B empties Keep and keeps it. A keeps its copy too, and remembers a merge emptied it.
    await at(B, async () => { await del(site(50)); });
    await cycle(B, A);

    // Then an unrelated deletion: Old, 30 of 40 against a cap of max(20, floor(40 * 60 /
    // 100)) = 24, so it is blocked on A until the user approves it.
    await at(B, async () => { await delFolder("Old"); });
    const [, card] = await cycle(B, A);
    expect(card).toMatchObject({ blocked: 30, device_label: "Device B" });

    await at(A, async () => { await setBulkDeleteApproval(30); });
    await cycle(A);
    await at(A, async () => {
      await expect(folderFor("Old")).rejects.toThrow();
      // The approval covers the deletion the user was shown. Keep was emptied cycles ago and
      // nobody has deleted it, so it is not part of what they said yes to.
      expect((await folderFor("Keep")).id).toBeTruthy();
      expect(await urlsHere()).toEqual(sites(30, 40));
    });
  });
});

// ─── N. Leaving Manual with cards still on screen ───────────────────────────

describe("N. leaving Manual", () => {
  it("converges the bookmarks as Last Write Wins would have, once the strategy changes", async () => {
    const [A, B] = await seedGroup(5);
    await at(B, async () => {
      await B.engine.updateSettings({ ...B.settings, conflict_strategy: "manual" });
      B.settings = { ...B.settings, conflict_strategy: "manual" };
    });

    await at(A, async () => { await add("Only on A", "https://only-on-a.example/"); });
    await cycle(A, B);
    // Manual queues the question instead of answering it: B has not taken A's bookmark.
    await at(B, async () => { expect(await urlsHere()).toHaveLength(5); });

    await at(B, async () => {
      await B.engine.updateSettings({ ...B.settings, conflict_strategy: "lww" });
      B.settings = { ...B.settings, conflict_strategy: "lww" };
    });
    await cycle(B);

    // The cards leave because the merge replaced them, not instead of it. (The clearing
    // of the cards themselves belongs to `sync()`, and sync-engine.test.ts covers it.)
    await at(B, async () => {
      expect(await urlsHere()).toContain("https://only-on-a.example/");
      expect(await urlsHere()).toHaveLength(6);
    });
  });
});

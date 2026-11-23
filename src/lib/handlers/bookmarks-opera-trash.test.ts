import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  exportBookmarkPayload, importBookmarks, registerBookmarkListeners, resetExclusionCache, restoreBookmarks,
} from "@/lib/handlers/bookmarks-handler";
import { getAppeared, getFolderDeletes, getTombstones, getTrashMark, setBookmarkCache } from "@/lib/utils/storage";
import type { BookmarkPayload, SyncBookmark } from "@/lib/types";

// A bookmark deleted on Opera never reached the other devices. Opera's `bookmarks.remove()`
// does not remove anything: it moves the node into Opera's Trash and fires `onMoved`, never
// `onRemoved` (Opera 140, Chromium 157, measured 2026-11-23, also from the "Move to Trash"
// button in opera://bookmarks). Konode recorded a move. And everything in Opera's Trash, Speed
// Dials and Pinboards was published as bookmarks, so a peer that deleted its copy of a Speed
// Dial sent Opera's real one to the Trash.

type Node = chrome.bookmarks.BookmarkTreeNode;
type Fake = typeof chrome.bookmarks & {
  __setRoots: (roots: { id: string; title: string; folderType?: string; syncing?: boolean }[]) => void;
  __setTrash: (id: string | null) => void;
};
const fake = () => chrome.bookmarks as Fake;

// What Opera 140 lists in a fresh profile with a Hungarian UI: the Trash is "Kuka" and only
// the bar and Chromium's other node carry a folderType.
const OPERA_ROOTS = [
  { id: "1", title: "Könyvjelzősáv", folderType: "bookmarks-bar", syncing: false },
  { id: "2", title: "Importált könyvjelzők", folderType: "other", syncing: false },
  { id: "7", title: "Pinboard", syncing: false },
  { id: "6", title: "Speed Dials", syncing: false },
  { id: "9", title: "Kuka", syncing: false },
  { id: "4", title: "Besorolatlan könyvjelzők", syncing: false },
  { id: "8", title: "Unsynchronized Pinboard", syncing: false },
  { id: "5", title: "Egyéb könyvjelzők", syncing: false },
];
const TRASH = "9";
const SPEED_DIALS = "6";

const OPERA_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36 OPR/140.0.0.0";

/** This browser is Opera, with Opera's roots and Opera's remove(). */
function opera(roots = OPERA_ROOTS, trash = TRASH): void {
  vi.stubGlobal("navigator", {
    userAgent: OPERA_UA,
    userAgentData: { brands: [{ brand: "Not-A.Brand", version: "99" }, { brand: "Opera", version: "140" }, { brand: "Chromium", version: "157" }] },
  });
  fake().__setRoots(roots);
  fake().__setTrash(trash);
}

type Listeners = {
  created?: (id: string, node: Node) => void;
  moved?: (id: string, info: chrome.bookmarks.BookmarkMoveInfo) => void;
  removed?: (id: string, info: chrome.bookmarks.BookmarkRemoveInfo) => void;
};

function capture(onChange: () => void = () => {}): Listeners {
  const l: Listeners = {};
  /* eslint-disable @typescript-eslint/no-explicit-any */
  (chrome.bookmarks.onCreated as any).addListener = (fn: never) => { l.created = fn; };
  (chrome.bookmarks.onChanged as any).addListener = () => {};
  (chrome.bookmarks.onMoved as any).addListener = (fn: never) => { l.moved = fn; };
  (chrome.bookmarks.onRemoved as any).addListener = (fn: never) => { l.removed = fn; };
  /* eslint-enable @typescript-eslint/no-explicit-any */
  registerBookmarkListeners(onChange);
  return l;
}

/** Delete `id` the way Opera does, and fire the one event Opera fires for it. */
async function operaDelete(l: Listeners, id: string): Promise<void> {
  const [before] = await chrome.bookmarks.get(id);
  await chrome.bookmarks.removeTree(id);
  l.moved!(id, { parentId: TRASH, oldParentId: before.parentId!, index: 0, oldIndex: before.index ?? 0 });
  await settle();
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const FUTURE = Date.now() + 60_000;

function publishedUrls(tree: SyncBookmark[]): string[] {
  const out: string[] = [];
  const walk = (n: SyncBookmark) => { if (n.url) out.push(n.url); n.children?.forEach(walk); };
  tree.forEach(walk);
  return out.sort();
}

async function urlsIn(parentId: string): Promise<string[]> {
  return (await chrome.bookmarks.getChildren(parentId)).filter((c) => c.url).map((c) => c.url!).sort();
}

const link = (url: string): SyncBookmark => ({ id: `p-${url}`, parentId: null, title: url, url, dateAdded: 1 });

/** A Chromium peer's packet with `bar` in its bookmarks bar. */
function chromiumPayload(bar: SyncBookmark[], extra: Partial<BookmarkPayload> = {}): BookmarkPayload {
  return {
    tree: [{
      id: "0", parentId: null, title: "", dateAdded: 0,
      children: [
        { id: "1", parentId: "0", title: "Bookmarks bar", dateAdded: 0, rootKind: "bar", children: bar },
        { id: "2", parentId: "0", title: "Other bookmarks", dateAdded: 0, rootKind: "other", children: [] },
      ],
    }],
    tombstones: [],
    ...extra,
  };
}

beforeEach(() => resetExclusionCache());
afterEach(() => vi.unstubAllGlobals());

describe("a bookmark deleted on Opera is a deletion", () => {
  it("records the move into the Trash as one, and stops publishing the bookmark", async () => {
    opera();
    const l = capture();
    const a = await chrome.bookmarks.create({ parentId: "1", title: "a", url: "https://a.com/" });
    await chrome.bookmarks.create({ parentId: "1", title: "b", url: "https://b.com/" });

    await operaDelete(l, a.id);

    expect((await chrome.bookmarks.get(a.id))[0].parentId).toBe(TRASH); // still there, as on Opera
    expect((await getTombstones()).map((t) => t.url)).toEqual(["https://a.com/"]);
    const { tree, tombstones } = await exportBookmarkPayload();
    expect(publishedUrls(tree)).toEqual(["https://b.com/"]);
    expect(tombstones.map((t) => t.url)).toEqual(["https://a.com/"]);
  });

  it("takes everything in a deleted folder with it, though the event names the folder alone", async () => {
    opera();
    const l = capture();
    const work = await chrome.bookmarks.create({ parentId: "1", title: "Work" });
    await chrome.bookmarks.create({ parentId: work.id, title: "x", url: "https://x.com/" });
    const sub = await chrome.bookmarks.create({ parentId: work.id, title: "Sub" });
    await chrome.bookmarks.create({ parentId: sub.id, title: "y", url: "https://y.com/" });

    await operaDelete(l, work.id);

    expect((await getTombstones()).map((t) => t.url).sort()).toEqual(["https://x.com/", "https://y.com/"]);
    expect((await getFolderDeletes()).map((r) => r.path)).toEqual([["bar", "Work"]]);
    expect(publishedUrls((await exportBookmarkPayload()).tree)).toEqual([]);
  });

  it("records nothing more, and starts no sync, when the Trash is emptied", async () => {
    opera();
    let changes = 0;
    const l = capture(() => { changes++; });
    const a = await chrome.bookmarks.create({ parentId: "1", title: "a", url: "https://a.com/" });
    await operaDelete(l, a.id);
    changes = 0;
    const [node] = await chrome.bookmarks.get(a.id);

    await chrome.bookmarks.remove(a.id); // in the Trash: gone for good
    l.removed!(a.id, { parentId: TRASH, index: 0, node });
    await settle();

    expect(changes).toBe(0);
    expect((await getTombstones()).map((t) => t.url)).toEqual(["https://a.com/"]);
  });

  it("still records the deletion when the Trash was emptied before the move was handled", async () => {
    // The worker the move woke may reach it after the bookmark is gone for good. The last
    // synced snapshot still says what went.
    opera();
    const l = capture();
    const a = await chrome.bookmarks.create({ parentId: "1", title: "a", url: "https://a.com/" });
    await exportBookmarkPayload(); // a sync: the snapshot holds `a`

    await chrome.bookmarks.removeTree(a.id);
    await chrome.bookmarks.remove(a.id);
    l.moved!(a.id, { parentId: TRASH, oldParentId: "1", index: 0, oldIndex: 0 });
    await settle();

    expect((await getTombstones()).map((t) => t.url)).toEqual(["https://a.com/"]);
  });

  it("brings a bookmark taken back out of the Trash into the sync, dated now", async () => {
    opera();
    const l = capture();
    const a = await chrome.bookmarks.create({ parentId: "1", title: "a", url: "https://a.com/" });
    await operaDelete(l, a.id);
    await new Promise((r) => setTimeout(r, 5)); // a later moment than the deletion

    await chrome.bookmarks.move(a.id, { parentId: "1" });
    l.moved!(a.id, { parentId: "1", oldParentId: TRASH, index: 0, oldIndex: 0 });
    await settle();

    expect((await getAppeared()).map((r) => r.url)).toEqual(["https://a.com/"]);
    const { tree, tombstones } = await exportBookmarkPayload();
    const [published] = tree[0].children![0].children!;
    expect(published.url).toBe("https://a.com/");
    expect(published.dateAdded).toBeGreaterThan((await getTombstones())[0].deletedAt);
    expect(tombstones).toEqual([]); // it is here again, so the deletion is not published
  });
});

describe("Opera's own roots stay on Opera", () => {
  it("never publishes the Trash, the Speed Dials or the Pinboards", async () => {
    opera();
    for (const [parentId, url] of [["6", "https://dial.com/"], ["7", "https://pin.com/"], ["8", "https://pin2.com/"], ["9", "https://trashed.com/"], ["4", "https://unsorted.com/"], ["5", "https://other.com/"]]) {
      await chrome.bookmarks.create({ parentId, title: url, url });
    }
    const dialFolder = await chrome.bookmarks.create({ parentId: SPEED_DIALS, title: "NEXTEND-WINX" });
    await chrome.bookmarks.create({ parentId: dialFolder.id, title: "tile", url: "https://tile.com/" });

    const { tree } = await exportBookmarkPayload();

    // Unsorted bookmarks and Other bookmarks hold the user's bookmarks, and sync as before.
    expect(publishedUrls(tree)).toEqual(["https://other.com/", "https://unsorted.com/"]);
  });

  it("does not move a Speed Dial to the Trash when a peer deletes the copy 1.6.0 gave it", async () => {
    opera();
    await chrome.bookmarks.create({ parentId: SPEED_DIALS, title: "dial", url: "https://dial.com/" });

    await importBookmarks(chromiumPayload([], { tombstones: [{ url: "https://dial.com/", deletedAt: FUTURE }] }), "merge", "lww");

    expect(await urlsIn(SPEED_DIALS)).toEqual(["https://dial.com/"]);
    expect(await urlsIn(TRASH)).toEqual([]);
  });

  it("starts no sync for a Speed Dial added on Opera", async () => {
    opera();
    let changes = 0;
    const l = capture(() => { changes++; });

    const dial = await chrome.bookmarks.create({ parentId: SPEED_DIALS, title: "dial", url: "https://dial.com/" });
    l.created!(dial.id, dial);
    await settle();

    expect(changes).toBe(0);
  });

  it("never fills the Trash from a peer, even one on an older build that published its own", async () => {
    // An Opera peer on 1.6.0 still sends its Trash, under the same root id as this one's.
    opera();
    const old: BookmarkPayload = {
      tree: [{
        id: "0", parentId: null, title: "", dateAdded: 0,
        children: OPERA_ROOTS.map((r) => ({
          id: r.id, parentId: "0", title: r.title, dateAdded: 0,
          children: r.id === TRASH ? [link("https://their-trash.com/")] : [],
        })),
      }],
      tombstones: [],
    };

    await importBookmarks(old, "merge", "lww");

    expect(await urlsIn(TRASH)).toEqual([]);
  });

  it("restores nothing into the Trash", async () => {
    opera();
    const snapshot = chromiumPayload([link("https://a.com/")]).tree;
    // A restore point taken on Opera by 1.6.0 holds the Trash as a root of its own.
    snapshot[0].children!.push({ id: TRASH, parentId: "0", title: "Kuka", dateAdded: 0, children: [link("https://t.com/")] });

    await restoreBookmarks(snapshot);

    expect(await urlsIn(TRASH)).toEqual([]);
    expect(await urlsIn("1")).toEqual(["https://a.com/"]);
  });
});

describe("the Trash on an Opera whose numbering is not the one measured", () => {
  // Renumbered the way Edge 142 was (#66): the ids say nothing, the order is the same.
  const RENUMBERED = OPERA_ROOTS.map((r, i) => ({ ...r, id: String(20 + i) }));
  const RENUMBERED_TRASH = "24";

  it("is learned from a merge's own remove(), and set aside from then on", async () => {
    opera(RENUMBERED, RENUMBERED_TRASH);
    const l = capture();
    await chrome.bookmarks.create({ parentId: "20", title: "gone", url: "https://gone.com/" });
    const b = await chrome.bookmarks.create({ parentId: "20", title: "b", url: "https://b.com/" });

    // Until then nothing is set aside: a guess could take the user's bookmarks out instead.
    await importBookmarks(chromiumPayload([link("https://b.com/")], { tombstones: [{ url: "https://gone.com/", deletedAt: FUTURE }] }), "merge", "lww");

    expect(await getTrashMark()).toEqual({ id: RENUMBERED_TRASH, slot: 2 });
    expect(await urlsIn(RENUMBERED_TRASH)).toEqual(["https://gone.com/"]);
    expect(publishedUrls((await exportBookmarkPayload()).tree)).toEqual(["https://b.com/"]);

    // And the user's own deletion now counts.
    const [before] = await chrome.bookmarks.get(b.id);
    await chrome.bookmarks.remove(b.id);
    l.moved!(b.id, { parentId: RENUMBERED_TRASH, oldParentId: "20", index: 0, oldIndex: before.index ?? 0 });
    await settle();
    expect((await getTombstones()).filter((t) => t.own).map((t) => t.url)).toEqual(["https://b.com/"]);
  });
});

describe("a deletion on Opera reaches a Chromium device", () => {
  type Snap = unknown;
  const devices = (globalThis as unknown as {
    __konodeDevices: { snapshot: () => Snap; restore: (s: Snap) => void; fresh: (seq: number) => void };
  }).__konodeDevices;

  it("takes the bookmark off the other device, and leaves Opera's Speed Dials off it", async () => {
    // The Chromium device holds a and b from an earlier sync.
    devices.fresh(5000);
    await chrome.bookmarks.create({ parentId: "1", title: "a", url: "https://a.com/" });
    await chrome.bookmarks.create({ parentId: "1", title: "b", url: "https://b.com/" });
    const chromium = devices.snapshot();

    // Opera has them too, and a Speed Dial. A moment later the user deletes a there.
    devices.fresh(100);
    opera();
    const l = capture();
    const a = await chrome.bookmarks.create({ parentId: "1", title: "a", url: "https://a.com/" });
    await chrome.bookmarks.create({ parentId: "1", title: "b", url: "https://b.com/" });
    await chrome.bookmarks.create({ parentId: SPEED_DIALS, title: "dial", url: "https://dial.com/" });
    await setBookmarkCache((await exportBookmarkPayload()).tree);
    await new Promise((r) => setTimeout(r, 5));
    await operaDelete(l, a.id);
    const fromOpera = await exportBookmarkPayload();

    vi.unstubAllGlobals();
    devices.restore(chromium);
    await importBookmarks(fromOpera, "merge", "lww");

    expect(await urlsIn("1")).toEqual(["https://b.com/"]);
    expect(await urlsIn("2")).toEqual([]); // no Speed Dial in Other bookmarks
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  importBookmarks, exportBookmarkPayload, registerBookmarkListeners, resetExclusionCache, restoreBookmarks,
} from "@/lib/handlers/bookmarks-handler";
import { KEYS, getAppeared, getFolderDeletes, getTombstones } from "@/lib/utils/storage";
import type { BookmarkExclusion, BookmarkPayload, SyncBookmark } from "@/lib/types";

// #54. An extension that keeps a huge bookmark folder of its own had Konode publishing and
// merging every entry in it, and the browser froze until that was done. An excluded folder
// or bookmark stays on this device, untouched by anything a peer sends, and never leaves it.

type Node = chrome.bookmarks.BookmarkTreeNode;

function payload(barChildren: SyncBookmark[], extra: Partial<BookmarkPayload> = {}): BookmarkPayload {
  return {
    tree: [{
      id: "0", parentId: null, title: "", dateAdded: 0,
      children: [
        { id: "1", parentId: "0", title: "Bookmarks bar", dateAdded: 0, children: barChildren },
        { id: "2", parentId: "0", title: "Other bookmarks", dateAdded: 0, children: [] },
        { id: "3", parentId: "0", title: "Mobile bookmarks", dateAdded: 0, children: [] },
      ],
    }],
    tombstones: [],
    ...extra,
  };
}

const link = (url: string): SyncBookmark => ({ id: `p-${url}`, parentId: null, title: url, url, dateAdded: 1 });
const folder = (title: string, children: SyncBookmark[]): SyncBookmark =>
  ({ id: `p-${title}`, parentId: null, title, dateAdded: 1, children });

const FUTURE = Date.now() + 60_000;

async function exclude(rules: BookmarkExclusion[]): Promise<void> {
  await chrome.storage.local.set({ [KEYS.SETTINGS]: { excluded_bookmarks: rules } });
}

async function folderWith(title: string, urls: string[], parentId = "1"): Promise<string> {
  const f = await chrome.bookmarks.create({ parentId, title });
  for (const url of urls) await chrome.bookmarks.create({ parentId: f.id, title: url, url });
  return f.id;
}

async function urlsIn(parentId: string): Promise<string[]> {
  return (await chrome.bookmarks.getChildren(parentId)).filter((c) => c.url).map((c) => c.url!).sort();
}

function publishedUrls(tree: SyncBookmark[]): string[] {
  const out: string[] = [];
  const walk = (n: SyncBookmark) => { if (n.url) out.push(n.url); n.children?.forEach(walk); };
  tree.forEach(walk);
  return out.sort();
}

const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => resetExclusionCache());

describe("excluded bookmarks are never published (#54)", () => {
  it("leaves an excluded folder and an excluded bookmark out of the payload", async () => {
    await folderWith("Ext", ["https://ext1.com/", "https://ext2.com/"]);
    const work = await folderWith("Work", ["https://a.com/", "https://private.com/"]);
    await exclude([{ path: ["bar", "Ext"] }, { path: ["bar", "Work"], url: "https://private.com/" }]);

    const { tree } = await exportBookmarkPayload();

    expect(publishedUrls(tree)).toEqual(["https://a.com/"]);
    expect(await urlsIn(work)).toEqual(["https://a.com/", "https://private.com/"]); // still here
  });

  it("keeps a folder excluded after it is renamed here", async () => {
    const ext = await folderWith("Ext", ["https://ext1.com/"]);
    await exclude([{ path: ["bar", "Ext"], id: ext }]);
    await chrome.bookmarks.update(ext, { title: "Mirror" });

    expect(publishedUrls((await exportBookmarkPayload()).tree)).toEqual([]);
  });
});

describe("a peer cannot touch what is excluded here (#54)", () => {
  it("does not apply a peer's deletion inside an excluded folder", async () => {
    const ext = await folderWith("Ext", ["https://ext1.com/"]);
    await exclude([{ path: ["bar", "Ext"] }]);

    await importBookmarks(payload([], { tombstones: [{ url: "https://ext1.com/", deletedAt: FUTURE }] }), "merge", "lww");

    expect(await urlsIn(ext)).toEqual(["https://ext1.com/"]);
  });

  it("does not pour a peer's copy of the folder into the excluded one", async () => {
    // The peer runs the same extension and syncs its folder.
    const ext = await folderWith("Ext", ["https://ext1.com/"]);
    await exclude([{ path: ["bar", "Ext"] }]);

    await importBookmarks(payload([folder("Ext", [link("https://ext1.com/"), link("https://ext2.com/")]), link("https://a.com/")]), "merge", "lww");

    expect(await urlsIn(ext)).toEqual(["https://ext1.com/"]);
    expect((await chrome.bookmarks.getChildren("1")).filter((c) => !c.url).map((c) => c.title)).toEqual(["Ext"]);
    expect(await urlsIn("1")).toEqual(["https://a.com/"]); // the rest still merges
  });

  it("does not pour the peer's copy into a renamed excluded folder either", async () => {
    // Excluded by id, renamed here. The peer still calls it Ext, and so might this
    // device's extension again; neither gets merged in under the new name or the old one.
    const ext = await folderWith("Ext", ["https://ext1.com/"]);
    await exclude([{ path: ["bar", "Ext"], id: ext }]);
    await chrome.bookmarks.update(ext, { title: "Mirror" });

    await importBookmarks(payload([folder("Mirror", [link("https://m.com/")]), folder("Ext", [link("https://ext2.com/")])]), "merge", "lww");

    expect(await urlsIn(ext)).toEqual(["https://ext1.com/"]);
    expect((await chrome.bookmarks.getChildren("1")).map((c) => c.title)).toEqual(["Mirror"]);
  });

  it("ignores a peer's rename of an excluded folder", async () => {
    await folderWith("Ext", ["https://ext1.com/"]);
    await exclude([{ path: ["bar", "Ext"] }]);

    await importBookmarks(payload([], { folderRenames: [{ path: ["bar"], from: "Ext", to: "Renamed", at: FUTURE }] }), "merge", "lww");

    expect((await chrome.bookmarks.getChildren("1")).map((c) => c.title)).toEqual(["Ext"]);
  });

  it("keeps an excluded bookmark when a peer moves its own copy elsewhere", async () => {
    const work = await folderWith("Work", ["https://private.com/"]);
    await exclude([{ path: ["bar", "Work"], url: "https://private.com/" }]);

    await importBookmarks(
      payload([folder("Elsewhere", [link("https://private.com/")])], { moves: [{ url: "https://private.com/", at: FUTURE }] }),
      "merge", "lww",
    );

    expect(await urlsIn(work)).toEqual(["https://private.com/"]);
  });
});

describe("a replace keeps what is excluded (#54)", () => {
  it("clears around an excluded folder and fills the folders on the way to it", async () => {
    // A fresh device is replaced from the peer. bar/Tools/Ext is excluded, so Tools stays
    // standing, and the peer's Tools fills it instead of appearing as a second Tools.
    const tools = await chrome.bookmarks.create({ parentId: "1", title: "Tools" });
    const ext = await folderWith("Ext", ["https://ext1.com/"], tools.id);
    await chrome.bookmarks.create({ parentId: tools.id, title: "old", url: "https://old.com/" });
    await exclude([{ path: ["bar", "Tools", "Ext"] }]);

    await importBookmarks(payload([folder("Tools", [link("https://t.com/")]), link("https://a.com/")]), "replace", "lww");

    expect((await chrome.bookmarks.getChildren("1")).filter((c) => !c.url).map((c) => c.id)).toEqual([tools.id]);
    expect(await urlsIn(tools.id)).toEqual(["https://t.com/"]);
    expect(await urlsIn(ext)).toEqual(["https://ext1.com/"]);
  });
});

describe("a restore point leaves an excluded folder alone (#54)", () => {
  it("does not refill the excluded folder from a snapshot taken before it was excluded", async () => {
    const ext = await folderWith("Ext", ["https://ext1.com/"]);
    await exclude([{ path: ["bar", "Ext"] }]);

    const added = await restoreBookmarks(payload([folder("Ext", [link("https://ext1.com/"), link("https://ext2.com/")])]).tree);

    expect(added).toBe(0);
    expect(await urlsIn(ext)).toEqual(["https://ext1.com/"]);
  });
});

describe("events inside an excluded folder (#54)", () => {
  type Listeners = {
    created?: (id: string, node: Node) => void;
    moved?: (id: string, info: chrome.bookmarks.BookmarkMoveInfo) => void;
    removed?: (id: string, info: chrome.bookmarks.BookmarkRemoveInfo) => void;
  };

  function capture(onChange: () => void): Listeners {
    const l: Listeners = {};
    /* eslint-disable @typescript-eslint/no-explicit-any */
    (chrome.bookmarks.onCreated as any).addListener = (fn: never) => { l.created = fn; };
    (chrome.bookmarks.onMoved as any).addListener = (fn: never) => { l.moved = fn; };
    (chrome.bookmarks.onRemoved as any).addListener = (fn: never) => { l.removed = fn; };
    /* eslint-enable @typescript-eslint/no-explicit-any */
    registerBookmarkListeners(onChange);
    return l;
  }

  it("an extension filling its excluded folder records nothing and starts no sync", async () => {
    let changes = 0;
    const l = capture(() => { changes++; });
    const ext = await folderWith("Ext", []);
    await exclude([{ path: ["bar", "Ext"] }]);

    // Old dates, as an extension importing a site's bookmarks would carry.
    for (let i = 0; i < 5; i++) {
      const node = await chrome.bookmarks.create({ parentId: ext, title: `x${i}`, url: `https://x${i}.com/` });
      l.created!(node.id, { ...node, dateAdded: 1 });
    }
    const sub = await chrome.bookmarks.create({ parentId: ext, title: "Sub" });
    l.created!(sub.id, sub);
    const deep = await chrome.bookmarks.create({ parentId: sub.id, title: "deep", url: "https://deep.com/" });
    l.created!(deep.id, { ...deep, dateAdded: 1 });
    await settle();

    expect(changes).toBe(0);
    expect(await getAppeared()).toEqual([]);
  });

  it("a folder the extension rebuilds at the excluded path is excluded again", async () => {
    let changes = 0;
    const l = capture(() => { changes++; });
    await exclude([{ path: ["bar", "Ext"] }]);

    const rebuilt = await chrome.bookmarks.create({ parentId: "1", title: "Ext" });
    l.created!(rebuilt.id, rebuilt);
    await settle();
    const node = await chrome.bookmarks.create({ parentId: rebuilt.id, title: "x", url: "https://x.com/" });
    l.created!(node.id, node);
    await settle();

    expect(changes).toBe(0);
  });

  it("a bookmark created outside still syncs", async () => {
    let changes = 0;
    const l = capture(() => { changes++; });
    await folderWith("Ext", []);
    await exclude([{ path: ["bar", "Ext"] }]);

    const node = await chrome.bookmarks.create({ parentId: "1", title: "a", url: "https://a.com/" });
    l.created!(node.id, node);
    await settle();

    expect(changes).toBe(1);
  });

  it("moving a bookmark into an excluded folder is a deletion to the peers", async () => {
    // They still hold it in its old folder. Without the tombstone the next merge would put
    // it back there as a second copy. Nothing primes the listeners first: the event that
    // wakes a stopped service worker is the one being judged.
    const l = capture(() => {});
    const ext = await folderWith("Ext", []);
    const a = await chrome.bookmarks.create({ parentId: "1", title: "a", url: "https://a.com/" });
    await exclude([{ path: ["bar", "Ext"] }]);

    await chrome.bookmarks.move(a.id, { parentId: ext });
    l.moved!(a.id, { parentId: ext, oldParentId: "1", index: 0, oldIndex: 0 });
    await settle();

    expect((await getTombstones()).map((t) => t.url)).toEqual(["https://a.com/"]);
    expect(publishedUrls((await exportBookmarkPayload()).tree)).toEqual([]);
  });

  it("moving a bookmark out of an excluded folder brings it into the sync, dated now", async () => {
    let changes = 0;
    const l = capture(() => { changes++; });
    const ext = await folderWith("Ext", []);
    // Saved long ago, so a deletion recorded since must not read as newer and take it out.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() - 100 * 24 * 60 * 60 * 1000);
    const a = await chrome.bookmarks.create({ parentId: ext, title: "a", url: "https://a.com/" });
    vi.useRealTimers();
    await exclude([{ path: ["bar", "Ext"] }]);

    await chrome.bookmarks.move(a.id, { parentId: "1" });
    l.moved!(a.id, { parentId: "1", oldParentId: ext, index: 0, oldIndex: 0 });
    await settle();

    expect(changes).toBe(1);
    expect((await getAppeared()).map((r) => r.url)).toEqual(["https://a.com/"]);
    const [published] = (await exportBookmarkPayload()).tree[0].children![0].children!;
    expect(published.url).toBe("https://a.com/");
    expect(published.dateAdded).toBeGreaterThan(Date.now() - 60_000);
  });

  it("deleting a synced folder does not ask the peers to delete an excluded one inside it", async () => {
    const l = capture(() => {});
    const parent = await folderWith("Parent", ["https://a.com/"]);
    await folderWith("Ext", ["https://ext1.com/"], parent);
    await exclude([{ path: ["bar", "Parent", "Ext"] }]);
    const [removed] = await chrome.bookmarks.getSubTree(parent);

    await chrome.bookmarks.removeTree(parent);
    l.removed!(parent, { parentId: "1", index: 0, node: removed });
    await settle();

    expect((await getTombstones()).map((t) => t.url)).toEqual(["https://a.com/"]);
  });

  it("deleting inside an excluded folder records no deletion at all", async () => {
    let changes = 0;
    const l = capture(() => { changes++; });
    const ext = await folderWith("Ext", ["https://ext1.com/"]);
    await exclude([{ path: ["bar", "Ext"] }]);
    const [node] = await chrome.bookmarks.getChildren(ext);

    await chrome.bookmarks.remove(node.id);
    l.removed!(node.id, { parentId: ext, index: 0, node });
    await settle();

    expect(changes).toBe(0);
    expect(await getTombstones()).toEqual([]);
    expect(await getFolderDeletes()).toEqual([]);
  });
});

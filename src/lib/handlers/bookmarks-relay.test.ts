import { describe, it, expect } from "vitest";
import { importBookmarks, exportBookmarkPayload, registerBookmarkListeners } from "@/lib/handlers/bookmarks-handler";
import { getTombstones } from "@/lib/utils/storage";
import type { BookmarkPayload, SyncBookmark } from "@/lib/types";

// A device publishes the deletions it MADE. It does not pass on the ones it merely
// heard about, and it never asks for a bookmark it is advertising in the same file.
//
// Both halves come from #16, where four devices spent weeks demanding that each other
// delete 48, 49 and 56 bookmarks that none of them had deleted and all of them still
// had. One refused deletion was folded into the receiver's own log, republished from
// there, folded in by the next device, and so on around the group. The mass-delete
// guard held the whole time, which is why nothing was lost and why it could not stop.

function payload(barChildren: SyncBookmark[], tombstones: BookmarkPayload["tombstones"] = []): BookmarkPayload {
  return {
    tree: [{
      id: "0", parentId: null, title: "", dateAdded: 0,
      children: [
        { id: "1", parentId: "0", title: "Bookmarks bar", dateAdded: 0, children: barChildren },
        { id: "2", parentId: "0", title: "Other bookmarks", dateAdded: 0, children: [] },
        { id: "3", parentId: "0", title: "Mobile bookmarks", dateAdded: 0, children: [] },
      ],
    }],
    tombstones,
  };
}

const link = (title: string, url: string, dateAdded = 1): SyncBookmark =>
  ({ id: `r-${url}`, parentId: "1", title, url, dateAdded });

async function localUrls(): Promise<string[]> {
  const urls: string[] = [];
  const walk = (n: chrome.bookmarks.BookmarkTreeNode) => { if (n.url) urls.push(n.url); n.children?.forEach(walk); };
  (await chrome.bookmarks.getTree()).forEach(walk);
  return urls.sort();
}

describe("a deletion this device did not make is not passed on as its own", () => {
  it("does not republish what the mass-delete guard just refused", async () => {
    // 50 bookmarks, none of them ever deleted by this user.
    const urls: string[] = [];
    for (let i = 0; i < 50; i++) {
      const url = `https://site${i}.example/`;
      urls.push(url);
      await chrome.bookmarks.create({ parentId: "1", title: `B${i}`, url });
    }

    // A peer asks for 48 of them. Over the 60% cap, so the guard refuses.
    let blocked = 0;
    await importBookmarks(
      payload([], urls.slice(0, 48).map((url) => ({ url, deletedAt: Date.now() }))),
      "merge", "lww", 60, 0, (info) => { blocked = info.blocked; },
    );
    expect(blocked).toBe(48);
    expect(await localUrls()).toHaveLength(50); // nothing removed, as designed

    // The device that just refused a deletion must not turn around and demand it of
    // everyone else. Before the fix this published all 48, for bookmarks it still had.
    const out = await exportBookmarkPayload();
    const held = new Set(await localUrls());
    expect(out.tombstones.filter((t) => held.has(t.url))).toEqual([]);
  });

  it("keeps a peer's deletion locally, so a stale peer cannot resurrect the bookmark", async () => {
    // We never held X. One peer deleted it; a second peer has not caught up and still
    // lists it. Keeping the first peer's tombstone is what stops the second re-adding X,
    // and that is why the fold still absorbs it.
    await importBookmarks(payload([], [{ url: "https://x.com/", deletedAt: Date.now() }]), "merge", "lww");
    await importBookmarks(payload([link("X", "https://x.com/")]), "merge", "lww");

    expect(await localUrls()).toEqual([]);
    expect((await getTombstones()).map((t) => t.url)).toEqual(["https://x.com/"]);
    // Kept, but never ours to ask of anyone.
    expect((await exportBookmarkPayload()).tombstones).toEqual([]);
  });
});

describe("a peer that still lists a bookmark is not asking for its deletion", () => {
  it("ignores a tombstone the same packet contradicts", async () => {
    await chrome.bookmarks.create({ parentId: "1", title: "X", url: "https://x.com/" });

    // The packet advertises X and asks for X to go, with the deletion stamped later than
    // the bookmark was added. That is not a deletion: it is a device relaying a log it
    // picked up somewhere else, which is what every peer on an older build still does.
    await importBookmarks(
      payload([link("X", "https://x.com/")], [{ url: "https://x.com/", deletedAt: Date.now() }]),
      "merge", "lww",
    );

    expect(await localUrls()).toEqual(["https://x.com/"]);
  });
});

describe("our own deletions still reach the other devices", () => {
  it("publishes a bookmark this device deleted", async () => {
    let onRemoved: ((id: string, info: { node: chrome.bookmarks.BookmarkTreeNode }) => void) | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (chrome.bookmarks.onRemoved as any).addListener = (cb: never) => { onRemoved = cb; };
    registerBookmarkListeners(() => {});

    const a = await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com/" });
    await chrome.bookmarks.remove(a.id);
    onRemoved!(a.id, { node: { id: a.id, title: "A", url: "https://a.com/" } as chrome.bookmarks.BookmarkTreeNode });
    await new Promise((r) => setTimeout(r, 0)); // let the recorder persist

    expect((await exportBookmarkPayload()).tombstones.map((t) => t.url)).toEqual(["https://a.com/"]);
  });

  it("publishes a deletion recorded before the upgrade, which carries no provenance", async () => {
    // A pre-1.3.2 log cannot say who recorded what, and reading it as someone else's
    // would drop deletions that have not reached every device yet. Unflagged means ours.
    await importBookmarks(payload([]), "merge", "lww"); // no-op merge, nothing absorbed
    const { setTombstones } = await import("@/lib/utils/storage");
    await setTombstones([{ url: "https://old.example/", deletedAt: Date.now() }]);

    expect((await exportBookmarkPayload()).tombstones.map((t) => t.url)).toEqual(["https://old.example/"]);
  });
});

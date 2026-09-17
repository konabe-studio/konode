import { describe, it, expect } from "vitest";
import { importBookmarks, exportBookmarkPayload, registerBookmarkListeners } from "@/lib/handlers/bookmarks-handler";
import { getFolderDeletes } from "@/lib/utils/storage";
import type { BookmarkPayload, SyncBookmark } from "@/lib/types";

// #26. A tombstone is URL-keyed, so it could say a folder's bookmarks were deleted but never
// that the folder was. Every device that applied the tombstones kept the folder as an empty
// shell, and because empty folders are never synced, nothing could ever clean one up. The
// approval path made it the expected outcome of a button: "Apply and delete" on 80 of 80
// bookmarks left ten empty folders behind.

function payload(
  barChildren: SyncBookmark[],
  extra: Partial<BookmarkPayload> = {},
): BookmarkPayload {
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

const FUTURE = Date.now() + 60_000;
const gone = (...urls: string[]): BookmarkPayload["tombstones"] => urls.map((url) => ({ url, deletedAt: FUTURE }));

async function folderWith(title: string, urls: string[], parentId = "1"): Promise<string> {
  const f = await chrome.bookmarks.create({ parentId, title });
  for (const url of urls) await chrome.bookmarks.create({ parentId: f.id, title: url, url });
  return f.id;
}

async function barFolders(parentId = "1"): Promise<string[]> {
  return (await chrome.bookmarks.getChildren(parentId)).filter((c) => !c.url).map((c) => c.title);
}

describe("a folder emptied by a peer's deletions (#26)", () => {
  it("goes when the peer deleted the folder, not just its bookmarks", async () => {
    await folderWith("Work", ["https://a.com", "https://b.com"]);

    await importBookmarks(
      payload([], { tombstones: gone("https://a.com", "https://b.com"), folderDeletes: [{ path: ["bar", "Work"], at: FUTURE }] }),
      "merge", "lww",
    );

    expect(await barFolders()).toEqual([]);
  });

  it("stays when the peer deleted only the bookmarks in it", async () => {
    // The peer may have emptied the folder on purpose and kept it. Emptying is not deleting,
    // and a peer on an older build never says which, so the shell is left as it always was.
    await folderWith("Work", ["https://a.com", "https://b.com"]);

    await importBookmarks(payload([], { tombstones: gone("https://a.com", "https://b.com") }), "merge", "lww");

    expect(await barFolders()).toEqual(["Work"]);
  });

  it("goes on the approval path even without a record, because the user said delete", async () => {
    // 25 bookmarks in five folders, all tombstoned: over the floor of 20, so the guard holds
    // it until the user approves exactly this deletion.
    const urls: string[] = [];
    for (let f = 0; f < 5; f++) {
      const batch = Array.from({ length: 5 }, (_, i) => `https://f${f}-${i}.com`);
      urls.push(...batch);
      await folderWith(`F${f}`, batch);
    }

    await importBookmarks(payload([], { tombstones: gone(...urls) }), "merge", "lww", 60);
    expect(await barFolders()).toHaveLength(5); // blocked: nothing removed yet

    await importBookmarks(payload([], { tombstones: gone(...urls) }), "merge", "lww", 60, 25);
    expect(await barFolders()).toEqual([]);
  });

  it("takes the subfolders of a deleted folder with it", async () => {
    const work = await folderWith("Work", ["https://w.com"]);
    await folderWith("Sub", ["https://s.com"], work);

    await importBookmarks(
      payload([], { tombstones: gone("https://w.com", "https://s.com"), folderDeletes: [{ path: ["bar", "Work"], at: FUTURE }] }),
      "merge", "lww",
    );

    expect(await barFolders()).toEqual([]);
  });

  it("leaves the parent when only a subfolder was deleted", async () => {
    const work = await folderWith("Work", []);
    await folderWith("Sub", ["https://s.com"], work);

    await importBookmarks(
      payload([], { tombstones: gone("https://s.com"), folderDeletes: [{ path: ["bar", "Work", "Sub"], at: FUTURE }] }),
      "merge", "lww",
    );

    expect(await barFolders()).toEqual(["Work"]);
    expect(await barFolders(work)).toEqual([]);
  });

  it("keeps a folder that still holds bookmarks of this device's own", async () => {
    const work = await folderWith("Work", ["https://a.com", "https://mine-only.com"]);

    await importBookmarks(
      payload([], { tombstones: gone("https://a.com"), folderDeletes: [{ path: ["bar", "Work"], at: FUTURE }] }),
      "merge", "lww",
    );

    expect(await barFolders()).toEqual(["Work"]);
    expect((await chrome.bookmarks.getChildren(work)).map((c) => c.url)).toEqual(["https://mine-only.com"]);
  });

  it("keeps a folder created here after the peer deleted one of the same name", async () => {
    await folderWith("Work", ["https://a.com"]); // created now

    await importBookmarks(
      payload([], { tombstones: gone("https://a.com"), folderDeletes: [{ path: ["bar", "Work"], at: Date.now() - 60_000 }] }),
      "merge", "lww",
    );

    expect(await barFolders()).toEqual(["Work"]);
  });

  it("does not let a peer's record touch a folder its tombstones did not empty", async () => {
    await folderWith("Empty on purpose", []);

    await importBookmarks(
      payload([], { folderDeletes: [{ path: ["bar", "Empty on purpose"], at: FUTURE }] }),
      "merge", "lww",
    );

    expect(await barFolders()).toEqual(["Empty on purpose"]);
  });
});

describe("recording a folder deletion", () => {
  type RemovedListener = (id: string, info: { parentId: string; index: number; node: chrome.bookmarks.BookmarkTreeNode }) => void;

  function captureOnRemoved(): RemovedListener {
    let cb: RemovedListener | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (chrome.bookmarks.onRemoved as any).addListener = (fn: never) => { cb = fn; };
    registerBookmarkListeners(() => {});
    return (id, info) => cb!(id, info);
  }

  async function deleteFolder(onRemoved: RemovedListener, id: string, title: string): Promise<void> {
    await chrome.bookmarks.removeTree(id);
    onRemoved(id, { parentId: "1", index: 0, node: { id, title, children: [] } as chrome.bookmarks.BookmarkTreeNode });
    await new Promise((r) => setTimeout(r, 0));
  }

  it("records it and publishes it, without the local-only flag", async () => {
    const onRemoved = captureOnRemoved();
    const work = await folderWith("Work", ["https://a.com"]);

    await deleteFolder(onRemoved, work, "Work");

    expect((await getFolderDeletes()).map((r) => r.path)).toEqual([["bar", "Work"]]);
    const out = await exportBookmarkPayload();
    expect(out.folderDeletes?.map((r) => r.path)).toEqual([["bar", "Work"]]);
    expect(out.folderDeletes?.[0]).not.toHaveProperty("own");
  });

  it("stops publishing it once a folder of that name exists here again", async () => {
    const onRemoved = captureOnRemoved();
    const work = await folderWith("Work", ["https://a.com"]);
    await deleteFolder(onRemoved, work, "Work");

    await folderWith("Work", ["https://b.com"]);

    expect((await exportBookmarkPayload()).folderDeletes).toEqual([]);
  });

  it("records nothing when a same-named folder is still there", async () => {
    // Deleting one of two "Work" folders must not ask the peers to delete the other.
    const onRemoved = captureOnRemoved();
    const first = await folderWith("Work", ["https://a.com"]);
    await folderWith("Work", ["https://b.com"]);

    await deleteFolder(onRemoved, first, "Work");

    expect(await getFolderDeletes()).toEqual([]);
  });

  it("ignores a removed bookmark", async () => {
    const onRemoved = captureOnRemoved();
    const b = await chrome.bookmarks.create({ parentId: "1", title: "B", url: "https://b.com" });

    await chrome.bookmarks.remove(b.id);
    onRemoved(b.id, { parentId: "1", index: 0, node: { id: b.id, title: "B", url: "https://b.com" } as chrome.bookmarks.BookmarkTreeNode });
    await new Promise((r) => setTimeout(r, 0));

    expect(await getFolderDeletes()).toEqual([]);
  });
});

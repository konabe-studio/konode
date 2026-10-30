import { describe, it, expect, vi, afterEach } from "vitest";
import { importBookmarks, exportBookmarkPayload, registerBookmarkListeners } from "@/lib/handlers/bookmarks-handler";
import { getAppeared, setTombstones } from "@/lib/utils/storage";
import type { BookmarkPayload, SyncBookmark } from "@/lib/types";

// #27. Step A deletes a local bookmark for a peer's tombstone only when the bookmark is not
// newer than the deletion, which is what lets a re-add survive. Restoring from the browser's
// own bookmark export defeats it: the import honours the saved ADD_DATE, so the restored
// bookmark reads as months old, and the next merge deleted it again, for 90 days.

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

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

type CreatedListener = (id: string, node: chrome.bookmarks.BookmarkTreeNode) => void;

function captureOnCreated(): CreatedListener {
  let cb: CreatedListener | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (chrome.bookmarks.onCreated as any).addListener = (fn: never) => { cb = fn; };
  registerBookmarkListeners(() => {});
  return (id, node) => cb!(id, node);
}

/** A bookmark as a browser import creates it: carrying the date it was first saved. */
async function importedFromBackup(onCreated: CreatedListener, url: string, savedAt: number): Promise<void> {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(savedAt);
  const node = await chrome.bookmarks.create({ parentId: "1", title: url, url });
  vi.useRealTimers();
  onCreated(node.id, node);
  await new Promise((r) => setTimeout(r, 0));
}

async function localUrls(): Promise<string[]> {
  return (await chrome.bookmarks.getChildren("1")).map((c) => c.url!).filter(Boolean).sort();
}

afterEach(() => { vi.useRealTimers(); });

describe("restoring bookmarks from a browser backup (#27)", () => {
  it("survives a peer's deletion that is older than the restore", async () => {
    const onCreated = captureOnCreated();
    await importedFromBackup(onCreated, "https://a.com", Date.now() - 200 * DAY);

    // The deletion happened after the bookmark was first saved, and before it was restored.
    await importBookmarks(payload([], [{ url: "https://a.com", deletedAt: Date.now() - 10 * MINUTE }]), "merge", "lww");

    expect(await localUrls()).toEqual(["https://a.com"]);
  });

  it("still applies a deletion that is newer than the restore", async () => {
    const onCreated = captureOnCreated();
    await importedFromBackup(onCreated, "https://a.com", Date.now() - 200 * DAY);

    await importBookmarks(payload([], [{ url: "https://a.com", deletedAt: Date.now() + MINUTE }]), "merge", "lww");

    expect(await localUrls()).toEqual([]);
  });

  it("records nothing for a bookmark the user just made, whose date is already now", async () => {
    const onCreated = captureOnCreated();
    const node = await chrome.bookmarks.create({ parentId: "1", title: "New", url: "https://new.com" });
    onCreated(node.id, node);
    await new Promise((r) => setTimeout(r, 0));

    expect(await getAppeared()).toEqual([]);
  });

  it("publishes when the bookmark appeared, so a device holding the deletion takes it back", async () => {
    const onCreated = captureOnCreated();
    const savedAt = Date.now() - 200 * DAY;
    const deletedAt = Date.now() - 10 * MINUTE;
    await importedFromBackup(onCreated, "https://a.com", savedAt);

    const out = await exportBookmarkPayload();
    const exported = out.tree[0].children![0].children!.find((c) => c.url === "https://a.com")!;
    expect(exported.dateAdded).toBeGreaterThan(deletedAt);

    // Now play the device that made the deletion: the bookmark is gone there, and its own
    // tombstone for it is newer than the date the backup carried, but older than the restore.
    for (const c of await chrome.bookmarks.getChildren("1")) await chrome.bookmarks.remove(c.id);
    await chrome.storage.local.clear();
    await setTombstones([{ url: "https://a.com", deletedAt, own: true }]);

    await importBookmarks(out, "merge", "lww");

    expect(await localUrls()).toEqual(["https://a.com"]);
  });
});

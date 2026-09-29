import { describe, it, expect, vi, afterEach } from "vitest";
import { importBookmarks, restoreBookmarks } from "@/lib/handlers/bookmarks-handler";
import { getCreated, setTombstones, setTitles } from "@/lib/utils/storage";
import type { BookmarkPayload, SyncBookmark } from "@/lib/types";

// #41. The merge asks "do we have this already" by URL, and never looked at what the browser
// stored when it created one. Norton Neo keeps a peer's `chrome://newtab/` as `neo://newtab/`,
// so the peer's bookmark never matched the local copy and every sync added another: thousands
// of them, one per cycle, because each create also schedules the next sync.

const MINUTE = 60_000;
const PEER = "chrome://newtab/";
const KEPT = "neo://newtab/";

function payload(
  barChildren: SyncBookmark[], extra: Partial<BookmarkPayload> = {},
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

function link(title: string, url: string, dateAdded = 1): SyncBookmark {
  return { id: `r-${url}`, parentId: "1", title, url, dateAdded };
}

const newTab = (dateAdded = 1) => payload([link("New Tab", PEER, dateAdded), link("Real", "https://example.com/", dateAdded)]);

type CreateProps = { parentId?: string; index?: number; title?: string; url?: string };
const realCreate = chrome.bookmarks.create;
let createCalls = 0;

/**
 * Swap in a browser that does something other than store what it was given. `stored` is
 * what it keeps, `returned` is what create() reports, and they differ for an engine that
 * rewrites on its own schedule; `null` stores nothing at all.
 */
function engine(behave: (url: string) => { stored: string | null; returned: string }): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (chrome.bookmarks as any).create = async (props: CreateProps) => {
    if (!props.url) return realCreate(props);
    createCalls++;
    const { stored, returned } = behave(props.url);
    const node = await realCreate({ ...props, url: stored ?? props.url });
    if (stored === null) await chrome.bookmarks.remove(node.id);
    return { ...node, url: returned };
  };
}

/** Neo: an internal chrome:// page is stored under the browser's own scheme. */
const rewrites = (url: string) => {
  const kept = url.replace(/^chrome:\/\//, "neo://");
  return { stored: kept, returned: kept };
};

async function localUrls(): Promise<string[]> {
  const urls: string[] = [];
  const walk = (n: chrome.bookmarks.BookmarkTreeNode) => {
    if (n.url) urls.push(n.url);
    n.children?.forEach(walk);
  };
  (await chrome.bookmarks.getTree()).forEach(walk);
  return urls.sort();
}

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (chrome.bookmarks as any).create = realCreate;
  createCalls = 0;
  vi.useRealTimers();
});

describe("a browser that does not keep a bookmark as given (#41)", () => {
  it("gets one copy of a bookmark it stores under another URL, not one per sync", async () => {
    engine(rewrites);
    for (let i = 0; i < 5; i++) await importBookmarks(newTab());

    expect(await localUrls()).toEqual(["https://example.com/", KEPT]);
    expect((await getCreated()).find((r) => r.url === PEER)?.kept).toBe(KEPT);
  });

  it("stops retrying a create the browser reports but drops", async () => {
    engine((url) => ({ stored: url === PEER ? null : url, returned: url }));
    for (let i = 0; i < 5; i++) await importBookmarks(newTab());

    expect(createCalls).toBe(2); // the first sync's two creates, and nothing after
    expect((await getCreated()).find((r) => r.url === PEER)?.kept).toBeNull();
  });

  it("stops retrying when the browser rewrites the URL after reporting the original", async () => {
    engine((url) => ({ stored: url.replace(/^chrome:\/\//, "neo://"), returned: url }));
    for (let i = 0; i < 5; i++) await importBookmarks(newTab());

    expect(await localUrls()).toEqual(["https://example.com/", KEPT]);
  });

  it("creates it again when the peer adds it again", async () => {
    engine((url) => ({ stored: url === PEER ? null : url, returned: url }));
    await importBookmarks(newTab());
    await importBookmarks(newTab());
    expect(createCalls).toBe(2);

    await importBookmarks(newTab(Date.now() + MINUTE));
    expect(createCalls).toBe(3);
  });

  it("does not bring back the kept copy after the user deletes it here", async () => {
    engine(rewrites);
    await importBookmarks(newTab());
    const [kept] = (await chrome.bookmarks.getChildren("1")).filter((c) => c.url === KEPT);
    await chrome.bookmarks.remove(kept.id);
    await setTombstones([{ url: KEPT, deletedAt: Date.now(), own: true }]);

    await importBookmarks(newTab());

    expect(await localUrls()).toEqual(["https://example.com/"]);
  });

  it("removes the kept copy when the peer deletes its own form", async () => {
    engine(rewrites);
    await importBookmarks(newTab());

    await importBookmarks(payload([link("Real", "https://example.com/")], {
      tombstones: [{ url: PEER, deletedAt: Date.now() + MINUTE }],
    }));

    expect(await localUrls()).toEqual(["https://example.com/"]);
  });

  it("keeps the kept copy while the peer still lists that form", async () => {
    engine(rewrites);
    await importBookmarks(newTab());

    await importBookmarks(payload([link("Real", "https://example.com/"), link("New Tab", KEPT)], {
      tombstones: [{ url: PEER, deletedAt: Date.now() + MINUTE }],
    }));

    expect(await localUrls()).toEqual(["https://example.com/", KEPT]);
  });

  it("keeps a rename made to the kept copy over an older one from the peer", async () => {
    engine(rewrites);
    await importBookmarks(newTab());
    const [kept] = (await chrome.bookmarks.getChildren("1")).filter((c) => c.url === KEPT);
    await chrome.bookmarks.update(kept.id, { title: "Mine" });
    await setTitles([{ url: KEPT, title: "Mine", at: Date.now() }]);

    await importBookmarks(payload([link("Theirs", PEER)], {
      titles: [{ url: PEER, title: "Theirs", at: Date.now() - MINUTE }],
    }));

    const [after] = (await chrome.bookmarks.getChildren("1")).filter((c) => c.url === KEPT);
    expect(after.title).toBe("Mine");
  });

  it("does not restore a second copy of what the browser keeps under another URL", async () => {
    engine(rewrites);
    await importBookmarks(newTab());

    expect(await restoreBookmarks(newTab().tree)).toBe(0);
    expect(await localUrls()).toEqual(["https://example.com/", KEPT]);
  });

  it("stops watching a create once it has stuck", async () => {
    await importBookmarks(newTab());
    expect((await getCreated()).map((r) => r.url).sort()).toEqual(["https://example.com/", PEER].sort());

    // The next peer in the same sync is not proof yet: a browser that rewrites on its own
    // schedule may not have got to it.
    await importBookmarks(newTab());
    expect(await getCreated()).toHaveLength(2);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 11 * MINUTE);
    await importBookmarks(newTab());
    expect(await getCreated()).toEqual([]);
  });
});

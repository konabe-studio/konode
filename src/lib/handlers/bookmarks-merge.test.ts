import { describe, it, expect } from "vitest";
import { importBookmarks, exportBookmarkPayload, registerBookmarkListeners } from "@/lib/handlers/bookmarks-handler";
import type { BookmarkPayload, SyncBookmark } from "@/lib/types";

// These exercise the real merge/replace logic against the in-memory
// chrome.bookmarks fake from test/setup.ts (reset before each test).

/** A remote payload shaped like exportBookmarks() output: virtual root → 3 roots. */
function payload(barChildren: SyncBookmark[], tombstones: BookmarkPayload["tombstones"] = []): BookmarkPayload {
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
    tombstones,
  };
}

function link(title: string, url: string, dateAdded = 1): SyncBookmark {
  return { id: `r-${url}`, parentId: "1", title, url, dateAdded };
}

function folder(title: string, children: SyncBookmark[]): SyncBookmark {
  return { id: `r-folder-${title}`, parentId: "1", title, dateAdded: 1, children };
}

/** Seed a bookmark into the local fake under a root (defaults to the bar, "1"). */
async function seed(title: string, url: string, parentId = "1"): Promise<void> {
  await chrome.bookmarks.create({ parentId, title, url });
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

describe("importBookmarks — merge", () => {
  it("additively adds new remote bookmarks without duplicating existing ones", async () => {
    await seed("A", "https://a.com");
    await importBookmarks(payload([link("A", "https://a.com"), link("B", "https://b.com")]), "merge", "lww");
    expect(await localUrls()).toEqual(["https://a.com", "https://b.com"]);
  });

  it("propagates a peer deletion via a newer tombstone (lww)", async () => {
    await seed("A", "https://a.com");
    await seed("B", "https://b.com");
    const future = Date.now() + 60_000; // newer than the just-created local bookmarks
    // Remote tree no longer contains B, and carries a tombstone for it.
    await importBookmarks(
      payload([link("A", "https://a.com")], [{ url: "https://b.com", deletedAt: future }]),
      "merge",
      "lww"
    );
    expect(await localUrls()).toEqual(["https://a.com"]);
  });

  it("prefer-remote keeps a local bookmark that is newer than the peer's tombstone", async () => {
    await seed("A", "https://a.com");
    await seed("B", "https://b.com"); // just created → dateAdded ≈ now
    const past = Date.now() - 60_000;  // deletion is OLDER than the local re-add
    await importBookmarks(
      payload([link("A", "https://a.com")], [{ url: "https://b.com", deletedAt: past }]),
      "merge",
      "prefer-remote"
    );
    expect(await localUrls()).toEqual(["https://a.com", "https://b.com"]); // B survives
  });

  it("prefer-remote still deletes a local bookmark older than the peer's tombstone", async () => {
    await seed("A", "https://a.com");
    await seed("B", "https://b.com");
    const future = Date.now() + 60_000; // deletion is NEWER than the local bookmark
    await importBookmarks(
      payload([link("A", "https://a.com")], [{ url: "https://b.com", deletedAt: future }]),
      "merge",
      "prefer-remote"
    );
    expect(await localUrls()).toEqual(["https://a.com"]); // B deleted
  });

  it("prefer-local ignores the peer's deletions", async () => {
    await seed("A", "https://a.com");
    await seed("B", "https://b.com");
    const future = Date.now() + 60_000;
    await importBookmarks(
      payload([link("A", "https://a.com")], [{ url: "https://b.com", deletedAt: future }]),
      "merge",
      "prefer-local"
    );
    expect(await localUrls()).toEqual(["https://a.com", "https://b.com"]);
  });

  it("preserves folders and reuses a same-title folder on re-merge (no duplicate)", async () => {
    const p = payload([folder("Work", [link("W", "https://work.com")])]);
    await importBookmarks(p, "merge", "lww");
    await importBookmarks(p, "merge", "lww"); // second merge must not duplicate

    expect(await localUrls()).toEqual(["https://work.com"]);
    const barChildren = await chrome.bookmarks.getChildren("1");
    const workFolders = barChildren.filter((c) => !c.url && c.title === "Work");
    expect(workFolders).toHaveLength(1);
  });
});

describe("importBookmarks — mass-delete guard (configurable percent)", () => {
  async function seedMany(n: number): Promise<void> {
    for (let i = 0; i < n; i++) await seed(`S${i}`, `https://s${i}.com`);
  }
  // deletedAt far in the future so every matching local bookmark qualifies for deletion.
  function tombstonesFor(n: number): BookmarkPayload["tombstones"] {
    return Array.from({ length: n }, (_, i) => ({ url: `https://s${i}.com`, deletedAt: 9e15 }));
  }

  it("skips a peer deletion that exceeds the default 60% cap", async () => {
    await seedMany(100);
    // 70 of 100 tombstoned = 70% > 60% default → guard trips, nothing deleted.
    await importBookmarks(payload([], tombstonesFor(70)), "merge", "lww");
    expect((await localUrls()).length).toBe(100);
  });

  it("applies the same deletion when the configured percent is raised above it", async () => {
    await seedMany(100);
    // Same 70% delete, but deletePercent=80 → cap 80 → 70 ≤ 80 → deletions apply.
    await importBookmarks(payload([], tombstonesFor(70)), "merge", "lww", 80);
    expect((await localUrls()).length).toBe(30);
  });
});

describe("importBookmarks — URL edit (no duplicate)", () => {
  it("tombstones the replaced url on edit so a peer doesn't resurrect it", async () => {
    // Capture the onChanged listener the handler registers (the fake's is a no-op).
    let onChanged: ((id: string, info: { title: string; url?: string }) => void) | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (chrome.bookmarks.onChanged as any).addListener = (cb: never) => { onChanged = cb; };
    registerBookmarkListeners(() => {});

    // Local: create A, then export — this snapshots the tree into synkro_bm_cache,
    // which is the state peers still hold (id → https://a.com).
    const a = await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com" });
    await exportBookmarkPayload();

    // User edits the URL A → A2. Chrome fires onChanged with the NEW url.
    await chrome.bookmarks.update(a.id, { url: "https://a2.com" });
    onChanged!(a.id, { title: "A", url: "https://a2.com" });
    await new Promise((r) => setTimeout(r, 0)); // let recordUrlChange persist the tombstone

    // A peer still lists the OLD url. Before the fix, the merge re-added it as a
    // duplicate; now the edit's tombstone suppresses it.
    await importBookmarks(payload([link("A", "https://a.com")]), "merge", "lww");
    expect(await localUrls()).toEqual(["https://a2.com"]);
  });
});

describe("empty folders are not synced", () => {
  it("merge does not resurrect a folder whose only bookmark was deleted", async () => {
    await seed("X", "https://x.com", "1"); // local X lives in the bar
    const future = Date.now() + 60_000;
    // Peer still has a "Gone" folder containing X, but X is tombstoned.
    await importBookmarks(
      payload([folder("Gone", [link("X", "https://x.com")])], [{ url: "https://x.com", deletedAt: future }]),
      "merge",
      "lww"
    );
    expect(await localUrls()).toEqual([]); // X deleted by the tombstone
    const bar = await chrome.bookmarks.getChildren("1");
    expect(bar.filter((c) => !c.url && c.title === "Gone")).toHaveLength(0); // not resurrected
  });

  it("merge ignores a purely empty remote folder", async () => {
    await importBookmarks(payload([folder("EmptyDir", [])]), "merge", "lww");
    const bar = await chrome.bookmarks.getChildren("1");
    expect(bar.filter((c) => !c.url && c.title === "EmptyDir")).toHaveLength(0);
  });

  it("exportBookmarkPayload omits empty folders but keeps folders with links", async () => {
    await chrome.bookmarks.create({ parentId: "1", title: "EmptyDir" });
    const full = await chrome.bookmarks.create({ parentId: "1", title: "FullDir" });
    await chrome.bookmarks.create({ parentId: full.id, title: "L", url: "https://l.com" });
    const { tree } = await exportBookmarkPayload();
    const bar = tree[0].children?.find((r) => r.id === "1");
    const folderTitles = (bar?.children ?? []).filter((c) => !c.url).map((c) => c.title);
    expect(folderTitles).toContain("FullDir");
    expect(folderTitles).not.toContain("EmptyDir");
  });
});

describe("importBookmarks — moves", () => {
  it("relocates a bookmark to the peer's folder when the peer's move is newer (lww)", async () => {
    const wdt = await chrome.bookmarks.create({ parentId: "1", title: "Web Design Things" });
    await chrome.bookmarks.create({ parentId: wdt.id, title: "X", url: "https://x.com" });

    // Peer has X at the bar root with a newer move record.
    const future = Date.now() + 60_000;
    const p: BookmarkPayload = {
      ...payload([link("X", "https://x.com")]),
      moves: [{ url: "https://x.com", at: future }],
    };
    await importBookmarks(p, "merge", "lww");

    const bar = await chrome.bookmarks.getChildren("1");
    expect(bar.find((c) => c.url === "https://x.com")).toBeTruthy(); // now at the bar root
    const wdtChildren = await chrome.bookmarks.getChildren(wdt.id);
    expect(wdtChildren.find((c) => c.url === "https://x.com")).toBeFalsy(); // gone from WDT
    expect(await localUrls()).toEqual(["https://x.com"]); // no duplicate
  });

  it("does NOT move a present bookmark without a newer move record", async () => {
    const wdt = await chrome.bookmarks.create({ parentId: "1", title: "WDT" });
    await chrome.bookmarks.create({ parentId: wdt.id, title: "X", url: "https://x.com" });

    // Peer lists X at the bar root but carries no move → placement must not churn.
    await importBookmarks(payload([link("X", "https://x.com")]), "merge", "lww");

    const wdtChildren = await chrome.bookmarks.getChildren(wdt.id);
    expect(wdtChildren.find((c) => c.url === "https://x.com")).toBeTruthy(); // stayed put
  });

  it("places a moved bookmark at the peer's index, not at the end", async () => {
    // Local order inside folder F: A, X, B
    const f = await chrome.bookmarks.create({ parentId: "1", title: "F" });
    await chrome.bookmarks.create({ parentId: f.id, title: "A", url: "https://a.com" });
    await chrome.bookmarks.create({ parentId: f.id, title: "X", url: "https://x.com" });
    await chrome.bookmarks.create({ parentId: f.id, title: "B", url: "https://b.com" });

    // Peer moved X to the front of F (index 0), with a newer move record.
    const future = Date.now() + 60_000;
    const p: BookmarkPayload = {
      tree: [
        {
          id: "0", parentId: null, title: "", dateAdded: 0,
          children: [
            {
              id: "1", parentId: "0", title: "Bookmarks bar", dateAdded: 0,
              children: [
                folder("F", [
                  link("X", "https://x.com"),
                  link("A", "https://a.com"),
                  link("B", "https://b.com"),
                ]),
              ],
            },
            { id: "2", parentId: "0", title: "Other bookmarks", dateAdded: 0, children: [] },
            { id: "3", parentId: "0", title: "Mobile bookmarks", dateAdded: 0, children: [] },
          ],
        },
      ],
      tombstones: [],
      moves: [{ url: "https://x.com", at: future }],
    };
    await importBookmarks(p, "merge", "lww");

    const fLocal = (await chrome.bookmarks.getChildren("1")).find((c) => !c.url && c.title === "F")!;
    const order = (await chrome.bookmarks.getChildren(fLocal.id)).map((c) => c.url);
    expect(order).toEqual(["https://x.com", "https://a.com", "https://b.com"]); // X moved to front
  });
});

describe("importBookmarks — replace", () => {
  it("clears local and restores the remote tree", async () => {
    await seed("A", "https://a.com");
    await importBookmarks(payload([link("B", "https://b.com")]), "replace");
    expect(await localUrls()).toEqual(["https://b.com"]);
  });

  it("refuses a destructive replace when the remote tree is empty (data-loss guard)", async () => {
    await seed("A", "https://a.com");
    await importBookmarks(payload([]), "replace"); // all roots empty
    expect(await localUrls()).toEqual(["https://a.com"]);
  });
});

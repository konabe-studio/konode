import { describe, it, expect, vi } from "vitest";
import {
  importBookmarks, exportBookmarkPayload, registerBookmarkListeners, resetDeletionLog,
  type BulkDeleteBlock,
} from "@/lib/handlers/bookmarks-handler";
import { getTombstones, setTombstones, getBulkDeleteApproval, setBulkDeleteApproval, KEYS } from "@/lib/utils/storage";
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

describe("importBookmarks — cross-browser move safety (confidence gate)", () => {
  // A peer we can't confidently map to a local root (foreign id, mismatched title —
  // e.g. a peer on an older build) sends a MOVE for a bookmark we already hold.
  // Without the gate the merge would yank it into the default root; with the gate
  // it stays put. Local fake is Chrome-shaped ("1"/"2"/"3"); the peer root is Firefox.
  const foreignRootPayload = (childrenBar: SyncBookmark[], moves: BookmarkPayload["moves"]): BookmarkPayload => ({
    tree: [{
      id: "root________", parentId: null, title: "", dateAdded: 0,
      children: [
        // Firefox-style root id "menu________" (kind "menu" — no Chrome equivalent)
        // with a non-matching title → matchLocalRoot falls to position/default (not
        // confident). Using "menu" avoids a cross-browser KIND match to the bar.
        { id: "menu________", parentId: "root________", title: "Bookmarks Menu", dateAdded: 0, children: childrenBar },
      ],
    }],
    tombstones: [],
    moves,
  });

  it("does NOT relocate an existing bookmark when the peer root is unmappable", async () => {
    await seed("X", "https://x.com", "2"); // local: in "Other bookmarks"
    // The peer's "menu" root has no Chrome counterpart, so it degrades to the default
    // writable root and carries a newer move for X. Not confident either way, so the
    // gate must leave X where it is rather than acting on the peer's placement.
    await importBookmarks(
      foreignRootPayload([link("X", "https://x.com")], [{ url: "https://x.com", at: Date.now() }]),
      "merge",
      "lww",
    );
    expect((await chrome.bookmarks.getChildren("2")).map((c) => c.url)).toContain("https://x.com");
    expect((await chrome.bookmarks.getChildren("1")).map((c) => c.url)).not.toContain("https://x.com");
    expect(await localUrls()).toEqual(["https://x.com"]); // not displaced, no dup
  });

  it("still ADDS a genuinely new bookmark from an unmappable peer", async () => {
    await importBookmarks(foreignRootPayload([link("New", "https://new.com")], []), "merge", "lww");
    expect(await localUrls()).toEqual(["https://new.com"]);
  });
});

describe("tombstones — duplicate-URL safety", () => {
  it("deleting ONE of two identical-URL bookmarks records NO tombstone; deleting the last one does", async () => {
    let onRemoved: ((id: string, info: { node: chrome.bookmarks.BookmarkTreeNode }) => void) | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (chrome.bookmarks.onRemoved as any).addListener = (cb: never) => { onRemoved = cb; };
    registerBookmarkListeners(() => {});

    const url = "https://dup.com";
    const a = await chrome.bookmarks.create({ parentId: "1", title: "Dup", url });
    const b = await chrome.bookmarks.create({ parentId: "1", title: "Dup", url });

    // Remove the FIRST copy — a copy still remains, so no tombstone.
    await chrome.bookmarks.remove(a.id);
    onRemoved!(a.id, { node: { id: a.id, title: "Dup", url } as chrome.bookmarks.BookmarkTreeNode });
    await new Promise((r) => setTimeout(r, 0));
    expect(await getTombstones()).toEqual([]);

    // Remove the LAST copy — now genuinely gone, so a tombstone is recorded.
    await chrome.bookmarks.remove(b.id);
    onRemoved!(b.id, { node: { id: b.id, title: "Dup", url } as chrome.bookmarks.BookmarkTreeNode });
    await new Promise((r) => setTimeout(r, 0));
    expect((await getTombstones()).map((t) => t.url)).toEqual([url]);
  });
});

describe("tombstones: a bulk delete is one line in the Activity log", () => {
  // The browser fires onRemoved once per node. Selecting 25 bookmarks and pressing Delete
  // wrote 25 identical "Recorded 1 deletion(s)" events in the same second, so a 200-bookmark
  // cleanup filled the whole log and evicted everything a bug report would need.
  let onRemoved: ((id: string, info: { node: chrome.bookmarks.BookmarkTreeNode }) => void) | undefined;

  async function recordedLines(): Promise<string[]> {
    const entries = ((await chrome.storage.local.get(KEYS.AUDIT_LOG))[KEYS.AUDIT_LOG] ?? []) as
      { action: string; detail?: string }[];
    return entries.filter((e) => e.action === "Tombstones").map((e) => e.detail ?? "");
  }
  let made: chrome.bookmarks.BookmarkTreeNode[] = [];
  async function make(n: number): Promise<void> {
    made = [];
    for (let i = 0; i < n; i++) {
      made.push(await chrome.bookmarks.create({ parentId: "1", title: `W${i}`, url: `https://w${i}.com` }));
    }
  }
  async function deleteBookmarks(from: number, to: number): Promise<void> {
    for (const node of made.slice(from, to)) {
      await chrome.bookmarks.remove(node.id);
      onRemoved!(node.id, { node });
    }
  }

  function setUp(): void {
    // Before the fake clock, so a real timer an earlier test left running is really cleared.
    resetDeletionLog();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (chrome.bookmarks.onRemoved as any).addListener = (cb: never) => { onRemoved = cb; };
    registerBookmarkListeners(() => {});
  }

  it("records every deletion at once, and says so once for the whole burst", async () => {
    setUp();
    try {
      await make(25);
      await deleteBookmarks(0, 25);
      await vi.advanceTimersByTimeAsync(0);

      // The records are not held back: the sync a second from now publishes them.
      expect(await getTombstones()).toHaveLength(25);
      expect(await recordedLines()).toEqual([]);

      await vi.advanceTimersByTimeAsync(1000);
      expect(await recordedLines()).toEqual(["Recorded 25 deletion(s)"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives a deletion after a quiet second a line of its own", async () => {
    setUp();
    try {
      await make(3);
      await deleteBookmarks(0, 2);
      await vi.advanceTimersByTimeAsync(1500);
      await deleteBookmarks(2, 3);
      await vi.advanceTimersByTimeAsync(1500);

      expect(await recordedLines()).toEqual(["Recorded 1 deletion(s)", "Recorded 2 deletion(s)"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

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

describe("importBookmarks — folders that share a name (#51)", () => {
  // Folders have no id that crosses devices and were matched by title alone, so every folder
  // of one name under a parent went into the first: a tree with several unnamed folders came
  // out with one, holding the bookmarks of all of them.

  /** The bar as "title" for a bookmark and "[title] children" for a folder. */
  async function bar(): Promise<string[]> {
    return Promise.all((await chrome.bookmarks.getChildren("1")).map(async (c) =>
      c.url ? c.title : `[${c.title}] ${(await chrome.bookmarks.getChildren(c.id)).map((k) => k.title).join(",")}`
    ));
  }

  it("keeps each of the peer's same-named folders apart, in the peer's order", async () => {
    await seed("Mine", "https://mine.com"); // not empty, so this is a merge and not a replace
    const p = payload([
      folder("", [link("A", "https://a.com"), link("B", "https://b.com")]),
      folder("", [link("C", "https://c.com")]),
      folder("News", [link("D", "https://d.com")]),
      folder("News", [link("E", "https://e.com")]),
    ]);

    await importBookmarks(p, "merge", "lww");
    await importBookmarks(p, "merge", "lww"); // and the next sync finds them again

    expect(await bar()).toEqual(["[] A,B", "[] C", "[News] D", "[News] E", "Mine"]);
  });

  it("files a new bookmark into the same-named folder that holds its neighbours", async () => {
    await seed("Mine", "https://mine.com");
    const a = folder("", [link("A", "https://a.com")]);
    await importBookmarks(payload([a, folder("", [link("C", "https://c.com")])]), "merge", "lww");

    await importBookmarks(
      payload([a, folder("", [link("C", "https://c.com"), link("X", "https://x.com")])]), "merge", "lww"
    );

    expect(await bar()).toEqual(["[] A", "[] C,X", "Mine"]);
  });

  it("does not file a new folder's bookmarks into one that holds a same-named sibling's", async () => {
    await seed("Mine", "https://mine.com");
    const a = folder("", [link("A", "https://a.com")]);
    await importBookmarks(payload([a]), "merge", "lww");

    // The peer adds a second unnamed folder. The one here is the first one's, by what is in it.
    await importBookmarks(payload([a, folder("", [link("X", "https://x.com")])]), "merge", "lww");

    expect(await bar()).toEqual(["[] A", "[] X", "Mine"]);
  });

  it("still merges into a same-named folder of this device's own", async () => {
    // Two devices that each had a Work folder end up with one: the title is unique on both
    // sides, so there is nothing to tell apart.
    const work = await chrome.bookmarks.create({ parentId: "1", title: "Work" });
    await seed("Mine", "https://mine.com", work.id);

    await importBookmarks(payload([folder("Work", [link("W", "https://work.com")])]), "merge", "lww");

    expect(await bar()).toEqual(["[Work] W,Mine"]);
  });
});

describe("importBookmarks — the peer's index must not exceed the local parent", () => {
  // The peer's absolute child index is meaningless on a device whose matching parent
  // holds fewer children. Chrome/Firefox REJECT `create({ index })` past the child
  // count, the merge's catch swallowed it, and the bookmark was never added — on every
  // sync, silently, forever. (The test fake used to clamp, which hid all of this.)

  it("adds a bookmark whose peer index is past the end of the local parent", async () => {
    // Peer bar: [X, Y]. X is tombstoned here, so it is suppressed and never created —
    // which leaves the local bar EMPTY when Y arrives carrying index 1.
    await setTombstones([{ url: "https://x.com", deletedAt: Date.now() }]);

    await importBookmarks(
      payload([link("X", "https://x.com"), link("Y", "https://y.com")]),
      "merge",
      "lww"
    );

    expect(await localUrls()).toEqual(["https://y.com"]);
  });

  it("adds every bookmark when the peer's parent is much larger than the local one", async () => {
    // Eight of the peer's ten already live here, but in a DIFFERENT folder, so
    // `placement` matches them and they are never (re)created in the bar. The last
    // two then carry indices 8 and 9 into a bar that has 0 children.
    const kids = Array.from({ length: 10 }, (_, i) => link(`L${i}`, `https://l${i}.com`));
    for (let i = 0; i < 8; i++) await seed(`L${i}`, `https://l${i}.com`, "2"); // in "Other"

    await importBookmarks(payload(kids), "merge", "lww");

    expect(await localUrls()).toEqual(kids.map((k) => k.url!).sort());
  });

  it("creates a folder whose peer index is past the end of the local parent", async () => {
    await setTombstones([{ url: "https://x.com", deletedAt: Date.now() }]);

    await importBookmarks(
      payload([link("X", "https://x.com"), folder("Work", [link("W", "https://work.com")])]),
      "merge",
      "lww"
    );

    expect(await localUrls()).toEqual(["https://work.com"]);
    const bar = await chrome.bookmarks.getChildren("1");
    expect(bar.filter((c) => !c.url).map((c) => c.title)).toEqual(["Work"]);
  });

  it("still honours the peer's position when the local parent is large enough", async () => {
    // The clamp must not flatten real placement: B belongs between A and C.
    await seed("A", "https://a.com");
    await seed("C", "https://c.com");

    await importBookmarks(
      payload([link("A", "https://a.com"), link("B", "https://b.com"), link("C", "https://c.com")]),
      "merge",
      "lww"
    );

    const order = (await chrome.bookmarks.getChildren("1")).map((c) => c.title);
    expect(order).toEqual(["A", "B", "C"]);
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

  /** The merge summary line from the Activity log, or undefined if none was kept. */
  async function summaryLine(): Promise<string | undefined> {
    await new Promise((r) => setTimeout(r, 0)); // logger fires appendAudit unawaited
    const entries = ((await chrome.storage.local.get(KEYS.AUDIT_LOG))[KEYS.AUDIT_LOG] ?? []) as
      { detail?: string }[];
    return entries.map((e) => e.detail).reverse().find((d) => d?.startsWith("Merged "));
  }

  it("reports the deletions it APPLIED, not the ones the peer asked for", async () => {
    await seedMany(100);
    await importBookmarks(payload([], tombstonesFor(70)), "merge", "lww");

    // Nothing was removed, so the summary must not claim 70 were. It used to print
    // `-70` directly above the warning saying those 70 had been refused.
    expect((await localUrls()).length).toBe(100);
    const line = await summaryLine();
    if (line) expect(line).toContain("-0");
  });

  it("applies a blocked deletion the user approved", async () => {
    await seedMany(100);
    // The slider cannot reach this: 95% of 100 is a cap of 95, and 98 is over it.
    await importBookmarks(payload([], tombstonesFor(98)), "merge", "lww", 95);
    expect((await localUrls()).length).toBe(100);

    await importBookmarks(payload([], tombstonesFor(98)), "merge", "lww", 95, 98);
    expect((await localUrls()).length).toBe(2);
  });

  // #41, the first gap: the guard judged each merge alone, so a deletion that arrived in
  // pieces went through piece by piece. A peer's log grows as it deletes, which is why each
  // payload below carries every tombstone so far.
  it("holds a deletion that arrives in pieces against the total", async () => {
    await seedMany(100);
    await importBookmarks(payload([], tombstonesFor(30)), "merge", "lww");
    await importBookmarks(payload([], tombstonesFor(60)), "merge", "lww");
    // 60 of 100 is the cap exactly, so both pieces were allowed.
    expect((await localUrls()).length).toBe(40);

    // Ten more is 70 of the 100 there were. On its own it is 10 of 40, which the old guard
    // (cap max(20, 24)) let through.
    let info: BulkDeleteBlock | undefined;
    await importBookmarks(payload([], tombstonesFor(70)), "merge", "lww", 60, 0, (i) => { info = i; });

    expect((await localUrls()).length).toBe(40);
    expect(info).toEqual({ blocked: 10, cap: 60, localTotal: 40, pct: 60, recent: 60 });
  });

  it("forgets what peers removed more than a day ago", async () => {
    await seedMany(100);
    const start = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    try {
      await importBookmarks(payload([], tombstonesFor(30)), "merge", "lww");
      await importBookmarks(payload([], tombstonesFor(60)), "merge", "lww");
      clock.mockReturnValue(start + 25 * 60 * 60 * 1000);
      // The same ten as above, a day later: 10 of 40 again, and nothing to add it to.
      await importBookmarks(payload([], tombstonesFor(70)), "merge", "lww");
    } finally {
      clock.mockRestore();
    }
    expect((await localUrls()).length).toBe(30);
  });

  it("starts the window over once the user approves", async () => {
    await seedMany(100);
    await importBookmarks(payload([], tombstonesFor(30)), "merge", "lww");
    await importBookmarks(payload([], tombstonesFor(60)), "merge", "lww");
    // Blocked as above, then approved for the ten the card showed.
    await importBookmarks(payload([], tombstonesFor(70)), "merge", "lww", 60, 10);
    expect((await localUrls()).length).toBe(30);

    // The card showed the 60 before it too, and the user said yes to all of it. Counted
    // again, five more would be 65 of 90 and blocked a second time for the same cleanup.
    await importBookmarks(payload([], tombstonesFor(75)), "merge", "lww");
    expect((await localUrls()).length).toBe(25);
  });

  it("no longer counts a bookmark that came back as gone", async () => {
    await seedMany(100);
    await importBookmarks(payload([], tombstonesFor(30)), "merge", "lww");
    await importBookmarks(payload([], tombstonesFor(60)), "merge", "lww");
    // The user restores the first thirty (a restore point, or the browser's own backup).
    for (let i = 0; i < 30; i++) await seed(`S${i}`, `https://s${i}.com`);

    // 25 more from another peer: 25 + the 30 still gone = 55 of 100, under 60. Counting the
    // restored thirty as gone as well would make it 85 of 130 and block it.
    const more = Array.from({ length: 25 }, (_, i) => ({ url: `https://s${60 + i}.com`, deletedAt: 9e15 }));
    await importBookmarks(payload([], more), "merge", "lww");

    expect((await localUrls()).length).toBe(45);
  });

  // #41, the second gap: the guard counted bookmark nodes, so a pile of duplicates (Norton
  // Neo made thousands of one New Tab bookmark) inflated the tree it measured against.
  it("counts a bookmark held in many copies once when sizing the tree", async () => {
    await seedMany(40);
    for (let i = 0; i < 200; i++) await seed("New Tab", "neo://newtab/");

    // 30 of 41 bookmarks. Counted as nodes it was 30 of 240, well under 60%.
    let info: BulkDeleteBlock | undefined;
    await importBookmarks(payload([], tombstonesFor(30)), "merge", "lww", 60, 0, (i) => { info = i; });

    expect((await localUrls()).length).toBe(240);
    expect(info).toMatchObject({ blocked: 30, localTotal: 41, cap: 24, recent: 0 });
  });

  it("counts a bookmark held in many copies once when deleting it", async () => {
    await seedMany(30);
    for (let i = 0; i < 50; i++) await seed("New Tab", "neo://newtab/");

    // One bookmark deleted on the peer. Counted as nodes it was 50 of 80, over the cap of
    // 48, and the user was asked to approve deleting "50 bookmarks" that were one.
    await importBookmarks(payload([], [{ url: "neo://newtab/", deletedAt: 9e15 }]), "merge", "lww");

    expect((await localUrls()).length).toBe(30);
  });

  it("refuses to spend an approval on a deletion bigger than the one approved", async () => {
    await seedMany(100);
    // The user saw and approved 70. What turned up is 98, which nobody approved.
    await importBookmarks(payload([], tombstonesFor(98)), "merge", "lww", 95, 70);

    expect((await localUrls()).length).toBe(100);
  });

  it("ignores the stored approval latch entirely — the engine owns its lifetime", async () => {
    // The regression this guards: the merge used to read the latch itself, and only when
    // it was already over the cap, so it could not clear one it never read. An approval
    // armed for a sync that then failed before any over-cap merge stayed in storage and
    // cashed out silently against an unrelated deletion later. The lifetime now belongs to
    // the sync (see `bulkApprovedThisSync`), and this function must not consult storage at
    // all — so a latch sitting there while nothing is passed in changes nothing.
    await seedMany(100);
    await setBulkDeleteApproval(98);

    await importBookmarks(payload([], tombstonesFor(98)), "merge", "lww", 95);

    expect((await localUrls()).length).toBe(100);
    // Untouched, not consumed: this function neither reads nor clears it any more.
    expect(await getBulkDeleteApproval()).toBe(98);
  });

  /** The retained log, which is what Settings → Activity shows. `info` never reaches it. */
  async function auditText(): Promise<string> {
    await new Promise((r) => setTimeout(r, 0)); // the logger fires appendAudit unawaited
    const r = await chrome.storage.local.get(KEYS.AUDIT_LOG);
    return JSON.stringify(r[KEYS.AUDIT_LOG] ?? []);
  }

  it("keeps a merge that changed nothing out of the Activity log entirely", async () => {
    // Issue #20. Both lines were retained, and the guard re-evaluates the same deletion on
    // every sync, because the peer's tombstones live 90 days and the bookmarks are all
    // still here after we refused to remove them. That was ~120 identical entries an hour in a
    // 200-entry ring: the warning evicting the warning the banner sends people to read.
    await seedMany(100);

    await importBookmarks(payload([], tombstonesFor(70)), "merge", "lww", 60);
    await importBookmarks(payload([], tombstonesFor(70)), "merge", "lww", 60);

    const audit = await auditText();
    expect(audit).not.toContain("Merged +");
    expect(audit).not.toContain("exceeds the mass-delete guard");
  });
});

describe("importBookmarks — URL edit (no duplicate)", () => {
  it("tombstones the replaced url on edit so a peer doesn't resurrect it", async () => {
    // Capture the onChanged listener the handler registers (the fake's is a no-op).
    let onChanged: ((id: string, info: { title: string; url?: string }) => void) | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (chrome.bookmarks.onChanged as any).addListener = (cb: never) => { onChanged = cb; };
    registerBookmarkListeners(() => {});

    // Local: create A, then export — this snapshots the tree into konode_bm_cache,
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
    // The peer deleted X, so its tree no longer lists it — what it still carries is the
    // emptied "Gone" shell (a peer from before empty folders were pruned on the way out).
    // A peer that BOTH tombstones X and still advertises it is the shape Step A now
    // refuses to act on, so a payload built that way would test the guard, not the folder.
    await importBookmarks(
      payload([folder("Gone", [])], [{ url: "https://x.com", deletedAt: future }]),
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

describe("importBookmarks — bookmark reposition placement (anchor-based)", () => {
  it("places a moved bookmark after its peer's neighbor, not at the peer's absolute index", async () => {
    // Local order differs from the peer's, so an absolute index would misplace X.
    await seed("B", "https://b.com"); // idx 0
    await seed("A", "https://a.com"); // idx 1
    await seed("X", "https://m.com"); // idx 2  ← the one that moves
    await seed("C", "https://c.com"); // idx 3

    // Peer bar is [A, B, X]: X sits immediately AFTER B (anchor prev = B). Its absolute
    // index on the peer is 2 — applied blindly that would drop X after A (→ [B,A,X,C]).
    const future = Date.now() + 60_000;
    const p: BookmarkPayload = {
      ...payload([
        link("A", "https://a.com"),
        link("B", "https://b.com"),
        link("X", "https://m.com"),
      ]),
      moves: [{ url: "https://m.com", at: future }],
    };
    await importBookmarks(p, "merge", "lww");

    const order = (await chrome.bookmarks.getChildren("1")).map((c) => c.title);
    expect(order).toEqual(["B", "X", "A", "C"]); // X anchored right after B, not by index
  });
});

describe("importBookmarks — folder repositions", () => {
  async function seedFolderWithLink(title: string, url: string): Promise<void> {
    const f = await chrome.bookmarks.create({ parentId: "1", title });
    await chrome.bookmarks.create({ parentId: f.id, title, url });
  }

  it("repositions a folder to the peer's index when the peer's folder-move is newer (lww)", async () => {
    await seedFolderWithLink("A", "https://a.com");   // idx 0
    await seedFolderWithLink("Docs", "https://g.com");  // idx 1
    await seedFolderWithLink("B", "https://b.com");   // idx 2

    // Peer reordered Docs to the front (index 0) with a newer folder-move; its tree
    // carries no bookmark changes, so only the reposition should apply.
    const future = Date.now() + 60_000;
    const p: BookmarkPayload = {
      ...payload([]),
      folderMoves: [{ path: ["bar", "Docs"], index: 0, at: future }],
    };
    await importBookmarks(p, "merge", "lww");

    const order = (await chrome.bookmarks.getChildren("1")).filter((c) => !c.url).map((c) => c.title);
    expect(order).toEqual(["Docs", "A", "B"]);
    expect(await localUrls()).toEqual(["https://a.com", "https://b.com", "https://g.com"]); // no churn
  });

  it.each(["lww", "prefer-remote"] as const)(
    "keeps the loose bookmarks a peer moved a folder in front of in their order (%s, QA AX 4)",
    async (strategy) => {
      // Found headless with two Chromium profiles, and the same on 1.4.0. Prefer Remote
      // re-places every bookmark by its peer anchor, and s0's anchor is the folder the peer
      // moved in front of it, which here was still at the end of the bar: with the reposition
      // only after the fold, s0, s1 and s2 followed that folder to the end.
      for (const s of ["s0", "s1", "s2"]) await seed(s, `https://${s}.example/`);
      await seedFolderWithLink("Docs", "https://h.example/");
      await seedFolderWithLink("Other", "https://i.example/");

      const p: BookmarkPayload = {
        ...payload([
          folder("Other", [link("Other", "https://i.example/")]),
          link("s0", "https://s0.example/"), link("s1", "https://s1.example/"), link("s2", "https://s2.example/"),
          folder("Docs", [link("Docs", "https://h.example/")]),
        ]),
        folderMoves: [{ path: ["bar", "Other"], index: 0, at: Date.now() + 60_000, next: "u:https://s0.example/" }],
      };
      await importBookmarks(p, "merge", strategy);

      const order = (await chrome.bookmarks.getChildren("1")).map((c) => c.title);
      expect(order).toEqual(["Other", "s0", "s1", "s2", "Docs"]);
      // And the Activity line says what happened: one folder moved, no bookmark. Read from a
      // snapshot taken before the folder moved, s0 to s2 counted as "moved 3" while staying put.
      await new Promise((r) => setTimeout(r, 0)); // logger fires appendAudit unawaited
      const entries = ((await chrome.storage.local.get(KEYS.AUDIT_LOG))[KEYS.AUDIT_LOG] ?? []) as { detail?: string }[];
      const summary = entries.map((e) => e.detail).find((d) => d?.startsWith("Merged "));
      expect(summary).toContain("moved 0 /");
      expect(summary).toContain("folders 1 /");
    },
  );

  it("does NOT reposition a folder without a newer folder-move (stale record)", async () => {
    await seedFolderWithLink("A", "https://a.com");
    await seedFolderWithLink("Docs", "https://g.com");

    const past = Date.now() - 60_000; // older than any local move → loses lww
    const p: BookmarkPayload = { ...payload([]), folderMoves: [{ path: ["bar", "Docs"], index: 0, at: past }] };
    // Seed a NEWER local folder-move for the same path so the peer's record loses.
    const { setFolderMoves } = await import("@/lib/utils/storage");
    await setFolderMoves([{ path: ["bar", "Docs"], index: 1, at: Date.now() }]);
    await importBookmarks(p, "merge", "lww");

    const order = (await chrome.bookmarks.getChildren("1")).filter((c) => !c.url).map((c) => c.title);
    expect(order).toEqual(["A", "Docs"]); // unchanged
  });

  it("prefer-local ignores the peer's folder reposition", async () => {
    await seedFolderWithLink("A", "https://a.com");
    await seedFolderWithLink("Docs", "https://g.com");

    const future = Date.now() + 60_000;
    const p: BookmarkPayload = { ...payload([]), folderMoves: [{ path: ["bar", "Docs"], index: 0, at: future }] };
    await importBookmarks(p, "merge", "prefer-local");

    const order = (await chrome.bookmarks.getChildren("1")).filter((c) => !c.url).map((c) => c.title);
    expect(order).toEqual(["A", "Docs"]); // local placement wins
  });

  it("positions a repositioned folder after the peer's shared anchor, not by absolute index", async () => {
    // Local bar leads with a device-local folder ("Dev") the peer lacks, so absolute
    // indices differ across devices (the real bug: Docs at index 7 on one, 6 on the
    // other). Local order: Dev, News, Docs, Media.
    await chrome.bookmarks.create({ parentId: "1", title: "Dev" });
    await chrome.bookmarks.create({ parentId: "1", title: "News" });
    await chrome.bookmarks.create({ parentId: "1", title: "Docs" });
    await chrome.bookmarks.create({ parentId: "1", title: "Media" });

    // Peer moved Docs to sit immediately AFTER Media (anchor prev = f:Media). The
    // absolute index is deliberately wrong (0) to prove the anchor drives placement.
    const future = Date.now() + 60_000;
    const p: BookmarkPayload = {
      ...payload([]),
      folderMoves: [{ path: ["bar", "Docs"], index: 0, at: future, prev: "f:Media" }],
    };
    await importBookmarks(p, "merge", "lww");

    const order = (await chrome.bookmarks.getChildren("1")).map((c) => c.title);
    expect(order).toEqual(["Dev", "News", "Media", "Docs"]); // Docs after Media, last
  });

  it("falls back to the `next` anchor when `prev` is absent locally", async () => {
    await chrome.bookmarks.create({ parentId: "1", title: "News" });
    await chrome.bookmarks.create({ parentId: "1", title: "Docs" });
    await chrome.bookmarks.create({ parentId: "1", title: "Media" });

    // Peer's prev anchor ("f:DeviceOnly") doesn't exist here, but next ("f:Media") does
    // → Docs lands immediately before Media.
    const future = Date.now() + 60_000;
    const p: BookmarkPayload = {
      ...payload([]),
      folderMoves: [{ path: ["bar", "Docs"], index: 9, at: future, prev: "f:DeviceOnly", next: "f:Media" }],
    };
    await importBookmarks(p, "merge", "lww");

    const order = (await chrome.bookmarks.getChildren("1")).map((c) => c.title);
    expect(order).toEqual(["News", "Docs", "Media"]); // before Media
  });

  it("converges a move to the LAST position under Chromium's pre-removal convention", async () => {
    // The setup fake uses Firefox's final-index convention, so the nudge path never
    // runs against it. Wrap `move` to emulate Chromium: a same-parent `index` is
    // measured against the pre-removal array, so a downward move lands one short.
    // Regression: the nudge clamped to kids.length-1, re-requesting the index that
    // already fell short — a move to the last slot ping-ponged one-off forever.
    const realMove = chrome.bookmarks.move.bind(chrome.bookmarks);
    chrome.bookmarks.move = (async (id: string, dest: { parentId?: string; index?: number }) => {
      const node = (await chrome.bookmarks.get(id))[0];
      if (typeof dest.index === "number" && (dest.parentId ?? node.parentId) === node.parentId) {
        const sibs = await chrome.bookmarks.getChildren(node.parentId!);
        const orig = sibs.findIndex((c) => c.id === id);
        const capped = Math.min(dest.index, sibs.length); // Chromium accepts index = count
        return realMove(id, { ...dest, index: orig < capped ? capped - 1 : capped });
      }
      return realMove(id, dest);
    }) as typeof chrome.bookmarks.move;
    try {
      await chrome.bookmarks.create({ parentId: "1", title: "Docs" });
      await chrome.bookmarks.create({ parentId: "1", title: "News" });
      await chrome.bookmarks.create({ parentId: "1", title: "Media" });

      // Peer moved Docs to the END of the bar (prev anchor = f:Media, the last sibling).
      const future = Date.now() + 60_000;
      const p: BookmarkPayload = {
        ...payload([]),
        folderMoves: [{ path: ["bar", "Docs"], index: 2, at: future, prev: "f:Media" }],
      };
      await importBookmarks(p, "merge", "lww");

      const order = (await chrome.bookmarks.getChildren("1")).map((c) => c.title);
      expect(order).toEqual(["News", "Media", "Docs"]); // Docs actually reaches the last slot
    } finally {
      chrome.bookmarks.move = realMove;
    }
  });

  it("prunes the empty shell left when a cross-parent bookmark move empties a folder", async () => {
    // Local: X lives in "Old". The peer moved X into "New" (different parent).
    const old = await chrome.bookmarks.create({ parentId: "1", title: "Old" });
    await chrome.bookmarks.create({ parentId: old.id, title: "X", url: "https://x.com" });

    const future = Date.now() + 60_000;
    const p: BookmarkPayload = {
      ...payload([folder("New", [link("X", "https://x.com")])]),
      moves: [{ url: "https://x.com", at: future }],
    };
    await importBookmarks(p, "merge", "lww");

    const barFolders = (await chrome.bookmarks.getChildren("1")).filter((c) => !c.url).map((c) => c.title);
    expect(barFolders).toEqual(["New"]);       // "Old" shell pruned
    expect(await localUrls()).toEqual(["https://x.com"]); // X relocated, no duplicate
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

describe("importBookmarks — canonical URL dedup (bare-origin trailing slash across engines)", () => {
  it("does NOT re-add a bare-origin bookmark when the peer's form omits the trailing slash", async () => {
    // Local holds the Chromium/Firefox form; the peer (WebKit/Orion) stored it
    // without the trailing slash. Keying on the raw string duplicated it every
    // sync (seen live: telex.hu accumulating). Canonical keying must dedup them.
    await seed("Telex", "https://telex.hu/");
    await importBookmarks(payload([link("Telex", "https://telex.hu")]), "merge", "lww");
    const urls = await localUrls();
    expect(urls.filter((u) => u.includes("telex.hu"))).toEqual(["https://telex.hu/"]);
  });

  it("also dedups the reverse (local has no slash, peer has one)", async () => {
    await seed("Telex", "https://telex.hu");
    await importBookmarks(payload([link("Telex", "https://telex.hu/")]), "merge", "lww");
    expect((await localUrls()).filter((u) => u.includes("telex.hu")).length).toBe(1);
  });

  it("does NOT over-merge distinct PATHS (only the empty root path is canonicalized)", async () => {
    await seed("A", "https://site.com/a");
    await importBookmarks(payload([link("B", "https://site.com/b")]), "merge", "lww");
    const urls = await localUrls();
    expect(urls).toContain("https://site.com/a");
    expect(urls).toContain("https://site.com/b");
  });
});

describe("renames reach the other devices", () => {
  // The merge had three verbs — CREATE, MOVE, REMOVE — and no UPDATE. Once a peer's
  // bookmark matched a local URL the merge treated it as satisfied and returned without
  // ever comparing titles, so a rename travelled in every packet and was discarded on
  // arrival by every device. Folders were worse: their identity IS their title, so a
  // renamed folder read as an unrelated folder to everyone else.
  //
  // What was missing was never the title (the tree always carried it) but a TIMESTAMP —
  // any basis for deciding whose title is newer. These two logs supply exactly that.

  const NOW = Date.now();
  const titled = (url: string, title: string, at: number): BookmarkPayload["titles"] =>
    [{ url, title, at }];

  async function titleOf(url: string): Promise<string | undefined> {
    const all = await chrome.bookmarks.getTree();
    let found: string | undefined;
    const walk = (n: chrome.bookmarks.BookmarkTreeNode): void => {
      if (n.url === url) found = n.title;
      n.children?.forEach(walk);
    };
    all.forEach(walk);
    return found;
  }

  async function folderTitles(parentId = "1"): Promise<string[]> {
    return (await chrome.bookmarks.getChildren(parentId)).filter((c) => !c.url).map((c) => c.title);
  }

  /** Registers the real listeners and hands back the onChanged the handler installed. */
  function captureOnChanged(): (id: string, info: { title: string; url?: string }) => void {
    let cb: ((id: string, info: { title: string; url?: string }) => void) | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (chrome.bookmarks.onChanged as any).addListener = (fn: never) => { cb = fn; };
    registerBookmarkListeners(() => {});
    return (id, info) => cb!(id, info);
  }

  it("applies a peer's bookmark rename to the copy we already have", async () => {
    await seed("Old name", "https://a.com");

    await importBookmarks(
      { ...payload([link("New name", "https://a.com")]), titles: titled("https://a.com", "New name", NOW) },
      "merge", "lww"
    );

    expect(await titleOf("https://a.com")).toBe("New name");
    expect(await localUrls()).toEqual(["https://a.com"]); // renamed, not duplicated
  });

  it("does NOT overwrite a title when nobody actually renamed anything", async () => {
    // Two devices can hold the same URL under different titles with no rename involved —
    // one of them just typed it differently when bookmarking. Acting on that would make
    // the two trade titles back and forth on every cycle, forever.
    await seed("My name for it", "https://a.com");

    await importBookmarks(payload([link("Their name for it", "https://a.com")]), "merge", "lww");

    expect(await titleOf("https://a.com")).toBe("My name for it");
  });

  it("keeps OUR rename when it is the newer one", async () => {
    const onChanged = captureOnChanged();
    const a = await chrome.bookmarks.create({ parentId: "1", title: "Old", url: "https://a.com" });
    await exportBookmarkPayload();
    await chrome.bookmarks.update(a.id, { title: "Mine" });
    onChanged(a.id, { title: "Mine" });
    await new Promise((r) => setTimeout(r, 0));

    await importBookmarks(
      { ...payload([link("Theirs", "https://a.com")]), titles: titled("https://a.com", "Theirs", NOW - 60_000) },
      "merge", "lww"
    );

    expect(await titleOf("https://a.com")).toBe("Mine");
  });

  it("takes THEIR rename when it is the newer one", async () => {
    const onChanged = captureOnChanged();
    const a = await chrome.bookmarks.create({ parentId: "1", title: "Old", url: "https://a.com" });
    await exportBookmarkPayload();
    await chrome.bookmarks.update(a.id, { title: "Mine" });
    onChanged(a.id, { title: "Mine" });
    await new Promise((r) => setTimeout(r, 0));

    await importBookmarks(
      { ...payload([link("Theirs", "https://a.com")]), titles: titled("https://a.com", "Theirs", Date.now() + 60_000) },
      "merge", "lww"
    );

    expect(await titleOf("https://a.com")).toBe("Theirs");
  });

  it("prefer-local never adopts a peer's rename", async () => {
    await seed("Mine", "https://a.com");

    await importBookmarks(
      { ...payload([link("Theirs", "https://a.com")]), titles: titled("https://a.com", "Theirs", Date.now() + 60_000) },
      "merge", "prefer-local"
    );

    expect(await titleOf("https://a.com")).toBe("Mine");
  });

  it("renames a folder in place instead of leaving two of them", async () => {
    // A folder has no cross-device id, so a rename used to read as "an unrelated folder
    // appeared": the fold matched folders by title, found nothing called Job, and created
    // it alongside the one the user had renamed.
    const f = await chrome.bookmarks.create({ parentId: "1", title: "Work" });
    await chrome.bookmarks.create({ parentId: f.id, title: "A", url: "https://a.com" });

    await importBookmarks(
      {
        ...payload([folder("Job", [link("A", "https://a.com")])]),
        folderRenames: [{ path: ["bar"], from: "Work", to: "Job", at: NOW }],
      },
      "merge", "lww"
    );

    expect(await folderTitles()).toEqual(["Job"]);
    expect(await localUrls()).toEqual(["https://a.com"]); // the bookmark stayed put
  });

  it("a folder rename lands before the fold, so new bookmarks go into the renamed folder", async () => {
    // Order matters: if the fold ran first it would match on the OLD name, create a
    // duplicate, and the rename would then collide with it.
    const f = await chrome.bookmarks.create({ parentId: "1", title: "Work" });
    await chrome.bookmarks.create({ parentId: f.id, title: "A", url: "https://a.com" });

    await importBookmarks(
      {
        ...payload([folder("Job", [link("A", "https://a.com"), link("B", "https://b.com")])]),
        folderRenames: [{ path: ["bar"], from: "Work", to: "Job", at: NOW }],
      },
      "merge", "lww"
    );

    expect(await folderTitles()).toEqual(["Job"]);
    const kids = await chrome.bookmarks.getChildren(f.id);
    expect(kids.map((k) => k.url).sort()).toEqual(["https://a.com", "https://b.com"]);
  });

  it("ignores a folder rename whose path doesn't exist here", async () => {
    // Same fail-safe rule as the folder-reposition step: an unresolvable path is skipped,
    // never guessed at.
    await seed("A", "https://a.com");

    await importBookmarks(
      {
        ...payload([link("A", "https://a.com")]),
        folderRenames: [{ path: ["bar", "Nowhere"], from: "Work", to: "Job", at: NOW }],
      },
      "merge", "lww"
    );

    expect(await folderTitles()).toEqual([]);
  });

  it("a peer on an older build sends neither log, and nothing breaks", async () => {
    // Both fields are optional. A packet without them must read as "nobody renamed
    // anything", not as an empty rename that wipes a title.
    await seed("Mine", "https://a.com");

    await importBookmarks(payload([link("Mine", "https://a.com")]), "merge", "lww");
    await importBookmarks([link("Mine", "https://a.com")], "merge", "lww"); // legacy bare array

    expect(await titleOf("https://a.com")).toBe("Mine");
  });

  it("puts both renames into the payload it publishes", async () => {
    const onChanged = captureOnChanged();
    const f = await chrome.bookmarks.create({ parentId: "1", title: "Work" });
    const a = await chrome.bookmarks.create({ parentId: f.id, title: "Old", url: "https://a.com" });
    await exportBookmarkPayload(); // snapshots the cache — the folder's OLD name lives here

    await chrome.bookmarks.update(a.id, { title: "New" });
    onChanged(a.id, { title: "New" });
    await chrome.bookmarks.update(f.id, { title: "Job" });
    onChanged(f.id, { title: "Job" });
    await new Promise((r) => setTimeout(r, 0));

    const out = await exportBookmarkPayload();
    expect(out.titles?.map((t) => t.title)).toEqual(["New"]);
    expect(out.folderRenames?.map((r) => `${r.from}->${r.to}`)).toEqual(["Work->Job"]);
  });
});

describe("renames and repositions of folders that share a name (#51)", () => {
  // A folder rename or reposition is filed under the folder's path, and the receiver took
  // the first folder of that name under the parent. With several unnamed folders, renaming
  // the second one renamed the first one everywhere else. A record now carries a bookmark
  // the folder held (`holds`) when it has same-named siblings, and the receiver goes by it.

  const A = "https://a.com/";
  const C = "https://c.com/";

  /** The bar as "title" for a bookmark and "[title] children" for a folder. */
  async function bar(): Promise<string[]> {
    return Promise.all((await chrome.bookmarks.getChildren("1")).map(async (c) =>
      c.url ? c.title : `[${c.title}] ${(await chrome.bookmarks.getChildren(c.id)).map((k) => k.title).join(",")}`
    ));
  }

  /** Two unnamed folders on the bar, A in the first and C in the second. */
  async function twins(): Promise<[string, string]> {
    const first = await chrome.bookmarks.create({ parentId: "1", title: "" });
    await chrome.bookmarks.create({ parentId: first.id, title: "A", url: A });
    const second = await chrome.bookmarks.create({ parentId: "1", title: "" });
    await chrome.bookmarks.create({ parentId: second.id, title: "C", url: C });
    return [first.id, second.id];
  }

  /** Registers the real listeners and hands back the ones the handler installed. */
  function capture(): {
    changed: (id: string, info: { title: string }) => void;
    moved: (id: string, info: chrome.bookmarks.BookmarkMoveInfo) => void;
  } {
    const l: { changed?: (...a: never[]) => void; moved?: (...a: never[]) => void } = {};
    /* eslint-disable @typescript-eslint/no-explicit-any */
    (chrome.bookmarks.onChanged as any).addListener = (fn: never) => { l.changed = fn; };
    (chrome.bookmarks.onMoved as any).addListener = (fn: never) => { l.moved = fn; };
    /* eslint-enable @typescript-eslint/no-explicit-any */
    registerBookmarkListeners(() => {});
    return {
      changed: (id, info) => (l.changed as (i: string, c: { title: string }) => void)(id, info),
      moved: (id, info) => (l.moved as (i: string, m: chrome.bookmarks.BookmarkMoveInfo) => void)(id, info),
    };
  }
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it("marks a rename with a bookmark of the folder when it has same-named siblings, and only then", async () => {
    const on = capture();
    const [, second] = await twins();
    const work = await chrome.bookmarks.create({ parentId: "1", title: "Work" });
    await chrome.bookmarks.create({ parentId: work.id, title: "W", url: "https://w.com/" });
    await exportBookmarkPayload(); // the last synced state: what the peers still hold

    await chrome.bookmarks.update(second, { title: "Dev" });
    on.changed(second, { title: "Dev" });
    await chrome.bookmarks.update(work.id, { title: "Job" });
    on.changed(work.id, { title: "Job" });
    await settle();

    const renames = (await exportBookmarkPayload()).folderRenames ?? [];
    expect(renames.map((r) => [r.from, r.to, r.holds])).toEqual([["", "Dev", C], ["Work", "Job", undefined]]);
  });

  it("records the rename of an unnamed folder at all", async () => {
    // Its old title is "", which the recorder took for no title and dropped the rename.
    const on = capture();
    const f = await chrome.bookmarks.create({ parentId: "1", title: "" });
    await chrome.bookmarks.create({ parentId: f.id, title: "A", url: A });
    await exportBookmarkPayload();

    await chrome.bookmarks.update(f.id, { title: "Dev" });
    on.changed(f.id, { title: "Dev" });
    await settle();

    const renames = (await exportBookmarkPayload()).folderRenames ?? [];
    expect(renames.map((r) => [r.from, r.to, r.holds])).toEqual([["", "Dev", undefined]]);
  });

  it("keeps both renames when two same-named folders are renamed", async () => {
    const on = capture();
    const [first, second] = await twins();
    await exportBookmarkPayload();

    await chrome.bookmarks.update(first, { title: "Work" });
    on.changed(first, { title: "Work" });
    await settle();
    await chrome.bookmarks.update(second, { title: "Dev" });
    on.changed(second, { title: "Dev" });
    await settle();

    const renames = (await exportBookmarkPayload()).folderRenames ?? [];
    expect(renames.map((r) => `${r.from}->${r.to}`).sort()).toEqual(["->Dev", "->Work"]);
  });

  it("renames the folder the record marks, not the first one of that name", async () => {
    await twins();

    await importBookmarks({
      ...payload([folder("", [link("A", A)]), folder("Dev", [link("C", C)])]),
      folderRenames: [{ path: ["bar"], from: "", to: "Dev", at: Date.now(), holds: C }],
    }, "merge", "lww");

    expect(await bar()).toEqual(["[] A", "[Dev] C"]);
  });

  it("does not pass the rename on to the sibling that kept the name, sync after sync", async () => {
    // prefer-remote replays a peer's renames on every sync, and the first folder of the old
    // name was there for the taking each time, until every one of them had the new name.
    // The folders themselves, by id: prefer-remote also moves bookmarks after the peer, which
    // would put A and C back where they belong in whatever folders were left.
    const [first, second] = await twins();
    const p: BookmarkPayload = {
      ...payload([folder("", [link("A", A)]), folder("Dev", [link("C", C)])]),
      folderRenames: [{ path: ["bar"], from: "", to: "Dev", at: Date.now(), holds: C }],
    };

    await importBookmarks(p, "merge", "prefer-remote");
    await importBookmarks(p, "merge", "prefer-remote");

    const title = async (id: string) => (await chrome.bookmarks.get(id))[0]?.title;
    expect([await title(first), await title(second)]).toEqual(["", "Dev"]);
    expect(await bar()).toEqual(["[] A", "[Dev] C"]);
  });

  it("renames nothing when no folder holds the mark and it can't tell which one was meant", async () => {
    await twins();

    await importBookmarks({
      ...payload([folder("", [link("A", A)]), folder("", [link("C", C)])]),
      folderRenames: [{ path: ["bar"], from: "", to: "Dev", at: Date.now(), holds: "https://gone.com/" }],
    }, "merge", "lww");

    expect(await bar()).toEqual(["[] A", "[] C"]);
  });

  it("marks a reposition, and moves the folder the record marks", async () => {
    const on = capture();
    const [, second] = await twins();
    await exportBookmarkPayload();
    await chrome.bookmarks.move(second, { parentId: "1", index: 0 });
    on.moved(second, { parentId: "1", oldParentId: "1", index: 0, oldIndex: 1 });
    await settle();
    const out = await exportBookmarkPayload();
    expect(out.folderMoves?.map((r) => [r.path.join("/"), r.holds])).toEqual([["bar/", C]]);

    // The other device still has them the old way round.
    const { setFolderMoves, setMoves } = await import("@/lib/utils/storage");
    await chrome.bookmarks.removeTree(second);
    const [first] = (await chrome.bookmarks.getChildren("1")).filter((c) => !c.url);
    await chrome.bookmarks.removeTree(first.id);
    await setFolderMoves([]);
    await setMoves([]);
    await twins();

    await importBookmarks({
      ...payload([folder("", [link("C", C)]), folder("", [link("A", A)])]),
      folderMoves: (out.folderMoves ?? []).map((r) => ({ ...r, at: Date.now() + 60_000 })),
    }, "merge", "lww");

    expect(await bar()).toEqual(["[] C", "[] A"]);
  });
});

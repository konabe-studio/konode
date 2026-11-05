import { describe, it, expect } from "vitest";
import { CONFLICT_SAMPLE_SIZE, diffBookmarks, diffHistory } from "@/lib/sync/conflict-diff";
import type { BookmarkPayload, SyncBookmark, SyncHistoryItem } from "@/lib/types";

// #35: a Manual conflict card asked "Keep local or Use remote?" and showed nothing of either
// version. These are the lists Settings → Activity now shows under it.

let seq = 0;
const bm = (title: string, url: string): SyncBookmark =>
  ({ id: String(++seq), parentId: null, title, url, dateAdded: 1 });
const dir = (title: string, children: SyncBookmark[]): SyncBookmark =>
  ({ id: String(++seq), parentId: null, title, dateAdded: 1, children });
const root = (id: string, title: string, children: SyncBookmark[]): SyncBookmark =>
  ({ id, parentId: "0", title, dateAdded: 0, children });
const payload = (roots: SyncBookmark[]): BookmarkPayload => ({
  tree: [{ id: "0", parentId: null, title: "", dateAdded: 0, children: roots }],
  tombstones: [],
});
/** A Chrome tree: bar, other, mobile. */
const chrome = (bar: SyncBookmark[], other: SyncBookmark[] = []) =>
  payload([root("1", "Bookmarks bar", bar), root("2", "Other bookmarks", other), root("3", "Mobile bookmarks", [])]);
/** The peer as the engine hands it over: its tree, exclusions already applied. */
const tree = (p: BookmarkPayload) => p.tree;

const visit = (url: string, lastVisitTime: number, title = ""): SyncHistoryItem =>
  ({ url, title, lastVisitTime, visitCount: 1 });

describe("diffBookmarks", () => {
  it("splits what only the peer has from what only this device has", () => {
    const local = chrome([bm("Docs", "https://docs.example/"), bm("Mine", "https://mine.example/")]);
    const remote = chrome([bm("Docs", "https://docs.example/"), bm("Theirs", "https://theirs.example/")]);

    const d = diffBookmarks(local, tree(remote));

    expect(d.only_remote).toEqual({ total: 1, sample: [{ title: "Theirs", url: "https://theirs.example/" }] });
    expect(d.only_local).toEqual({ total: 1, sample: [{ title: "Mine", url: "https://mine.example/" }] });
    expect(d.changed).toBe(0);
  });

  it("finds nothing between two browsers holding the same bookmarks under differently named roots", () => {
    const onChrome = chrome([bm("Docs", "https://docs.example/")]);
    const onFirefox = payload([
      root("menu________", "Lesezeichen-Menü", []),
      root("toolbar_____", "Lesezeichen-Symbolleiste", [bm("Docs", "https://docs.example")]),
      root("unfiled_____", "Weitere Lesezeichen", []),
    ]);

    // The address is compared canonically too: "https://docs.example" is the same page.
    expect(diffBookmarks(onChrome, tree(onFirefox))).toEqual({
      only_remote: { total: 0, sample: [] },
      only_local: { total: 0, sample: [] },
      changed: 0,
    });
  });

  it("counts a bookmark both have, renamed or in another folder, as changed rather than listing it twice", () => {
    const local = chrome([bm("Docs", "https://docs.example/"), bm("Wiki", "https://wiki.example/")]);
    const remote = chrome([bm("Documentation", "https://docs.example/"), dir("Work", [bm("Wiki", "https://wiki.example/")])]);

    const d = diffBookmarks(local, tree(remote));

    expect(d.only_remote.total).toBe(0);
    expect(d.only_local.total).toBe(0);
    expect(d.changed).toBe(2);
  });

  it("lists a bookmark held twice on one side once", () => {
    const local = chrome([]);
    const remote = chrome([bm("Docs", "https://docs.example/")], [bm("Docs", "https://docs.example/")]);

    expect(diffBookmarks(local, tree(remote)).only_remote).toEqual({
      total: 1, sample: [{ title: "Docs", url: "https://docs.example/" }],
    });
  });

  it("caps the list but not the count, in tree order", () => {
    const many = Array.from({ length: 53 }, (_, i) => bm(`Page ${i}`, `https://p${i}.example/`));
    const d = diffBookmarks(chrome([]), tree(chrome(many)));

    expect(d.only_remote.total).toBe(53);
    expect(d.only_remote.sample).toHaveLength(CONFLICT_SAMPLE_SIZE);
    expect(d.only_remote.sample[0].title).toBe("Page 0");
  });

  it("skips a node marked deleted", () => {
    const gone = { ...bm("Gone", "https://gone.example/"), _deleted: true };
    const local = chrome([gone, bm("Docs", "https://docs.example/")]);
    const remote = chrome([bm("Docs", "https://docs.example/")]);

    expect(diffBookmarks(local, tree(remote))).toEqual({
      only_remote: { total: 0, sample: [] },
      only_local: { total: 0, sample: [] },
      changed: 0,
    });
  });

  it("clips a huge address, which this screen only displays", () => {
    const huge = `data:text/plain,${"x".repeat(100_000)}`;
    const d = diffBookmarks(chrome([]), tree(chrome([bm("Blob", huge)])));

    expect(d.only_remote.sample[0].url.length).toBeLessThan(300);
  });
});

describe("diffHistory", () => {
  it("lists pages only one side visited, most recent first", () => {
    const local = [visit("https://both.example/", 5), visit("https://here.example/", 9, "Here")];
    const remote = [
      visit("https://old.example/", 1, "Old"),
      visit("https://both.example", 7),
      visit("https://new.example/", 8, "New"),
    ];

    const d = diffHistory(local, remote);

    expect(d.only_remote).toEqual({
      total: 2,
      sample: [{ title: "New", url: "https://new.example/" }, { title: "Old", url: "https://old.example/" }],
    });
    expect(d.only_local).toEqual({ total: 1, sample: [{ title: "Here", url: "https://here.example/" }] });
    expect(d.changed).toBe(0);
  });

  it("treats the same page with other visit times as the same page", () => {
    expect(diffHistory([visit("https://a.example/", 1)], [visit("https://a.example/", 99)])).toEqual({
      only_remote: { total: 0, sample: [] },
      only_local: { total: 0, sample: [] },
      changed: 0,
    });
  });

  it("ignores deleted entries and anything that is not a list", () => {
    const deleted = { ...visit("https://gone.example/", 3), _deleted: true };

    expect(diffHistory([], [deleted]).only_remote.total).toBe(0);
    expect(diffHistory(null, [visit("https://a.example/", 1)]).only_remote.total).toBe(1);
  });
});

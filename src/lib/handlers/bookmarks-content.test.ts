import { describe, it, expect } from "vitest";
import { bookmarkContent } from "@/lib/handlers/bookmarks-handler";
import type { BookmarkPayload, SyncBookmark } from "@/lib/types";

// #34: Manual compared the transport checksum, which two devices never share even with the
// same bookmarks on screen. bookmarkContent is what they DO share when they agree.

let seq = 0;
const bm = (title: string, url: string, dateAdded = 1): SyncBookmark =>
  ({ id: String(++seq), parentId: null, title, url, dateAdded });
const dir = (title: string, children: SyncBookmark[]): SyncBookmark =>
  ({ id: String(++seq), parentId: null, title, dateAdded: 1, children });
const root = (id: string, title: string, children: SyncBookmark[]): SyncBookmark =>
  ({ id, parentId: "0", title, dateAdded: 0, children });
const payload = (roots: SyncBookmark[], logs: Partial<BookmarkPayload> = {}): BookmarkPayload => ({
  tree: [{ id: "0", parentId: null, title: "", dateAdded: 0, children: roots }],
  tombstones: [], ...logs,
});

/** A Chrome tree: bar, other, mobile. */
const chrome = (bar: SyncBookmark[], other: SyncBookmark[] = []) =>
  payload([root("1", "Bookmarks bar", bar), root("2", "Other bookmarks", other), root("3", "Mobile bookmarks", [])]);

describe("bookmarkContent: what two devices share when their bookmarks agree", () => {
  it("ignores ids, dates and every per-device log", () => {
    const a = chrome([bm("Docs", "https://docs.example/", 1), dir("Work", [bm("Wiki", "https://wiki.example/", 2)])]);
    const b = payload(
      [
        root("1", "Bookmarks bar", [bm("Docs", "https://docs.example/", 9e12), dir("Work", [bm("Wiki", "https://wiki.example/", 9e12)])]),
        root("2", "Other bookmarks", []), root("3", "Mobile bookmarks", []),
      ],
      {
        tombstones: [{ url: "https://gone.example/", deletedAt: 5 }],
        moves: [{ url: "https://docs.example/", at: 7 }],
        titles: [{ url: "https://wiki.example/", title: "Wiki", at: 8 }],
      }
    );

    expect(bookmarkContent(b)).toBe(bookmarkContent(a));
  });

  it("puts a Chrome bar and a Firefox toolbar in one place, whatever their titles", () => {
    const onChrome = chrome([bm("Docs", "https://docs.example/")]);
    const onFirefox = payload([
      root("menu________", "Lesezeichen-Menü", []),
      root("toolbar_____", "Lesezeichen-Symbolleiste", [bm("Docs", "https://docs.example/")]),
      root("unfiled_____", "Weitere Lesezeichen", []),
      root("mobile______", "Mobile Lesezeichen", []),
    ]);

    expect(bookmarkContent(onFirefox)).toBe(bookmarkContent(onChrome));
  });

  it("counts Firefox's Bookmarks Menu as Other bookmarks, where it lands on a browser without one", () => {
    const onFirefox = payload([
      root("menu________", "Bookmarks Menu", [dir("Recipes", [bm("Soup", "https://soup.example/")])]),
      root("toolbar_____", "Bookmarks Toolbar", []),
      root("unfiled_____", "Other Bookmarks", []),
    ]);
    const onChrome = chrome([], [dir("Recipes", [bm("Soup", "https://soup.example/")])]);

    expect(bookmarkContent(onFirefox)).toBe(bookmarkContent(onChrome));
  });

  it("ignores the order of siblings, which the merge does not converge", () => {
    const a = chrome([bm("A", "https://a.example/"), bm("B", "https://b.example/")]);
    const b = chrome([bm("B", "https://b.example/"), bm("A", "https://a.example/")]);

    expect(bookmarkContent(b)).toBe(bookmarkContent(a));
  });

  it("reads a URL the way the merge matches it, so a bare origin with or without its slash is one", () => {
    const a = chrome([bm("Telex", "https://telex.hu/")]);
    const b = chrome([bm("Telex", "https://telex.hu")]);

    expect(bookmarkContent(b)).toBe(bookmarkContent(a));
  });

  it("counts a bookmark held twice in one place once", () => {
    const a = chrome([bm("A", "https://a.example/")]);
    const b = chrome([bm("A", "https://a.example/"), bm("A", "https://a.example/")]);

    expect(bookmarkContent(b)).toBe(bookmarkContent(a));
  });

  it("tells a real difference apart: a bookmark, a title, a folder, a root", () => {
    const base = chrome([dir("Work", [bm("Wiki", "https://wiki.example/")])]);
    const differ = [
      chrome([dir("Work", [bm("Wiki", "https://wiki.example/"), bm("New", "https://new.example/")])]),
      chrome([dir("Work", [bm("Wiki renamed", "https://wiki.example/")])]),
      chrome([dir("Home", [bm("Wiki", "https://wiki.example/")])]),
      chrome([], [dir("Work", [bm("Wiki", "https://wiki.example/")])]),
      chrome([]),
    ];

    for (const other of differ) expect(bookmarkContent(other)).not.toBe(bookmarkContent(base));
  });

  it("reads the legacy bare-array payload the same as the envelope", () => {
    const envelope = chrome([bm("Docs", "https://docs.example/")]);

    expect(bookmarkContent(envelope.tree)).toBe(bookmarkContent(envelope));
  });
});

import { describe, it, expect } from "vitest";
import { rootKind, rootKindFromTitle, defaultOtherRootId, matchLocalRoot, matchLocalRootEx } from "./bookmark-roots";

// Chrome numbers its roots; Firefox uses stable guids.
const CHROME_ROOTS = [
  { id: "1", title: "Bookmarks bar" },
  { id: "2", title: "Other bookmarks" },
  { id: "3", title: "Mobile bookmarks" },
];
const FIREFOX_ROOTS = [
  { id: "toolbar_____", title: "Bookmarks Toolbar" },
  { id: "menu________", title: "Bookmarks Menu" },
  { id: "unfiled_____", title: "Other Bookmarks" },
  { id: "mobile______", title: "Mobile Bookmarks" },
];

describe("rootKind", () => {
  it("maps Chrome numeric ids", () => {
    expect(rootKind("1")).toBe("bar");
    expect(rootKind("2")).toBe("other");
    expect(rootKind("3")).toBe("mobile");
  });
  it("maps Firefox guids", () => {
    expect(rootKind("toolbar_____")).toBe("bar");
    expect(rootKind("menu________")).toBe("menu");
    expect(rootKind("unfiled_____")).toBe("other");
    expect(rootKind("mobile______")).toBe("mobile");
  });
  it("returns undefined for a non-root id", () => {
    expect(rootKind("42")).toBeUndefined();
    expect(rootKind("some-node-guid")).toBeUndefined();
  });
});

describe("rootKindFromTitle (WebKit/Orion reused numeric ids)", () => {
  it("treats a 'Favorites' root as the bar (WebKit's bookmarks-bar equivalent)", () => {
    expect(rootKindFromTitle("Favorites")).toBe("bar");
    expect(rootKindFromTitle("favorites")).toBe("bar"); // case-insensitive
  });
  it("is undefined for ordinary titles", () => {
    expect(rootKindFromTitle("Mobile bookmarks")).toBeUndefined();
    expect(rootKindFromTitle(undefined)).toBeUndefined();
  });
});

// Orion (WebKit) reuses Chrome numeric ids with different meaning: id 3 = "Favorites"
// (a bar), id 2 = "Bookmarks", id 1 = "Bookmarks Bar". Confirmed from a live backend dump.
const ORION_ROOTS = [
  { id: "1", title: "Bookmarks Bar" },
  { id: "2", title: "Bookmarks" },
  { id: "3", title: "Favorites" },
];

describe("matchLocalRoot — Orion 'Favorites' root", () => {
  it("maps Orion's Favorites (id 3) to the Chrome bar, NOT mobile bookmarks", () => {
    // Without the title override, id 3 → kind mobile → Chrome's Mobile bookmarks.
    expect(matchLocalRoot(ORION_ROOTS[2], CHROME_ROOTS, 2)).toBe("1"); // → bar
    expect(matchLocalRootEx(ORION_ROOTS[2], CHROME_ROOTS, 2).confident).toBe(true);
  });
  it("still maps Chrome's real Mobile bookmarks (id 3) to mobile", () => {
    expect(matchLocalRoot(CHROME_ROOTS[2], CHROME_ROOTS, 2)).toBe("3"); // unaffected
  });
});

describe("defaultOtherRootId", () => {
  it("picks the 'other' root on Chrome", () => {
    expect(defaultOtherRootId(CHROME_ROOTS)).toBe("2");
  });
  it("picks 'unfiled' on Firefox (not the menu root)", () => {
    expect(defaultOtherRootId(FIREFOX_ROOTS)).toBe("unfiled_____");
  });
  it("falls back to the 2nd root, then the 1st, on an unknown shape", () => {
    expect(defaultOtherRootId([{ id: "a" }, { id: "b" }])).toBe("b");
    expect(defaultOtherRootId([{ id: "solo" }])).toBe("solo");
    expect(defaultOtherRootId([])).toBeUndefined();
  });
});

describe("matchLocalRoot", () => {
  it("matches by kind within the same browser", () => {
    expect(matchLocalRoot(CHROME_ROOTS[0], CHROME_ROOTS, 0)).toBe("1"); // bar
    expect(matchLocalRoot(CHROME_ROOTS[1], CHROME_ROOTS, 1)).toBe("2"); // other
  });

  it("maps a Chrome bar onto the Firefox toolbar (cross-browser by kind)", () => {
    expect(matchLocalRoot(CHROME_ROOTS[0], FIREFOX_ROOTS, 0)).toBe("toolbar_____");
    // Chrome "Other bookmarks" → Firefox unfiled, not the menu root.
    expect(matchLocalRoot(CHROME_ROOTS[1], FIREFOX_ROOTS, 1)).toBe("unfiled_____");
  });

  it("maps a Firefox toolbar onto the Chrome bar", () => {
    expect(matchLocalRoot(FIREFOX_ROOTS[0], CHROME_ROOTS, 0)).toBe("1");
  });

  it("degrades a Firefox-only menu root onto Chrome's Other bookmarks", () => {
    // No "menu" kind on Chrome, titles differ → position (index 1) then default.
    expect(matchLocalRoot(FIREFOX_ROOTS[1], CHROME_ROOTS, 1)).toBe("2");
  });

  it("falls back to title when kind/id don't resolve", () => {
    const local = [{ id: "x", title: "Reading List" }, { id: "y", title: "Work" }];
    expect(matchLocalRoot({ id: "zzz", title: "work" }, local, 5)).toBe("y");
  });

  it("falls back to position, then the default writable root", () => {
    const local = [{ id: "x" }, { id: "y" }, { id: "z" }];
    expect(matchLocalRoot({ id: "zzz" }, local, 2)).toBe("z");   // by index
    expect(matchLocalRoot({ id: "zzz" }, local, 9)).toBe("y");   // out of range → default (2nd)
  });
});

describe("matchLocalRootEx — confidence", () => {
  it("kind / id / title matches are confident", () => {
    expect(matchLocalRootEx(CHROME_ROOTS[0], FIREFOX_ROOTS, 0).confident).toBe(true); // by kind
    expect(matchLocalRootEx(CHROME_ROOTS[0], CHROME_ROOTS, 0).confident).toBe(true);  // by id/kind
    expect(matchLocalRootEx({ id: "zzz", title: "work" }, [{ id: "y", title: "Work" }], 5).confident).toBe(true); // by title
  });
  it("position / default fallback is NOT confident", () => {
    const r = matchLocalRootEx({ id: "zzz" }, [{ id: "x" }, { id: "y" }, { id: "z" }], 2);
    expect(r.id).toBe("z");        // still resolves (by position)
    expect(r.confident).toBe(false);
  });
  it("a Firefox-only menu root on Chrome is not a confident match", () => {
    // no "menu" kind on Chrome, title differs → position/default → not confident
    expect(matchLocalRootEx(FIREFOX_ROOTS[1], CHROME_ROOTS, 1).confident).toBe(false);
  });
});

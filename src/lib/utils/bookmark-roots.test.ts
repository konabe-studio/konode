import { describe, it, expect } from "vitest";
import {
  rootKind, rootKindFromTitle, rootKindFromFolderType, rootKindOf, asRootKind,
  defaultOtherRootId, findLocalRootByKind, matchLocalRoot, matchLocalRootEx,
} from "./bookmark-roots";

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

// The other direction, and the one that tore a real tree in half: Orion as the LOCAL
// browser, where id "1" is a bar by id and id "3" is a bar by title. Two roots answering
// to one kind meant `find` returned whichever came first, so a peer's bookmarks bar landed
// in Favourites on one sync and in the Bookmarks Bar on the next. From the field bundle:
// 80 bookmarks arrived as 32 + 48 split across both, one folder living in each half.
describe("matchLocalRoot — Orion has TWO roots that answer to 'bar'", () => {
  it("sends a peer's bar to the same root whatever order the browser enumerates them", () => {
    const forward = matchLocalRootEx(CHROME_ROOTS[0], ORION_ROOTS, 0);
    const reversed = matchLocalRootEx(CHROME_ROOTS[0], [...ORION_ROOTS].reverse(), 0);
    expect(forward.id).toBe(reversed.id);
    expect(forward.confident).toBe(true);
  });

  it("prefers the root that is a bar by ID over the one rescued by its title", () => {
    // "Bookmarks Bar" (id 1) is already right; the Favorites override exists to fix a
    // WRONG id, so it must not outrank one that needs no fixing.
    expect(matchLocalRoot(CHROME_ROOTS[0], ORION_ROOTS, 0)).toBe("1");
  });

  it("does not let Chrome's Mobile bookmarks fall into Favorites", () => {
    // Favorites is id "3", which is Chrome's mobile id. Resolving the local kind by id
    // alone would match it here and quietly merge two unrelated collections.
    expect(matchLocalRoot(CHROME_ROOTS[2], ORION_ROOTS, 2)).not.toBe("3");
  });

  it("still rescues an Orion that has Favorites and NO id-1 bar (the 1.0.2 case)", () => {
    const olderOrion = [
      { id: "2", title: "Bookmarks" },
      { id: "3", title: "Favorites" },
    ];
    expect(matchLocalRoot(CHROME_ROOTS[0], olderOrion, 0)).toBe("3");
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
    // No "menu" kind on Chrome and the titles differ, so this is a KNOWN absence →
    // straight to the default writable root, never a positional guess.
    expect(matchLocalRoot(FIREFOX_ROOTS[1], CHROME_ROOTS, 1)).toBe("2");
  });

  it("puts the menu root in Other bookmarks from ANY index (order must not matter)", () => {
    // This used to depend entirely on where the engine happens to list the menu root:
    // `localRoots[index]` fired before the default, so at index 0 the whole Bookmarks
    // Menu landed in Chrome's bookmarks BAR. Firefox's own enumeration puts
    // `menu________` first, and the old test only passed because this fixture lists the
    // toolbar first. Pin every index so the outcome can't hinge on that again.
    const menu = FIREFOX_ROOTS[1];
    for (const index of [0, 1, 2, 3, 9]) {
      expect(matchLocalRoot(menu, CHROME_ROOTS, index)).toBe("2");
    }
  });

  it("still positions an UNRECOGNIZED root by index — that guess is all we have", () => {
    // The narrowing must not swallow the genuine unknown-root case (a peer on an older
    // build with a nonstandard root id and no title match).
    const local = [{ id: "x" }, { id: "y" }, { id: "z" }];
    expect(matchLocalRoot({ id: "nonstandard-root" }, local, 2)).toBe("z");
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

// ── Edge, after the renumbering (issue #66) ────────────────────────────────────────
//
// crbug 456225717 reassigned every bookmark id on every profile, and it shipped in Edge
// 142 as a one-time permanent renumbering. The Favorites bar is some arbitrary id
// afterwards, and Edge's English root titles never matched Chrome's anyway — so a Chrome
// peer's bar matched nothing and its whole tree was dropped into "Other favorites".
// Chromium 134+ (every build that could renumber) types the roots on the node itself.
const EDGE_142_ROOTS = [
  { id: "17", title: "Favorites bar", folderType: "bookmarks-bar" },
  { id: "18", title: "Other favorites", folderType: "other" },
  { id: "19", title: "Mobile favorites", folderType: "mobile" },
  { id: "20", title: "Managed favorites", folderType: "managed" },
];

describe("rootKindFromFolderType", () => {
  it("maps Chromium's folder types", () => {
    expect(rootKindFromFolderType("bookmarks-bar")).toBe("bar");
    expect(rootKindFromFolderType("other")).toBe("other");
    expect(rootKindFromFolderType("mobile")).toBe("mobile");
    expect(rootKindFromFolderType("managed")).toBe("managed");
  });
  it("is undefined when the engine reports none", () => {
    expect(rootKindFromFolderType(undefined)).toBeUndefined();
    expect(rootKindFromFolderType("something-new")).toBeUndefined();
  });
});

describe("rootKindOf — strongest signal wins", () => {
  it("types a renumbered root from its folderType, whatever the id says", () => {
    expect(rootKindOf(EDGE_142_ROOTS[0])).toBe("bar");
    expect(rootKindOf(EDGE_142_ROOTS[3])).toBe("managed");
    // "2" is Chrome's OTHER root by id — folderType has to outrank that, or a renumbered
    // profile whose bar happens to land on a known numeric id is actively misfiled.
    expect(rootKindOf({ id: "2", title: "Favorites bar", folderType: "bookmarks-bar" })).toBe("bar");
  });

  it("takes the peer's own answer over everything else", () => {
    expect(rootKindOf({ id: "2", title: "Other bookmarks", rootKind: "bar" })).toBe("bar");
  });

  it("falls back to the id table when there is no folderType", () => {
    expect(rootKindOf({ id: "1", title: "Bookmarks bar" })).toBe("bar");
    expect(rootKindOf({ id: "unfiled_____" })).toBe("other");
  });

  it("falls back to a known English root title when the id means nothing", () => {
    expect(rootKindOf({ id: "17", title: "Favorites bar" })).toBe("bar");
    expect(rootKindOf({ id: "18", title: "Other favorites" })).toBe("other");
    expect(rootKindOf({ id: "99", title: "Bookmarks Toolbar" })).toBe("bar");
  });

  it("stays undefined for a localized title it cannot know", () => {
    // Root titles are localized, so the title table only ever rescues English UIs.
    expect(rootKindOf({ id: "17", title: "Kedvencek sávja" })).toBeUndefined();
  });

  it("does not type an ordinary folder", () => {
    expect(rootKindOf({ id: "4242", title: "Work" })).toBeUndefined();
  });
});

describe("matchLocalRoot — Edge 142 renumbering (issue #66)", () => {
  it("lands a Chrome peer's bar in the Favorites bar, not Other favorites", () => {
    const m = matchLocalRootEx(CHROME_ROOTS[0], EDGE_142_ROOTS, 0);
    expect(m.id).toBe("17");       // this was "18" — the whole of #66
    expect(m.confident).toBe(true); // and confident, so moves apply too
  });

  it("maps the rest of the Chrome roots by kind as well", () => {
    expect(matchLocalRoot(CHROME_ROOTS[1], EDGE_142_ROOTS, 1)).toBe("18");
    expect(matchLocalRoot(CHROME_ROOTS[2], EDGE_142_ROOTS, 2)).toBe("19");
  });

  it("maps a renumbered Edge root back onto Chrome", () => {
    expect(matchLocalRoot(EDGE_142_ROOTS[0], CHROME_ROOTS, 0)).toBe("1");
    expect(matchLocalRoot(EDGE_142_ROOTS[0], FIREFOX_ROOTS, 0)).toBe("toolbar_____");
  });

  it("uses the kind the peer published, even when its id reads as another root", () => {
    // What a renumbered peer now sends: the kind travels with the root, so the receiver
    // never has to touch an id that only meant something on the sender's profile.
    const remote = { id: "2", title: "Kedvencek sávja", rootKind: "bar" as const };
    expect(matchLocalRoot(remote, CHROME_ROOTS, 0)).toBe("1");
  });

  it("still rescues a renumbered peer that sent no kind, by its English title", () => {
    expect(matchLocalRoot({ id: "17", title: "Favorites bar" }, CHROME_ROOTS, 0)).toBe("1");
  });

  it("is honest about the case with nothing left to match on", () => {
    // Renumbered id, localized title, no folderType, no published kind: #66 with every
    // signal removed. Position is all that remains — here it happens to land on the bar,
    // but it is a guess, so it must not be confident (no move may act on it).
    const m = matchLocalRootEx({ id: "17", title: "Kedvencek sávja" }, CHROME_ROOTS, 0);
    expect(m.id).toBe("1");
    expect(m.confident).toBe(false);
  });
});

describe("the managed root is never a sync target", () => {
  // "Managed bookmarks" is enterprise policy and rejects every write, so a bookmark
  // routed there is simply lost (create throws, the handler logs and moves on).
  it("is not the default writable root", () => {
    expect(defaultOtherRootId(EDGE_142_ROOTS)).toBe("18");
    expect(defaultOtherRootId([EDGE_142_ROOTS[3], EDGE_142_ROOTS[0]])).toBe("17");
  });

  it("is not reachable by a positional guess", () => {
    expect(matchLocalRoot({ id: "nonstandard" }, EDGE_142_ROOTS, 3)).toBe("18");
  });

  it("sends a peer's managed root to the default writable root instead", () => {
    const m = matchLocalRootEx(EDGE_142_ROOTS[3], EDGE_142_ROOTS, 3);
    expect(m.id).toBe("18"); // not "20", the local managed root
    expect(m.confident).toBe(false);
    expect(matchLocalRoot(EDGE_142_ROOTS[3], CHROME_ROOTS, 3)).toBe("2");
  });
});

// Chromium 134+ states it outright: "There may be zero, one or multiple nodes of each
// folder type." A signed-in profile carries an ACCOUNT bar and a local-only bar, told
// apart by `syncing` — the same hazard as Orion's two bars, and it must not be settled
// by whichever one the browser happens to enumerate first.
const ACCOUNT_AND_LOCAL_ROOTS = [
  { id: "1", title: "Bookmarks bar", folderType: "bookmarks-bar", syncing: false },
  { id: "2", title: "Other bookmarks", folderType: "other", syncing: false },
  { id: "7", title: "Bookmarks bar", folderType: "bookmarks-bar", syncing: true },
  { id: "8", title: "Other bookmarks", folderType: "other", syncing: true },
];

describe("two local roots of the same kind (account + local-only)", () => {
  it("resolves to the same root whatever order they are enumerated in", () => {
    const forward = matchLocalRoot(CHROME_ROOTS[0], ACCOUNT_AND_LOCAL_ROOTS, 0);
    const reversed = matchLocalRoot(CHROME_ROOTS[0], [...ACCOUNT_AND_LOCAL_ROOTS].reverse(), 0);
    expect(forward).toBe(reversed);
  });

  it("picks the account root — where a signed-in user's bookmarks actually are", () => {
    expect(matchLocalRoot(CHROME_ROOTS[0], ACCOUNT_AND_LOCAL_ROOTS, 0)).toBe("7");
    expect(defaultOtherRootId(ACCOUNT_AND_LOCAL_ROOTS)).toBe("8");
  });
});

describe("findLocalRootByKind", () => {
  it("returns the single root of a kind", () => {
    expect(findLocalRootByKind(CHROME_ROOTS, "bar")?.id).toBe("1");
    expect(findLocalRootByKind(EDGE_142_ROOTS, "other")?.id).toBe("18");
  });
  it("is undefined when the browser has no such root", () => {
    expect(findLocalRootByKind(CHROME_ROOTS, "menu")).toBeUndefined();
  });
  it("prefers a root typed by the engine over one rescued by its title", () => {
    const roots = [{ id: "3", title: "Favorites" }, { id: "9", folderType: "bookmarks-bar" }];
    expect(findLocalRootByKind(roots, "bar")?.id).toBe("9");
  });
});

describe("asRootKind", () => {
  // The first segment of a stored folder path is a kind; it comes back as a bare string.
  it("narrows a stored path segment", () => {
    expect(asRootKind("bar")).toBe("bar");
    expect(asRootKind("managed")).toBe("managed");
  });
  it("rejects anything that isn't a kind", () => {
    expect(asRootKind("Bookmarks bar")).toBeUndefined();
    expect(asRootKind("")).toBeUndefined();
    expect(asRootKind(undefined)).toBeUndefined();
  });
});

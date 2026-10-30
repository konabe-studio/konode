/**
 * Browser-agnostic bookmark-root resolution.
 *
 * Chrome/Chromium number the top-level roots as short numeric ids — "1" =
 * Bookmarks bar, "2" = Other bookmarks, "3" = Mobile bookmarks. Firefox instead
 * uses stable string guids — "toolbar_____", "menu________", "unfiled_____",
 * "mobile______". Both browsers expose them the same way (`getTree()[0].children`),
 * so the sync merge/import code should reason about a root's *kind*, never a raw
 * Chrome id. This module is the single place that maps ids ⇄ kinds; it's pure
 * (operates on plain `{ id, title? }` shapes) so it's unit-testable without the
 * `chrome.bookmarks` fake.
 *
 * Those ids are NOT as stable as the numbering suggests. crbug 456225717 reassigned
 * every bookmark id on every profile, and it shipped in Edge 142 as a one-time
 * permanent renumbering — so on those profiles the Favorites bar simply isn't "1" any
 * more. A peer's bar then matched nothing here and its whole tree landed in "Other
 * favorites" (issue #66). Chromium 134+ types the permanent folders on the node itself
 * (`folderType`), which is the one signal that doesn't depend on the numbering, so that
 * is what we read first; the id tables below are now the fallback, not the source of
 * truth. The resolution order lives in `rootKindOf`.
 */

/** The logical kind of a top-level bookmark root, independent of browser. */
export type RootKind = "bar" | "other" | "mobile" | "menu" | "managed";

// Chrome/Chromium numeric root ids.
const CHROME_ROOT_KINDS: Record<string, RootKind> = {
  "1": "bar",
  "2": "other",
  "3": "mobile",
};

// Firefox stable root guids. Note Firefox has a dedicated "menu" root that
// Chromium lacks; Chromium's "Other bookmarks" is Firefox's "unfiled" ("other").
const FIREFOX_ROOT_KINDS: Record<string, RootKind> = {
  toolbar_____: "bar",
  menu________: "menu",
  unfiled_____: "other",
  mobile______: "mobile",
};

const ALL_ROOT_KINDS: readonly RootKind[] = ["bar", "other", "mobile", "menu", "managed"];

/** Narrow a stored string — the first segment of a browser-agnostic folder path — back to
 *  a RootKind, or undefined if it isn't one. */
export function asRootKind(value: string | undefined): RootKind | undefined {
  return ALL_ROOT_KINDS.includes(value as RootKind) ? (value as RootKind) : undefined;
}

/** The logical kind of a root id, or undefined for a non-root / unknown id. */
export function rootKind(id: string): RootKind | undefined {
  return CHROME_ROOT_KINDS[id] ?? FIREFOX_ROOT_KINDS[id];
}

// Chromium 134+ (so Edge 142+, which is where the renumbering landed) exposes
// `BookmarkTreeNode.folderType` on each permanent folder: "bookmarks-bar" | "other" |
// "mobile" | "managed". The engine is telling us what the folder IS, which beats every
// guess below it — it survives renumbering, it is not localized, and it is the same
// vocabulary on Chrome, Edge, Brave and Opera.
const FOLDER_TYPE_KINDS: Record<string, RootKind> = {
  "bookmarks-bar": "bar",
  other: "other",
  mobile: "mobile",
  managed: "managed",
};

/** A root kind read from the engine's own `folderType` (Chromium 134+), if present. */
export function rootKindFromFolderType(folderType: string | undefined): RootKind | undefined {
  return folderType ? FOLDER_TYPE_KINDS[folderType] : undefined;
}

// WebKit browsers (Safari / Orion) REUSE Chrome's numeric root ids but with
// different meaning: id "3" is "Favorites" (their bookmarks-bar equivalent), NOT
// "mobile", and id "2" is a general "Bookmarks" collection. The numeric id alone
// is therefore ambiguous across engines. WebKit's root TITLES are fixed English
// strings and a user can't rename a root, so an exact title match is a reliable
// extra signal — we use it to override the (wrong) id-based kind. Chrome/Firefox
// never title a root "Favorites" (theirs are "Bookmarks bar" etc., localized), so
// this can't misfire on them. (Edge titles its bar "Favorites bar", not "Favorites" —
// and on Edge `folderType` answers first regardless.)
const WEBKIT_TITLE_KINDS: Record<string, RootKind> = {
  favorites: "bar",
};

/** A root kind inferred from a well-known engine-specific root TITLE, if any. */
export function rootKindFromTitle(title: string | undefined): RootKind | undefined {
  return title ? WEBKIT_TITLE_KINDS[title.trim().toLowerCase()] : undefined;
}

// Last-resort title table, for a root whose id we don't recognize on an engine that
// doesn't report `folderType` (a pre-134 Chromium fork, a nonstandard build). Root
// titles are LOCALIZED, so this only rescues English UIs — but a known English root
// name is still a far better guess than "whichever root sits at this index". It is
// ranked BELOW the id tables: on any engine whose ids are intact the two agree, and
// of the two a title is the weaker signal.
const KNOWN_ROOT_TITLE_KINDS: Record<string, RootKind> = {
  // Chrome / Chromium / Brave / Opera
  "bookmarks bar": "bar",
  "other bookmarks": "other",
  "mobile bookmarks": "mobile",
  "managed bookmarks": "managed",
  // Edge calls them favorites
  "favorites bar": "bar",
  "other favorites": "other",
  "mobile favorites": "mobile",
  "managed favorites": "managed",
  // Firefox ("Other Bookmarks" / "Mobile Bookmarks" are spelled as above)
  "bookmarks toolbar": "bar",
  "bookmarks menu": "menu",
};

function rootKindFromKnownTitle(title: string | undefined): RootKind | undefined {
  return title ? KNOWN_ROOT_TITLE_KINDS[title.trim().toLowerCase()] : undefined;
}

/**
 * A root as either browser or peer hands it to us.
 *
 * `folderType` and `syncing` come from a live Chromium node (134+); `rootKind` is the
 * kind a PEER resolved and wrote into the sync payload, so the receiver never has to
 * re-derive it from an id that only meant something on the sender's profile.
 */
export type RootLike = {
  id: string;
  title?: string;
  folderType?: string;
  syncing?: boolean;
  rootKind?: RootKind;
};

/**
 * A root's kind, from the strongest signal available:
 *   1. the kind a peer already resolved and sent us (`rootKind` in the payload);
 *   2. the engine's own `folderType` (Chromium 134+) — renumbering-proof;
 *   3. the WebKit "Favorites" title override, which exists to CORRECT a misleading id;
 *   4. the per-engine id tables;
 *   5. a known English root title.
 */
export function rootKindOf(root: RootLike): RootKind | undefined {
  return root.rootKind
    ?? rootKindFromFolderType(root.folderType)
    ?? rootKindFromTitle(root.title)
    ?? rootKind(root.id)
    ?? rootKindFromKnownTitle(root.title);
}

/** How well-established a root's claim to THIS kind is — only ever used to break a tie
 *  between two local roots that answer to the same kind. Mirrors `rootKindOf`'s order,
 *  and each signal has to agree with `kind` to count: Orion's "Favorites" is a bar by
 *  title while its id "3" is a known root id meaning something else entirely (mobile),
 *  and ranking it on the strength of that unrelated id made the tie-break a coin flip
 *  decided by enumeration order — the very thing the picker below exists to prevent. */
function kindRank(root: RootLike, kind: RootKind): number {
  if (root.rootKind === kind) return 4;
  if (rootKindFromFolderType(root.folderType) === kind) return 3;
  if (rootKind(root.id) === kind) return 2;
  if (rootKindFromTitle(root.title) === kind) return 1;
  return 0; // it answers to `kind` only through a known English title
}

/**
 * The local root of a given kind, chosen deterministically when more than one answers
 * to it. TWO local roots can, and do:
 *   - a real Orion install has BOTH id "1" titled "Bookmarks Bar" (a bar by id) and id
 *     "3" titled "Favorites" (a bar by the title override above). `find` returned
 *     whichever the browser happened to enumerate first, so one peer's bookmarks bar
 *     landed in Favourites and the next sync's landed in the Bookmarks Bar. Seen in the
 *     field as a tree torn in half: 80 bookmarks arriving as 32 + 48 across the two,
 *     with the same folder existing in both and its contents divided between them.
 *   - Chromium 134+ states outright that there may be "zero, one or multiple nodes of
 *     each folder type": a signed-in profile has an ACCOUNT bar and a local-only bar,
 *     told apart by `syncing`. Same hazard, same answer.
 * So: the better-established kind wins (an id that is already right is not overruled by
 * the title rescue, which exists for ids that are wrong), then the account root over the
 * local-only one — that is where a signed-in user's bookmarks actually are, so it is
 * also where a peer's belong. The outcome must never depend on enumeration order.
 */
export function findLocalRootByKind(roots: RootLike[], kind: RootKind): RootLike | undefined {
  const candidates = roots.filter((r) => rootKindOf(r) === kind);
  if (candidates.length < 2) return candidates[0];
  return [...candidates].sort(
    (a, b) =>
      kindRank(b, kind) - kindRank(a, kind)
      || Number(b.syncing ?? false) - Number(a.syncing ?? false),
  )[0];
}

/** Enterprise-policy roots ("Managed bookmarks") reject every write, so they are never
 *  a sync target — not by kind, not by position, not as the default. */
function writableRoots(roots: RootLike[]): RootLike[] {
  return roots.filter((r) => rootKindOf(r) !== "managed");
}

/**
 * The default writable root to drop synced bookmarks into when no better match
 * exists: "Other bookmarks" on Chrome ("2"), "unfiled" on Firefox. Falls back to
 * the 2nd root, then the 1st, so it degrades gracefully on any unexpected shape.
 */
export function defaultOtherRootId(roots: RootLike[]): string | undefined {
  const writable = writableRoots(roots);
  const other = findLocalRootByKind(writable, "other");
  return other?.id ?? writable[1]?.id ?? writable[0]?.id;
}

/**
 * Match a remote root to the local root it should merge into, and report whether
 * the match was CONFIDENT. Resolution order:
 *   1. by KIND — so a Chrome "Bookmarks bar" ("1") maps to Firefox's toolbar and
 *      vice-versa, even though the ids and titles differ across browsers, and an Edge
 *      profile whose ids were renumbered still maps by its `folderType`;
 *   2. by exact id — same-browser fast path when kinds don't resolve;
 *   3. by (localized) title;
 *   → the above are `confident: true`.
 *   4a. kind RECOGNIZED but absent locally → the default writable root ("Other
 *       bookmarks"). A known absence, not an unknown root: Firefox's "menu" kind simply
 *       has no Chromium counterpart, so there is nothing for a positional guess to find.
 *       Guessing by position used to fire FIRST here and drop the whole Bookmarks Menu
 *       into whichever local root happened to sit at that index — Chrome's bookmarks
 *       BAR when Firefox lists `menu________` first — contradicting this very comment.
 *       The outcome must not depend on the order an engine happens to enumerate roots.
 *   4b. kind UNRECOGNIZED (a nonstandard or older-build root id with no title match) →
 *       by position, then the default writable root. Here position really is the best
 *       remaining guess.
 *   → both are `confident: false`.
 *
 * `confident` matters when RELOCATING an existing bookmark (a move): a positional/
 * default guess must NOT yank a bookmark across roots (e.g. a peer on an older
 * build, or a non-standard root id + mismatched titles, would otherwise displace it
 * into "Other bookmarks"). Placing a NEW bookmark via the guess is fine.
 */
export function matchLocalRootEx(
  remoteRoot: RootLike,
  localRoots: RootLike[],
  index: number,
): { id: string | undefined; confident: boolean } {
  const kind = rootKindOf(remoteRoot);
  // Enterprise-policy roots ("Managed bookmarks") reject every write, so the local one is
  // a candidate for NOTHING: not the kind match, not the id fast path — a same-browser
  // peer shares that id, which is how a peer's managed root was resolving to ours — not
  // the title match, not position. A peer's managed content lands in the default writable
  // root instead, like any other root this browser can't offer.
  const candidates = writableRoots(localRoots);
  if (kind) {
    const byKind = findLocalRootByKind(candidates, kind);
    if (byKind) return { id: byKind.id, confident: true };
  }
  // Same-browser fast path, but only when the id isn't a false friend. Chrome and WebKit
  // both use "3" and mean different things by it, so an id match that CONTRADICTS the
  // kinds is worse than no match: it was routing Chrome's Mobile bookmarks straight into
  // Orion's Favourites, merging two unrelated collections under a coincidence of numbering.
  const sameId = candidates.find((r) => r.id === remoteRoot.id);
  if (sameId) {
    const localKind = rootKindOf(sameId);
    if (!kind || !localKind || localKind === kind) return { id: sameId.id, confident: true };
  }
  const title = remoteRoot.title?.toLowerCase();
  if (title) {
    const byTitle = candidates.find((r) => r.title?.toLowerCase() === title);
    if (byTitle) return { id: byTitle.id, confident: true };
  }
  // We know WHAT this root is, this browser just doesn't have one — skip the positional
  // guess entirely (see 4a above), so the result can't hinge on root enumeration order.
  if (kind) return { id: defaultOtherRootId(localRoots), confident: false };
  return { id: candidates[index]?.id ?? defaultOtherRootId(localRoots), confident: false };
}

/** Convenience wrapper returning just the resolved local root id (guess included). */
export function matchLocalRoot(
  remoteRoot: RootLike,
  localRoots: RootLike[],
  index: number,
): string | undefined {
  return matchLocalRootEx(remoteRoot, localRoots, index).id;
}

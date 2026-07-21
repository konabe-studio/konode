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
 */

/** The logical kind of a top-level bookmark root, independent of browser. */
export type RootKind = "bar" | "other" | "mobile" | "menu";

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

/** The logical kind of a root id, or undefined for a non-root / unknown id. */
export function rootKind(id: string): RootKind | undefined {
  return CHROME_ROOT_KINDS[id] ?? FIREFOX_ROOT_KINDS[id];
}

// WebKit browsers (Safari / Orion) REUSE Chrome's numeric root ids but with
// different meaning: id "3" is "Favorites" (their bookmarks-bar equivalent), NOT
// "mobile", and id "2" is a general "Bookmarks" collection. The numeric id alone
// is therefore ambiguous across engines. WebKit's root TITLES are fixed English
// strings and a user can't rename a root, so an exact title match is a reliable
// extra signal — we use it to override the (wrong) id-based kind. Chrome/Firefox
// never title a root "Favorites" (theirs are "Bookmarks bar" etc., localized), so
// this can't misfire on them.
const WEBKIT_TITLE_KINDS: Record<string, RootKind> = {
  favorites: "bar",
};

/** A root kind inferred from a well-known engine-specific root TITLE, if any. */
export function rootKindFromTitle(title: string | undefined): RootKind | undefined {
  return title ? WEBKIT_TITLE_KINDS[title.trim().toLowerCase()] : undefined;
}

type RootLike = { id: string; title?: string };

/**
 * The default writable root to drop synced bookmarks into when no better match
 * exists: "Other bookmarks" on Chrome ("2"), "unfiled" on Firefox. Falls back to
 * the 2nd root, then the 1st, so it degrades gracefully on any unexpected shape.
 */
export function defaultOtherRootId(roots: RootLike[]): string | undefined {
  const other = roots.find((r) => rootKind(r.id) === "other");
  return other?.id ?? roots[1]?.id ?? roots[0]?.id;
}

/**
 * Match a remote root to the local root it should merge into, and report whether
 * the match was CONFIDENT. Resolution order:
 *   1. by KIND — so a Chrome "Bookmarks bar" ("1") maps to Firefox's toolbar and
 *      vice-versa, even though the ids and titles differ across browsers;
 *   2. by exact id — same-browser fast path when kinds don't resolve;
 *   3. by (localized) title;
 *   → the above are `confident: true`.
 *   4. by position, then the default writable root — `confident: false` (a guess).
 * A Firefox-only "menu" root syncing to Chrome has no local kind match and lands
 * in "Other bookmarks" via the tail fallbacks — the sensible degrade.
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
  // Title-derived kind wins over the id — it's how we disambiguate WebKit's
  // reused numeric ids (id "3" titled "Favorites" is a bar, not Chrome's mobile).
  const kind = rootKindFromTitle(remoteRoot.title) ?? rootKind(remoteRoot.id);
  if (kind) {
    const byKind = localRoots.find((r) => (rootKindFromTitle(r.title) ?? rootKind(r.id)) === kind);
    if (byKind) return { id: byKind.id, confident: true };
  }
  if (localRoots.some((r) => r.id === remoteRoot.id)) return { id: remoteRoot.id, confident: true };
  const title = remoteRoot.title?.toLowerCase();
  if (title) {
    const byTitle = localRoots.find((r) => r.title?.toLowerCase() === title);
    if (byTitle) return { id: byTitle.id, confident: true };
  }
  return { id: localRoots[index]?.id ?? defaultOtherRootId(localRoots), confident: false };
}

/** Convenience wrapper returning just the resolved local root id (guess included). */
export function matchLocalRoot(
  remoteRoot: RootLike,
  localRoots: RootLike[],
  index: number,
): string | undefined {
  return matchLocalRootEx(remoteRoot, localRoots, index).id;
}

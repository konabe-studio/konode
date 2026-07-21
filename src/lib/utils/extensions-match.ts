/**
 * Cross-browser extension matching for the synced extension-list feature.
 *
 * Extension ids don't cross stores — the same extension is a 32-char CWS id on
 * Chrome (e.g. "cjpalh…") and something like "uBlock0@raymondhill.net" on Firefox.
 * So to decide "is this peer's extension already installed here?" across browsers
 * we fall back to the normalized NAME and the homepage HOST (the developer's site
 * is usually shared). Same-store peers still match exactly by id.
 *
 * Pure module (no `browser`) so it's unit-testable without the extension APIs.
 */
import type { SyncExtension } from "@/lib/types";
import { CWS_DETAIL_BASE, CWS_SEARCH_BASE, AMO_SEARCH_BASE } from "@/lib/constants";

export type Store = "chrome" | "firefox";

/** A local extension shape we can match against (subset of chrome.management info). */
export interface LocalExtLike {
  id: string;
  name?: string;
  homepageUrl?: string;
}

/** Normalize an extension name for cross-store comparison. */
export function normalizeExtName(name: string | undefined): string {
  return (name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Registrable-ish host of a homepage URL (www. stripped), or "" if none/unparseable. */
function homepageHost(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).host.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Best-effort source store of a (possibly legacy) synced extension. Chrome ids are
 * exactly 32 chars in a–p; Firefox ids contain '@' or are '{…}' guids.
 */
export function inferStore(ext: Pick<SyncExtension, "id" | "store">): Store {
  if (ext.store) return ext.store;
  return /^[a-p]{32}$/.test(ext.id) ? "chrome" : "firefox";
}

/**
 * Is a synced (remote) extension already present locally? Same store → exact id;
 * cross-store → normalized name OR shared homepage host (no id crosses stores).
 * A rare false match only suppresses an informational "missing" hint, so the loose
 * cross-store heuristic is an acceptable trade for this read-only feature.
 */
export function isInstalledLocally(
  remote: SyncExtension,
  locals: LocalExtLike[],
  localStore: Store,
): boolean {
  const remoteStore = inferStore(remote);
  const rName = normalizeExtName(remote.name);
  const rHost = homepageHost(remote.homepageUrl);
  return locals.some((l) => {
    if (remoteStore === localStore && l.id === remote.id) return true;
    if (rName && normalizeExtName(l.name) === rName) return true;
    if (rHost && homepageHost(l.homepageUrl) === rHost) return true;
    return false;
  });
}

/**
 * A host-pinned store link this browser's store from a peer's `id`/`name`. Chrome
 * gets the CWS item page (id-based, exact); Firefox has no id→listing mapping, so
 * it gets an AMO name search. Rebuild-from-fields (never trust a peer-supplied URL
 * host — a forged storeUrl was a phishing vector).
 */
export function storeUrlFor(ext: Pick<SyncExtension, "id" | "name" | "store">): string {
  return inferStore(ext) === "chrome"
    ? `${CWS_DETAIL_BASE}${ext.id}`
    : `${AMO_SEARCH_BASE}${encodeURIComponent(ext.name ?? "")}`;
}

/**
 * Where to send the user to install/find this extension in the CURRENT browser.
 * Same store as the source → the direct listing / its rebuilt storeUrl. Cross-store
 * → a name search in the current browser's store (we can't map ids across stores,
 * and querying the store to check existence would be an external request we avoid,
 * so we let the search show whether a counterpart exists).
 */
export function installOrSearchUrl(remote: SyncExtension, currentStore: Store): string {
  if (inferStore(remote) === currentStore) return remote.storeUrl || storeUrlFor(remote);
  const q = encodeURIComponent(remote.name ?? "");
  return currentStore === "firefox" ? `${AMO_SEARCH_BASE}${q}` : `${CWS_SEARCH_BASE}${q}`;
}

/**
 * Cross-browser extension matching for the synced extension-list feature.
 *
 * Extension ids don't cross stores — the same extension is a 32-char CWS id on
 * Chrome (e.g. "cjpalh…") and something like "uBlock0@raymondhill.net" on Firefox.
 * So to decide "is this peer's extension already installed here?" across browsers
 * we fall back to the normalized NAME and the developer's homepage HOST. Same-store
 * peers still match exactly by id.
 *
 * The homepage host must be the DEVELOPER's — a store-listing URL says nothing, and
 * Chrome hands one out for every extension without an explicit manifest homepage.
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
 * Hosts that identify a STORE LISTING rather than the developer's own site.
 *
 * Chrome fills `homepageUrl` with the Web Store detail URL for any extension whose
 * manifest has no `homepage_url` — which is most of them. So this one host was shared by
 * a large share of extensions on BOTH sides, the host rule below matched almost anything
 * against almost anything, and "missing on this device" came out EMPTY no matter what the
 * peer actually had installed. Reported from the field: two machines, each with a
 * password manager the other lacked, and neither ever appeared.
 *
 * A genuine developer homepage is still a useful cross-store signal. A store listing
 * carries no information at all, so it must not be treated as one.
 */
const STORE_HOSTS = new Set([
  "chrome.google.com",
  "chromewebstore.google.com",
  "addons.mozilla.org",
  "microsoftedge.microsoft.com",
  "addons.opera.com",
]);

/** The developer's own homepage host, or "" when the URL is merely a store listing. */
function developerHost(url: string | undefined): string {
  const h = homepageHost(url);
  return h && !STORE_HOSTS.has(h) ? h : "";
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
 * Is a synced (remote) extension already present locally?
 *
 * Three signals, in order of strength:
 *   1. the exact id — but only within the SAME store, since no id crosses stores;
 *   2. the normalized name — the main cross-store signal, and it also covers a
 *      sideloaded or dev-loaded copy whose id differs per profile within one store;
 *   3. a shared DEVELOPER homepage host — never a store-listing host (see STORE_HOSTS),
 *      which is what made this function answer "installed" for essentially everything.
 *      CROSS-STORE ONLY, see below.
 *
 * A rare false match only suppresses an informational "missing" hint, so leaning towards
 * suppression is an acceptable trade for a read-only feature — but it has to be a real
 * signal doing the suppressing.
 *
 * Why the host signal is gated on cross-store: a homepage host identifies a DEVELOPER,
 * not an extension, and one developer ships many extensions. Worse, a huge share of
 * extensions point `homepage_url` at their source repository, so github.com alone is
 * shared by a large slice of any open-source-leaning collection. Within one store the id
 * signal already answers the question exactly, so the host rule could only ever be wrong
 * there — and it was, in bulk: a single local extension homepaged on github.com suppressed
 * every peer extension sharing that host, silently and with no way to see why. Reported
 * from the field: 20 extensions on one laptop, half of them never listed as missing on the
 * other. Cross-store the id is useless and the host is the signal this rule exists for, so
 * it still runs there.
 */
export function isInstalledLocally(
  remote: SyncExtension,
  locals: LocalExtLike[],
  localStore: Store,
): boolean {
  const remoteStore = inferStore(remote);
  const crossStore = remoteStore !== localStore;
  const rName = normalizeExtName(remote.name);
  const rHost = crossStore ? developerHost(remote.homepageUrl) : "";
  return locals.some((l) => {
    if (!crossStore && l.id === remote.id) return true;
    if (rName && normalizeExtName(l.name) === rName) return true;
    if (rHost && developerHost(l.homepageUrl) === rHost) return true;
    return false;
  });
}

/**
 * Which of a peer's extensions are not installed here.
 *
 * Both surfaces that show "missing on this device" (the popup list and the Settings
 * statistics) need the identical rule, and they used to spell it out separately as
 * `e.type === "extension" && !isInstalledLocally(...)`. That allow-list was the bug:
 * `type` carries the browser's own ExtensionType, so a hosted or packaged app was
 * exported, uploaded, downloaded and stored, then dropped here without a trace. Ask
 * what it is NOT: the export already excludes themes, so excluding them again is
 * belt-and-braces, and an entry with no type at all is shown rather than swallowed.
 */
export function missingLocally(
  remote: SyncExtension[],
  locals: LocalExtLike[],
  localStore: Store,
): SyncExtension[] {
  return remote.filter((e) => e.type !== "theme" && !isInstalledLocally(e, locals, localStore));
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

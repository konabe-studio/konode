/**
 * What the browser Konode is running in can actually DO — as opposed to what its
 * manifest says it may do.
 *
 * The two are not the same thing, and the gap is not theoretical. Firefox for Android
 * accepts `"permissions": ["bookmarks"]` at install time and then ships no bookmarks API
 * at all: the permission is granted, `browser.bookmarks` is `undefined`, and every call
 * into it is a TypeError. The same holds for `history`. A field report from a Fennec user
 * showed exactly the shape that produces — bookmarks failing with "getTree", the History
 * toggle refusing to turn on, and the setup wizard blaming the WebDAV server for a
 * permission problem that had nothing to do with WebDAV.
 *
 * So: ASK the browser, don't assume from the manifest, and don't assume from the engine
 * name either. A capability check answers correctly for browsers that don't exist yet;
 * a `/Android/` sniff only answers for the ones we thought of.
 *
 * Sources for the platform facts referenced here:
 *   - bookmarks API missing on Firefox for Android — mozilla-mobile/fenix#21830
 *   - history API missing on Firefox for Android — Rayquaza01/HistoryCleaner#22
 *   - permissions.request() unimplemented on GeckoView — bugzilla 1601420,
 *     mdn/browser-compat-data#13299
 */
import { browser } from "@/lib/utils/ext";
import type { DataType } from "@/lib/types";

/**
 * The optional permission a data type needs, for the types that need one.
 *
 * `bookmarks` is absent on purpose — it is a REQUIRED manifest permission, always held,
 * never requested. That absence is load-bearing in `dataTypeAvailability` below.
 */
export const PERMISSION_FOR_TYPE: Partial<Record<DataType, string>> = {
  history: "history",
  sessions: "tabs",
  extensions: "management",
};

/**
 * The namespace and one method each data type cannot work without.
 *
 * One method rather than the whole namespace: a browser that exposes a stub `bookmarks`
 * object with nothing on it is just as unusable as one that exposes nothing, and the
 * check should say so either way.
 */
const API_FOR_TYPE: Record<DataType, readonly [ns: string, method: string]> = {
  bookmarks: ["bookmarks", "getTree"],
  history: ["history", "search"],
  sessions: ["tabs", "query"],
  extensions: ["management", "getAll"],
};

/** Does this browser implement `browser.<ns>.<method>()`? */
export function apiPresent(ns: string, method: string): boolean {
  // Deliberately loose: `browser` is typed as `typeof chrome`, which declares every
  // namespace as always present. That type is a promise about the API surface, not a
  // fact about the running browser, and this function exists precisely to check the fact.
  const table = browser as unknown as Record<string, Record<string, unknown> | undefined>;
  try {
    return typeof table[ns]?.[method] === "function";
  } catch {
    return false;
  }
}

/**
 * Does this browser implement the `browser.<ns>.<event>` event?
 *
 * Separate from `apiPresent` because an event is an OBJECT carrying `addListener`, not a
 * function, so a `typeof … === "function"` check answers "no" for every event that
 * exists — which is a quiet way to switch off working listeners.
 */
export function eventPresent(ns: string, event: string): boolean {
  const table = browser as unknown as
    Record<string, Record<string, { addListener?: unknown } | undefined> | undefined>;
  try {
    return typeof table[ns]?.[event]?.addListener === "function";
  } catch {
    return false;
  }
}

/** Does this browser implement the API a data type is built on? */
export function dataTypeApiPresent(type: DataType): boolean {
  const [ns, method] = API_FOR_TYPE[type];
  return apiPresent(ns, method);
}

/**
 * Whether a data type can be synced here, and if not, which kind of "not".
 *
 * The distinction matters because the two need opposite treatment. A permission we
 * simply haven't asked for yet is one click away; an API the browser doesn't implement
 * is never coming, and offering a toggle for it is a lie.
 *
 * Telling them apart takes a permission check, because an optional-permission API is
 * `undefined` until its permission is granted — so a missing `browser.history` means
 * "not granted yet" on Chrome and "never implemented" on Firefox for Android, and only
 * `permissions.contains()` says which.
 */
export type Availability =
  | { state: "ready" }
  | { state: "needs-permission"; permission: string }
  | { state: "unsupported" };

export async function dataTypeAvailability(type: DataType): Promise<Availability> {
  if (dataTypeApiPresent(type)) return { state: "ready" };

  const permission = PERMISSION_FOR_TYPE[type];
  // No optional permission gates it (bookmarks), so the permission is already held and
  // the API is still not there. Nothing left to ask for.
  if (!permission) return { state: "unsupported" };

  // Permission held, API still absent → the browser doesn't implement it.
  if (await hasPermission({ permissions: [permission] })) return { state: "unsupported" };

  return { state: "needs-permission", permission };
}

/** Availability for every data type at once, for a UI that renders all four. */
export async function allDataTypeAvailability(): Promise<Record<DataType, Availability>> {
  const types = Object.keys(API_FOR_TYPE) as DataType[];
  const entries = await Promise.all(types.map(async (t) => [t, await dataTypeAvailability(t)] as const));
  return Object.fromEntries(entries) as Record<DataType, Availability>;
}

/**
 * What to tell someone whose browser doesn't implement a data type's API.
 *
 * Named platforms rather than a bare "not supported": the first thing anyone does with
 * "bookmarks can't sync" is check whether their setup is broken, and knowing it's the
 * browser — and that the desktop build is fine — ends that search immediately.
 */
const UNSUPPORTED_MESSAGE: Record<DataType, string> = {
  bookmarks: "This browser doesn't provide a bookmarks API, so bookmarks can't sync here. Firefox for Android is the usual case; bookmark sync works on desktop Firefox and on Chromium browsers.",
  history: "This browser doesn't provide a history API, so history can't sync here. Firefox for Android is the usual case; history sync works on desktop Firefox and on Chromium browsers.",
  sessions: "This browser doesn't provide a tabs API, so open tabs can't sync here.",
  extensions: "This browser doesn't provide an extension-management API, so your extension list can't sync here.",
};

/** The sentence to show for a type this browser can't sync. */
export function unsupportedReason(type: DataType): string {
  return UNSUPPORTED_MESSAGE[type];
}

/**
 * Throw a sentence a person can act on, rather than let the call fail as a TypeError.
 *
 * "Cannot read properties of undefined (reading 'getTree')" is what a Fennec user was
 * shown for a browser that simply has no bookmarks API, and it reads like a crash in
 * Konode. Every handler entry point checks this first.
 */
export function assertDataTypeApi(type: DataType): void {
  if (!dataTypeApiPresent(type)) throw new Error(UNSUPPORTED_MESSAGE[type]);
}

// ─── Permissions ──────────────────────────────────────────────────────────

/** `permissions.contains()`, never throwing — an unanswerable question is a "no". */
export async function hasPermission(req: chrome.permissions.Permissions): Promise<boolean> {
  try {
    return await browser.permissions.contains(req);
  } catch {
    return false;
  }
}

/**
 * The result of trying to obtain a permission.
 *
 * `cannot-prompt` is the one that earns its place: Firefox for Android does not implement
 * `permissions.request()` (bugzilla 1601420), so the call resolves false — or throws —
 * no matter what the user would have said. Reporting that as "you declined" is simply
 * false, and it is what left a Fennec user staring at "Konode needs permission to reach
 * your WebDAV server" with no prompt in sight and no way forward. On that platform the
 * permission has to be granted from Firefox's own add-on settings instead, which is
 * something we can tell the user only if we know the difference.
 */
export type PermissionOutcome = "granted" | "denied" | "cannot-prompt";

/**
 * Make sure a permission is held, prompting only if it isn't.
 *
 * The `contains()` check FIRST is not an optimisation. On a browser whose prompt is
 * broken it is the entire fix: a user who granted the permission by hand in the add-on's
 * settings page holds it, and asking `request()` about it would still answer false and
 * send them round the same loop again.
 *
 * MUST be called synchronously from a user gesture on browsers that do prompt — Firefox
 * rejects a `request()` that has lost its gesture, and every `await` before it risks
 * that. `contains()` runs first here, which is one await; that is safe because a request
 * only happens when contains() answered false, and in that case the click is still the
 * current task in every engine we've seen. Don't add more awaits before this call.
 */
export async function ensurePermission(req: chrome.permissions.Permissions): Promise<PermissionOutcome> {
  if (await hasPermission(req)) return "granted";

  let granted = false;
  try {
    granted = await browser.permissions.request(req);
  } catch {
    granted = false;
  }
  if (granted) return "granted";

  // A false here is not proof of a refusal — see PermissionOutcome. Re-check what we
  // actually hold before deciding which story to tell.
  if (await hasPermission(req)) return "granted";

  return (await promptsForPermissions()) ? "denied" : "cannot-prompt";
}

/**
 * Can this browser show a runtime permission prompt at all?
 *
 * There is no capability bit for this — `permissions.request` is a perfectly normal
 * function on Firefox for Android, it just never asks anybody. So this is the one place
 * that has to identify the platform rather than the feature, and it does it through
 * `runtime.getPlatformInfo()` rather than the user agent, which is spoofable.
 *
 * Cached: the answer cannot change within a page's lifetime, and the callers are click
 * handlers.
 */
let promptsCache: boolean | undefined;
export async function promptsForPermissions(): Promise<boolean> {
  if (promptsCache !== undefined) return promptsCache;
  promptsCache = !(await isAndroid());
  return promptsCache;
}

/** Test seam: forget the cached platform answers. */
export function resetCapabilityCache(): void {
  promptsCache = undefined;
  androidCache = undefined;
}

let androidCache: boolean | undefined;
export async function isAndroid(): Promise<boolean> {
  if (androidCache !== undefined) return androidCache;
  try {
    const info = await browser.runtime.getPlatformInfo();
    androidCache = info.os === "android";
  } catch {
    // Older/limited builds may not answer. The user agent is a worse signal — it can be
    // spoofed — but a wrong answer here only changes the wording of an error message,
    // never whether something is allowed.
    androidCache = /android/i.test(globalThis.navigator?.userAgent ?? "");
  }
  return androidCache;
}

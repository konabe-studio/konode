import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  apiPresent, eventPresent, dataTypeApiPresent, dataTypeAvailability, allDataTypeAvailability,
  assertDataTypeApi, ensurePermission, hasPermission, isAndroid, resetCapabilityCache,
} from "@/lib/utils/capabilities";
import { registerBookmarkListeners, exportBookmarks } from "@/lib/handlers/bookmarks-handler";
import { notifyConflict } from "@/lib/sync/conflict-resolver";

/**
 * These tests exist because of one field report, and every case below is a line from it.
 *
 * A user set Konode up on Fennec (Firefox for Android). The wizard told them their WebDAV
 * server had refused permission — it hadn't; the browser cannot show a permission prompt
 * at all. The History toggle would not move, and said nothing. Bookmarks failed with
 * "getTree", because that browser ships no bookmarks API.
 *
 * The shared cause is a browser whose manifest permissions and whose actual API surface
 * disagree, so the fake browser is edited per test to model exactly that. Everything is
 * restored afterwards: `test/setup.ts` rebuilds the bookmark/history/tab stores between
 * tests, but a namespace deleted off `chrome` would stay deleted for the whole file.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
const api = chrome as any;

let saved: Record<string, unknown> = {};
function replace(ns: string, value: unknown): void {
  if (!(ns in saved)) saved[ns] = api[ns];
  if (value === undefined) delete api[ns];
  else api[ns] = value;
}

beforeEach(() => {
  saved = {};
  resetCapabilityCache();
});

afterEach(() => {
  for (const [ns, value] of Object.entries(saved)) api[ns] = value;
  saved = {};
  resetCapabilityCache();
});

/** Model a browser that grants everything / nothing, and record what was asked for. */
function permissions(opts: { held?: boolean; request?: () => Promise<boolean> } = {}) {
  const requests: unknown[] = [];
  replace("permissions", {
    contains: () => Promise.resolve(opts.held ?? false),
    request: (req: unknown) => {
      requests.push(req);
      return (opts.request ?? (() => Promise.resolve(false)))();
    },
  });
  return requests;
}

describe("reading the API surface", () => {
  it("says no to a namespace the browser doesn't have at all", () => {
    replace("bookmarks", undefined);
    expect(apiPresent("bookmarks", "getTree")).toBe(false);
    expect(dataTypeApiPresent("bookmarks")).toBe(false);
  });

  it("says no to a namespace that exists but is missing the method", () => {
    // A stub object is exactly as unusable as no object, and reporting it as present is
    // how a call gets made that can only throw.
    replace("history", { search: undefined, addUrl: () => Promise.resolve() });
    expect(dataTypeApiPresent("history")).toBe(false);
  });

  it("says no to Chrome's restricted management namespace", () => {
    // The exact shape behind a reported blank Settings page. Chrome does NOT hide
    // `chrome.management` when the optional permission isn't granted: it hands back an
    // object carrying only getSelf/uninstallSelf. So `management.getAll` is not a
    // function, and calling it throws synchronously, before there is any promise for a
    // `.catch()` to catch. Inside a React effect that unmounts the tree and the page
    // renders blank. A namespace-level check would have answered "present" here.
    replace("management", { getSelf: () => Promise.resolve({}), uninstallSelf: () => Promise.resolve() });
    expect(dataTypeApiPresent("extensions")).toBe(false);
  });

  it("says yes when the method is really there", () => {
    expect(dataTypeApiPresent("bookmarks")).toBe(true);
    expect(dataTypeApiPresent("sessions")).toBe(true);
  });

  it("recognises an event, which is an object rather than a function", () => {
    // The distinction is load-bearing: checking an event with the function test answers
    // "missing" for every event that exists, which would silently unregister listeners
    // on a perfectly capable browser.
    expect(apiPresent("bookmarks", "onCreated")).toBe(false);
    expect(eventPresent("bookmarks", "onCreated")).toBe(true);
    expect(eventPresent("bookmarks", "onNothingLikeThis")).toBe(false);
  });
});

describe("whether a data type can sync here", () => {
  it("is ready when the API is present", async () => {
    expect(await dataTypeAvailability("bookmarks")).toEqual({ state: "ready" });
  });

  it("is unsupported — not 'ask for a permission' — when bookmarks are missing", async () => {
    // `bookmarks` is a REQUIRED manifest permission, so it is already held and there is
    // nothing left to request. Firefox for Android accepts the permission and ships no
    // API behind it (mozilla-mobile/fenix#21830).
    replace("bookmarks", undefined);
    expect(await dataTypeAvailability("bookmarks")).toEqual({ state: "unsupported" });
  });

  it("is unsupported when the permission IS held and the API still isn't there", async () => {
    replace("history", undefined);
    permissions({ held: true });
    expect(await dataTypeAvailability("history")).toEqual({ state: "unsupported" });
  });

  it("is a missing permission when the permission is what's missing", async () => {
    // Same missing `browser.history`, opposite meaning: on Chrome an optional-permission
    // API is undefined until it is granted, so only the permission check tells the two
    // apart — and they need opposite treatment in the UI.
    replace("history", undefined);
    permissions({ held: false });
    expect(await dataTypeAvailability("history")).toEqual({ state: "needs-permission", permission: "history" });
  });

  it("answers for all four types at once", async () => {
    replace("bookmarks", undefined);
    replace("management", undefined);
    permissions({ held: true });
    const all = await allDataTypeAvailability();
    expect(all.bookmarks.state).toBe("unsupported");
    expect(all.extensions.state).toBe("unsupported");
    expect(all.history.state).toBe("ready");
    expect(all.sessions.state).toBe("ready");
  });
});

describe("what a handler throws when the API isn't there", () => {
  it("names the browser instead of surfacing a TypeError", async () => {
    replace("bookmarks", undefined);
    // The old failure was "Cannot read properties of undefined (reading 'getTree')",
    // which reads as a crash in Konode rather than a limit of the browser.
    await expect(exportBookmarks()).rejects.toThrow(/Firefox for Android/);
    expect(() => assertDataTypeApi("bookmarks")).toThrow(/bookmarks can't sync here/);
  });

  it("stays quiet when the API is present", () => {
    expect(() => assertDataTypeApi("bookmarks")).not.toThrow();
  });
});

describe("carrying on without an API", () => {
  it("registers no bookmark listeners on a browser with no bookmarks API", () => {
    // The background script calls this at the top level, so a throw here took out the
    // rest of the module and left the extension half-built — working enough to look fine.
    replace("bookmarks", undefined);
    expect(() => registerBookmarkListeners(() => {})).not.toThrow();
  });

  it("skips the conflict notification rather than failing the sync", () => {
    // notifyConflict is called from inside a sync. The conflict is recorded and
    // resolvable in the UI either way, so a browser without notifications should lose
    // the toast and nothing else. Orion implements roughly 70% of the extension APIs,
    // which makes "this engine hasn't got that one" ordinary rather than exotic.
    replace("notifications", undefined);
    expect(() => notifyConflict("bookmarks")).not.toThrow();
  });
});

describe("obtaining a permission", () => {
  it("never prompts for a permission that is already held", async () => {
    // THE Fennec fix. Firefox for Android has no prompt, but it does let the user grant
    // permissions by hand in the add-on's own settings — and the reporter had done
    // exactly that. Asking request() about it would still answer false and send them
    // round the same dead end again.
    const requests = permissions({ held: true, request: () => Promise.resolve(false) });
    expect(await ensurePermission({ origins: ["https://cloud.example.com/*"] })).toBe("granted");
    expect(requests).toEqual([]);
  });

  it("grants when the prompt is accepted", async () => {
    permissions({ held: false, request: () => Promise.resolve(true) });
    expect(await ensurePermission({ permissions: ["history"] })).toBe("granted");
  });

  it("reports a refusal as a refusal on a browser that can prompt", async () => {
    permissions({ held: false, request: () => Promise.resolve(false) });
    expect(await ensurePermission({ permissions: ["history"] })).toBe("denied");
  });

  it("reports 'cannot-prompt' on Android rather than blaming the user", async () => {
    // permissions.request() is unimplemented on GeckoView (bugzilla 1601420): it resolves
    // false whatever the user would have said. Calling that a refusal is what produced
    // "Konode needs permission to reach your WebDAV server" with no prompt in sight.
    replace("runtime", { ...api.runtime, getPlatformInfo: () => Promise.resolve({ os: "android" }) });
    permissions({ held: false, request: () => Promise.resolve(false) });
    expect(await ensurePermission({ origins: ["https://cloud.example.com/*"] })).toBe("cannot-prompt");
  });

  it("treats a THROWING request the same as a false one", async () => {
    replace("runtime", { ...api.runtime, getPlatformInfo: () => Promise.resolve({ os: "android" }) });
    permissions({ held: false, request: () => Promise.reject(new Error("not implemented")) });
    expect(await ensurePermission({ permissions: ["tabs"] })).toBe("cannot-prompt");
  });

  it("believes what we HOLD over what request() answered", async () => {
    // A browser that grants the permission and then reports false about it is not
    // hypothetical enough to ignore, and the second check costs one call on the only
    // path that already failed.
    let granted = false;
    replace("permissions", {
      contains: () => Promise.resolve(granted),
      request: () => { granted = true; return Promise.resolve(false); },
    });
    expect(await ensurePermission({ permissions: ["history"] })).toBe("granted");
  });

  it("treats an unanswerable contains() as a no rather than an exception", async () => {
    replace("permissions", { contains: () => Promise.reject(new Error("nope")), request: () => Promise.resolve(false) });
    expect(await hasPermission({ permissions: ["history"] })).toBe(false);
  });
});

describe("identifying the platform", () => {
  it("asks the browser, not the user agent", async () => {
    const getPlatformInfo = vi.fn(() => Promise.resolve({ os: "android" }));
    replace("runtime", { ...api.runtime, getPlatformInfo });
    expect(await isAndroid()).toBe(true);
    // Cached — the answer cannot change within a page's lifetime, and the callers are
    // click handlers that must not spend an extra round trip before request().
    expect(await isAndroid()).toBe(true);
    expect(getPlatformInfo).toHaveBeenCalledTimes(1);
  });

  it("falls back to the user agent when the browser won't say", async () => {
    replace("runtime", { ...api.runtime, getPlatformInfo: () => Promise.reject(new Error("unsupported")) });
    const ua = globalThis.navigator.userAgent;
    Object.defineProperty(globalThis.navigator, "userAgent", { value: "Mozilla/5.0 (Android 14; Mobile)", configurable: true });
    try {
      expect(await isAndroid()).toBe(true);
    } finally {
      Object.defineProperty(globalThis.navigator, "userAgent", { value: ua, configurable: true });
    }
  });
});

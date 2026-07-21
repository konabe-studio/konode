/**
 * The promise-based WebExtension API namespace, resolved for the running browser.
 *
 * Chromium exposes `chrome` (promise-based in MV3); Firefox exposes a native
 * promise-based `browser` and only a callback-based `chrome`. `webextension-
 * polyfill` normalizes both: on Firefox it hands back the native `browser`, on
 * Chromium it wraps `chrome` so every call returns a promise. Import `browser`
 * from here — never touch the global `chrome`/`browser` directly in runtime code.
 *
 * The polyfill is cast to `typeof chrome` so our existing `@types/chrome` type
 * annotations (e.g. `chrome.bookmarks.BookmarkTreeNode`) stay valid — those are
 * ambient TYPE references and are unaffected; only value-position calls route
 * through this `browser` object. This keeps a single source of API types.
 *
 * (In unit tests the polyfill import is aliased to a stub — see vitest.config.ts —
 * because the real module throws when loaded outside an extension context.)
 */
import browserPolyfill from "webextension-polyfill";

export const browser = browserPolyfill as unknown as typeof chrome;
export default browser;

/**
 * Which extension store this build is running in. Firefox serves extension pages
 * from `moz-extension://`, Chromium from `chrome-extension://`, so the runtime URL
 * scheme is a reliable signal (the UA can be spoofed; this can't). Used to tag
 * synced extensions with their source store and to pick the right store link.
 */
export function currentStore(): "chrome" | "firefox" {
  try {
    return browser.runtime.getURL("").startsWith("moz-extension://") ? "firefox" : "chrome";
  } catch {
    return "chrome";
  }
}

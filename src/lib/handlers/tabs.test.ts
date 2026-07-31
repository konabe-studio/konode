import { describe, it, expect } from "vitest";
import { importSession, exportCurrentTabs } from "@/lib/handlers/tabs-handler";
import type { SyncSession } from "@/lib/types";

// Uses the in-memory chrome.tabs / chrome.windows fakes from test/setup.ts.

function session(urls: string[]): SyncSession {
  return {
    id: "s1",
    device_id: "peer",
    savedAt: "2026-07-21T00:00:00.000Z",
    label: "Peer session",
    tabs: urls.map((url) => ({ url, pinned: false })),
  };
}

describe("importSession", () => {
  it("opens EVERY tab of a multi-tab session (regression: only the 1st opened on WebKit/Orion)", async () => {
    await importSession(session([
      "https://a.com/",
      "https://b.com/",
      "https://c.com/",
    ]));
    const urls = (await chrome.tabs.query({})).map((t) => t.url as string).sort();
    expect(urls).toEqual(["https://a.com/", "https://b.com/", "https://c.com/"]);
  });

  it("skips unsafe tab URLs but still opens the safe ones", async () => {
    await importSession(session([
      "https://ok.com/",
      "javascript:alert(1)",
      "https://fine.com/",
    ]));
    const urls = (await chrome.tabs.query({})).map((t) => t.url as string).sort();
    expect(urls).toEqual(["https://fine.com/", "https://ok.com/"]);
  });

  it("opens nothing for an empty session", async () => {
    await importSession(session([]));
    expect((await chrome.tabs.query({})).length).toBe(0);
  });
});

describe("exportCurrentTabs — only plain, non-secret web pages leave the device", () => {
  const open = async (url: string): Promise<void> => { await chrome.tabs.create({ url }); };

  it("publishes http(s) tabs", async () => {
    await open("https://a.com/");
    await open("http://b.com/");
    expect((await exportCurrentTabs()).map((t) => t.url)).toEqual(["https://a.com/", "http://b.com/"]);
  });

  it("never publishes a local file:// path", async () => {
    await open("file:///C:/Users/someone/Documents/tax-return.pdf");
    await open("https://ok.com/");
    expect((await exportCurrentTabs()).map((t) => t.url)).toEqual(["https://ok.com/"]);
  });

  it("never publishes browser-internal pages on any engine", async () => {
    for (const u of [
      "chrome://settings",
      "chrome-extension://abc/page.html",
      "about:config",             // Firefox — used to be uploaded
      "moz-extension://abc/x.html", // Firefox — used to be uploaded
      "brave://settings",          // used to be uploaded
      "edge://flags",              // used to be uploaded
    ]) await open(u);
    await open("https://ok.com/");

    expect((await exportCurrentTabs()).map((t) => t.url)).toEqual(["https://ok.com/"]);
  });

  it("never publishes a tab holding an auth secret", async () => {
    // An OAuth provider returns the token in the fragment; the tab is often still open.
    await open("https://app.example.com/callback#access_token=ya29.SECRET&expires_in=3599");
    await open("https://site.example.com/reset?token=abc123");
    await open("https://ok.com/");

    expect((await exportCurrentTabs()).map((t) => t.url)).toEqual(["https://ok.com/"]);
  });

  it("does not drop a URL that merely mentions a sensitive word in a value", async () => {
    // The guard matches param KEYS (`name=`), so this must survive.
    await open("https://blog.example.com/how-to-store-a-token");
    await open("https://search.example.com/?q=password%20manager");

    expect((await exportCurrentTabs()).map((t) => t.url)).toHaveLength(2);
  });
});

// chrome.tabs/windows real typings have none of these; they are the fake's popup-blocker
// switch and its record of created windows. See test/setup.ts.
const tabsFake = chrome.tabs as unknown as { __popupBlocked: boolean };
const windowsFake = chrome.windows as unknown as {
  __created: () => Array<{ urls: string[]; focused: boolean }>;
};

describe("restoring a session lands in the window you're already in", () => {
  // 1.0.2 swapped the per-tab loop for one windows.create to get past WebKit/Orion's
  // popup blocker. It worked, but it was applied to every engine: the session started
  // arriving in a NEW window, and `pinned` was silently dropped, for everyone. Reported
  // from the field as "it used to open in the current window".
  const withPinned = (urls: string[], pinnedIdx: number[]): SyncSession => ({
    id: "s1", device_id: "peer", savedAt: "2026-07-21T00:00:00.000Z", label: "Peer session",
    tabs: urls.map((url, i) => ({ url, title: `t${i}`, pinned: pinnedIdx.includes(i) })),
  });

  it("uses the current window and opens no new one", async () => {
    await importSession(withPinned(["https://a.com/", "https://b.com/", "https://c.com/"], []));

    expect((await chrome.tabs.query({})).map((t) => t.url)).toEqual([
      "https://a.com/", "https://b.com/", "https://c.com/",
    ]);
    expect(windowsFake.__created()).toEqual([]); // the assertion the old test was missing
  });

  it("brings pinned tabs back pinned", async () => {
    // The url-array form of windows.create has no way to carry this, so it was lost.
    await importSession(withPinned(["https://a.com/", "https://b.com/"], [1]));

    const tabs = await chrome.tabs.query({});
    expect(tabs.map((t) => t.pinned)).toEqual([false, true]);
  });

  it("still restores every tab on an engine that blocks the second one", async () => {
    // Orion is not hypothetical — session restore works there with a backend you can sign
    // into on that engine (Koofr/WebDAV). Its blocker SILENTLY swallows tab 2 onward, so
    // the return value looks like success and only a tab count can catch it.
    tabsFake.__popupBlocked = true;

    await importSession(withPinned(["https://a.com/", "https://b.com/", "https://c.com/"], []));

    expect((await chrome.tabs.query({})).map((t) => t.url).sort()).toEqual([
      "https://a.com/", "https://b.com/", "https://c.com/",
    ]);
    const wins = windowsFake.__created();
    expect(wins).toHaveLength(1);
    expect(wins[0].urls).toEqual(["https://b.com/", "https://c.com/"]); // the ones that didn't land
    expect(wins[0].focused).toBe(true); // it used to open unfocused, behind everything
  });

  it("doesn't open a window for a single-tab session on a blocking engine", async () => {
    // The first tab is the one every engine allows, so there is nothing to fall back to.
    tabsFake.__popupBlocked = true;

    await importSession(withPinned(["https://only.com/"], []));

    expect(windowsFake.__created()).toEqual([]);
    expect((await chrome.tabs.query({})).map((t) => t.url)).toEqual(["https://only.com/"]);
  });
});

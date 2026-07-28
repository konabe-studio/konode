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

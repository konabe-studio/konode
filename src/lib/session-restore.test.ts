import { describe, it, expect } from "vitest";
import { openTabUrl, openTabUrls, rememberOpened, tabsToRestore } from "@/lib/session-restore";

const tabs = (...urls: string[]) => urls.map((url) => ({ url }));

describe("tabsToRestore", () => {
  it("leaves out what is open and keeps the session's order", () => {
    expect(tabsToRestore(tabs("https://a.com/", "https://b.com/", "https://c.com/"), ["https://b.com/"]))
      .toEqual(tabs("https://a.com/", "https://c.com/"));
  });

  it("matches one open tab to one session tab", () => {
    expect(tabsToRestore(tabs("https://a.com/", "https://a.com/"), ["https://a.com/"]))
      .toEqual(tabs("https://a.com/"));
  });

  it("compares canonical URLs", () => {
    expect(tabsToRestore(tabs("https://a.com"), ["https://a.com/"])).toEqual([]);
    // A real path keeps its slash difference, as everywhere else.
    expect(tabsToRestore(tabs("https://a.com/x"), ["https://a.com/x/"])).toEqual(tabs("https://a.com/x"));
  });

  it("ignores open tabs whose URL it cannot read", () => {
    expect(tabsToRestore(tabs("https://a.com/"), [undefined, undefined])).toEqual(tabs("https://a.com/"));
  });
});

describe("openTabUrl", () => {
  it("counts a tab that is still loading by where it is going", () => {
    expect(openTabUrl({ url: "", pendingUrl: "https://a.com/" })).toBe("https://a.com/");
    expect(openTabUrl({ url: "https://b.com/", pendingUrl: "https://c.com/" })).toBe("https://b.com/");
    expect(openTabUrl({})).toBeUndefined();
  });
});

describe("openTabUrls", () => {
  it("names a restored tab still at about:blank by the page it is loading, and nothing else", async () => {
    await rememberOpened([{ id: 7, url: "https://a.com/" }, { id: 8, url: "https://b.com/" }]);
    expect(await openTabUrls([
      { id: 7, url: "about:blank" },           // Firefox, still waiting for a.com
      { id: 8, url: "https://elsewhere.com/" }, // arrived, then went somewhere else: as it is now
      { id: 9, url: "about:blank" },            // not a restore's tab
      { id: 10, url: "", pendingUrl: "https://c.com/" }, // Chromium, loading
    ])).toEqual(["https://a.com/", "https://elsewhere.com/", "about:blank", "https://c.com/"]);
  });
});

import { describe, it, expect } from "vitest";
import { exportHistory, importHistory } from "@/lib/handlers/history-handler";

// Uses the in-memory chrome.history + chrome.storage fakes from test/setup.ts.
//
// NOTE on the trailing slashes below: the fake canonicalizes on addUrl the way a real
// browser does, so a bare origin comes back with its slash. Asserting the raw string used
// to pass only because the fake stored it verbatim — which is precisely what hid the
// re-add loop these tests now cover.

describe("history import/export", () => {
  it("does not re-export a URL that was only imported (CO-6)", async () => {
    // A genuine local visit on this device.
    await chrome.history.addUrl({ url: "https://local.com" });
    // An entry received from a peer via sync.
    await importHistory([{ url: "https://peer.com", lastVisitTime: 1, visitCount: 1 }]);

    const exported = (await exportHistory()).map((i) => i.url).sort();
    expect(exported).toContain("https://local.com/"); // genuine visit is published
    expect(exported).not.toContain("https://peer.com/"); // imported entry is not re-published
  });

  it("de-dups against existing local history on import", async () => {
    await chrome.history.addUrl({ url: "https://a.com" });
    await importHistory([
      { url: "https://a.com", lastVisitTime: 1, visitCount: 1 }, // already present → skipped
      { url: "https://b.com", lastVisitTime: 1, visitCount: 1 },
    ]);
    // a.com was already local (a real visit), so it must still be exportable;
    // b.com was imported, so it must NOT be re-exported.
    const exported = (await exportHistory()).map((i) => i.url).sort();
    expect(exported).toEqual(["https://a.com/"]);
  });

  it("forwards the original visit time as visitTime on import (Firefox honors it; Chrome ignores it)", async () => {
    const originalTime = 1_600_000_000_000; // a real past timestamp, not the sync moment
    await importHistory([{ url: "https://timed.com", lastVisitTime: originalTime, visitCount: 1 }]);
    const [entry] = (await chrome.history.search({ text: "", startTime: 0, maxResults: 100 }))
      .filter((h) => h.url === "https://timed.com/");
    // The fake models Firefox (honors visitTime); asserts the handler passed it through
    // rather than dropping it, so the restored entry keeps its real date.
    expect(entry?.lastVisitTime).toBe(originalTime);
  });

  it("rounds a fractional visitTime to an integer (Firefox rejects fractional ms)", async () => {
    // Chrome's history.search returns sub-ms floats; Firefox's addUrl throws
    // "visitTime must be an integer" on them. The handler must round.
    await importHistory([{ url: "https://frac.com", lastVisitTime: 1783492571151.999, visitCount: 1 }]);
    const [entry] = (await chrome.history.search({ text: "", startTime: 0, maxResults: 100 }))
      .filter((h) => h.url === "https://frac.com/");
    expect(Number.isInteger(entry.lastVisitTime)).toBe(true);
    expect(entry.lastVisitTime).toBe(1783492571152);
  });

  it("does NOT export a URL carrying an auth token (privacy — no tokens on the backend)", async () => {
    await chrome.history.addUrl({ url: "https://ok.com/article" });
    await chrome.history.addUrl({ url: "https://site.com/callback#access_token=eyJhbGciOiJ" });
    const exported = (await exportHistory()).map((i) => i.url);
    expect(exported).toContain("https://ok.com/article");
    expect(exported.some((u) => u.includes("access_token"))).toBe(false);
  });

  it("skips an auth-token URL on import (defense in depth for legacy packets)", async () => {
    await importHistory([
      { url: "https://site.com/cb?id_token=abc", lastVisitTime: 1, visitCount: 1 },
      { url: "https://good.com", lastVisitTime: 1, visitCount: 1 },
    ]);
    const all = (await chrome.history.search({ text: "", startTime: 0, maxResults: 100 })).map((h) => h.url);
    expect(all).toContain("https://good.com/");
    expect(all.some((u) => (u ?? "").includes("id_token"))).toBe(false);
  });

  it("skips unsafe URL schemes on import", async () => {
    await importHistory([
      { url: "javascript:alert(1)", lastVisitTime: 1, visitCount: 1 },
      { url: "https://ok.com", lastVisitTime: 1, visitCount: 1 },
    ]);
    // ok.com was imported (so excluded from export), javascript: was never added.
    const all = (await chrome.history.search({ text: "", startTime: 0, maxResults: 100 })).map((h) => h.url);
    expect(all).toContain("https://ok.com/");
    expect(all).not.toContain("javascript:alert(1)");
  });
});

describe("history de-dup is canonical, not string-equal", () => {
  // Browsers canonicalize on write, so a peer that published `https://x.com` never
  // matched the `https://x.com/` already in local history. Two consequences, both live:
  // the entry was re-added as a FRESH VISIT on every sync cycle forever, and the CO-6
  // "don't re-publish what I only imported" set missed too, so imported entries went
  // back out as this device's own visits and circulated the mesh.

  const localUrls = async (): Promise<string[]> =>
    (await chrome.history.search({ text: "", startTime: 0, maxResults: 1000 }))
      .map((h) => h.url as string)
      .sort();

  /** How many VISITS the browser has recorded for a URL. A re-add doesn't create a second
   *  history row — it bumps this, which is how the user actually feels the bug: an
   *  inflated visit count and a polluted "most visited" ranking. */
  const visits = async (url: string): Promise<number | undefined> =>
    (await chrome.history.search({ text: "", startTime: 0, maxResults: 1000 }))
      .find((h) => h.url === url)?.visitCount;

  it("does not re-add a URL the browser stored in canonical form", async () => {
    await chrome.history.addUrl({ url: "https://x.com" }); // browser stores https://x.com/

    await importHistory([{ url: "https://x.com", lastVisitTime: 1, visitCount: 1 }]);

    expect(await localUrls()).toEqual(["https://x.com/"]);
    expect(await visits("https://x.com/")).toBe(1); // NOT visited twice
    // And it must not have been marked as "imported" — it's a genuine local visit, so it
    // has to stay exportable.
    expect((await exportHistory()).map((i) => i.url)).toEqual(["https://x.com/"]);
  });

  it("does not keep re-adding across repeated syncs", async () => {
    const peer = [{ url: "https://y.com", lastVisitTime: 1, visitCount: 1 }];

    // Five cycles of the same unchanged peer payload — the steady state.
    for (let i = 0; i < 5; i++) await importHistory(peer);

    expect(await localUrls()).toEqual(["https://y.com/"]);
    // Imported ONCE. Raw-keyed, this was 5 — and it never stopped growing.
    expect(await visits("https://y.com/")).toBe(1);
  });

  it("keeps an imported URL out of the export despite the slash difference (CO-6)", async () => {
    await importHistory([{ url: "https://peer.com", lastVisitTime: 1, visitCount: 1 }]);

    // The local history API returns https://peer.com/ — the raw-keyed set missed it and
    // this device re-published a visit it never made.
    expect(await exportHistory()).toEqual([]);
  });

  it("normalizes host case and a default port, so those aren't re-added either", async () => {
    await chrome.history.addUrl({ url: "https://Example.COM:443/path" }); // → https://example.com/path

    await importHistory([{ url: "https://example.com/path", lastVisitTime: 1, visitCount: 1 }]);

    expect(await localUrls()).toEqual(["https://example.com/path"]);
    expect(await visits("https://example.com/path")).toBe(1);
  });

  it("still treats genuinely different paths as different (no over-merging)", async () => {
    // canonicalUrlKey only normalizes the EMPTY path — /a and /a/ stay distinct.
    await chrome.history.addUrl({ url: "https://z.com/a" });

    await importHistory([{ url: "https://z.com/a/", lastVisitTime: 1, visitCount: 1 }]);

    expect(await localUrls()).toEqual(["https://z.com/a", "https://z.com/a/"]);
  });

  it("leaves an unparseable URL to the scheme guard rather than crashing the import", async () => {
    await importHistory([
      { url: "not a url at all", lastVisitTime: 1, visitCount: 1 },
      { url: "https://fine.com", lastVisitTime: 1, visitCount: 1 },
    ]);
    expect(await localUrls()).toEqual(["https://fine.com/"]);
  });
});

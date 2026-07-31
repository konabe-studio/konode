import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

// A controllable clock. Both the handler and the history fake read Date.now(), and the
// whole design turns on comparing an import's moment against a page's last-visit time —
// which real time can't express in a test that runs in two milliseconds.
// chrome.history's real typings have neither of these; they are the fake's engine switch
// and its per-test wipe. See test/setup.ts.
const histFake = chrome.history as unknown as {
  __engine: "chrome" | "firefox";
  __reset: () => void;
  addUrl: (d: { url: string; visitTime?: number }) => Promise<void>;
};

const T0 = 1_700_000_000_000;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
let clock = T0;
const at = (t: number): void => { clock = t; };

describe("the imported set releases a page you've since visited yourself (CO-6, part 2)", () => {
  // Nothing ever left konode_hist_imported. Once a page had arrived from ANY peer, this
  // device stopped publishing it forever — even after the user genuinely browsed it here.
  // With three devices each having received most of the mesh's URLs, a day spent on
  // familiar sites exported as NOTHING. That is the field report: a day of activity on one
  // machine, "Added 0 new history entries" on the other.
  beforeEach(() => { clock = T0; vi.spyOn(Date, "now").mockImplementation(() => clock); });
  afterEach(() => { vi.restoreAllMocks(); });

  const exported = async (): Promise<string[]> => (await exportHistory()).map((i) => i.url).sort();

  it("keeps withholding a page that only ever arrived from a peer", async () => {
    await importHistory([{ url: "https://peer-only.com", lastVisitTime: T0 - DAY, visitCount: 1 }]);
    at(T0 + DAY); // plenty of time passes — still not our browsing
    expect(await exported()).toEqual([]);
  });

  it("publishes it once you visit it here yourself", async () => {
    await importHistory([{ url: "https://both.com", lastVisitTime: T0 - DAY, visitCount: 1 }]);
    expect(await exported()).toEqual([]);

    at(T0 + MINUTE); // the user navigates here
    await chrome.history.addUrl({ url: "https://both.com" });

    expect(await exported()).toEqual(["https://both.com/"]);
  });

  it("keeps publishing it on later cycles — the release is persisted", async () => {
    await importHistory([{ url: "https://both.com", lastVisitTime: T0 - DAY, visitCount: 1 }]);
    at(T0 + MINUTE);
    await chrome.history.addUrl({ url: "https://both.com" });

    await exportHistory(); // the cycle that reclaims it
    expect(await exported()).toEqual(["https://both.com/"]); // and every cycle after
  });

  it("releases only the pages you actually revisited", async () => {
    await importHistory([
      { url: "https://mine.com", lastVisitTime: T0 - DAY, visitCount: 1 },
      { url: "https://theirs.com", lastVisitTime: T0 - DAY, visitCount: 1 },
    ]);
    at(T0 + MINUTE);
    await chrome.history.addUrl({ url: "https://mine.com" });

    expect(await exported()).toEqual(["https://mine.com/"]);
  });

  it("a genuinely local page is never withheld in the first place", async () => {
    await chrome.history.addUrl({ url: "https://local.com" });
    // The same URL arriving from a peer with an OLDER visit tells us nothing we don't
    // already have, so it is skipped on import and never enters the set.
    await importHistory([{ url: "https://local.com", lastVisitTime: T0 - DAY, visitCount: 1 }]);

    expect(await exported()).toEqual(["https://local.com/"]);
  });

  it("does not mistake its own import for a visit just because the clock moved on", async () => {
    // The stamp is Date.now() while the browser records the visit a beat later, so the
    // read-back time sits just AFTER the stamp. Without the tolerance that difference
    // reads as "the user was here" and the import bounces straight back out.
    at(T0);
    await importHistory([{ url: "https://beat.com", lastVisitTime: T0 - DAY, visitCount: 1 }]);
    at(T0 + 3); // the browser's own write landed 3ms later
    await histFake.addUrl({ url: "https://beat.com", visitTime: T0 + 3 });

    expect(await exported()).toEqual([]);
  });
});

describe("history sync carries VISITS, not just pages the other device has never seen", () => {
  // importHistory de-duped on presence alone: any URL already in local history was skipped
  // outright. So a new visit on one machine never reached a machine that had ever opened
  // that page, and the log said "Added 0 new history entries". For anyone who browses the
  // same sites on both devices — the normal case — history sync did essentially nothing.
  // The blanket skip existed for a real reason: Chrome's addUrl re-records the visit every
  // cycle, which inflated visit counts. So the replacement has to move visits WITHOUT
  // reopening that loop.
  beforeEach(() => { clock = T0; vi.spyOn(Date, "now").mockImplementation(() => clock); });
  afterEach(() => { vi.restoreAllMocks(); });

  const visitCountOf = async (url: string): Promise<number | undefined> => {
    const all = await chrome.history.search({ text: "", startTime: 0, maxResults: 1000 });
    return all.find((h) => h.url === url)?.visitCount;
  };

  it("takes a peer's NEWER visit to a page we already have", async () => {
    at(T0 - 5 * DAY);
    await chrome.history.addUrl({ url: "https://news.com" }); // we read it last week

    at(T0);
    await importHistory([{ url: "https://news.com", lastVisitTime: T0 - MINUTE, visitCount: 9 }]);

    expect(await visitCountOf("https://news.com/")).toBe(2); // the peer's visit landed
  });

  it("ignores a peer visit older than what we already hold", async () => {
    at(T0);
    await chrome.history.addUrl({ url: "https://news.com" });

    await importHistory([{ url: "https://news.com", lastVisitTime: T0 - DAY, visitCount: 9 }]);

    expect(await visitCountOf("https://news.com/")).toBe(1);
  });

  it("does not take the same peer visit twice, cycle after cycle — Chrome", async () => {
    // Chrome's addUrl ignores visitTime and stamps NOW, so after the first import our own
    // time is later than the peer's and the strict `>` blocks every repeat.
    histFake.__engine = "chrome";
    at(T0 - 5 * DAY);
    await chrome.history.addUrl({ url: "https://news.com" });

    const packet = [{ url: "https://news.com", lastVisitTime: T0 - MINUTE, visitCount: 9 }];
    at(T0);
    await importHistory(packet);
    at(T0 + MINUTE);
    await importHistory(packet);
    at(T0 + 2 * MINUTE);
    await importHistory(packet);

    expect(await visitCountOf("https://news.com/")).toBe(2); // one visit, not four
  });

  it("does not take the same peer visit twice, cycle after cycle — Firefox", async () => {
    // Firefox honors visitTime, so our time becomes exactly the peer's; `>` still blocks it.
    histFake.__engine = "firefox";
    at(T0 - 5 * DAY);
    await chrome.history.addUrl({ url: "https://news.com" });

    const packet = [{ url: "https://news.com", lastVisitTime: T0 - MINUTE, visitCount: 9 }];
    at(T0);
    await importHistory(packet);
    at(T0 + MINUTE);
    await importHistory(packet);

    expect(await visitCountOf("https://news.com/")).toBe(2);
  });

  it("a visit makes one hop and stops — the receiver does not send it back", async () => {
    // The round trip is the whole risk: if the receiver republishes what it just imported,
    // the two devices trade the same page forever and the visit count climbs on both.
    histFake.__engine = "chrome";

    // ── Device A: the user reads a page today.
    at(T0);
    await chrome.history.addUrl({ url: "https://news.com" });
    const fromA = await exportHistory();
    expect(fromA.map((i) => i.url)).toEqual(["https://news.com/"]);

    // ── Device B: same page, last opened five days ago.
    histFake.__reset();
    await chrome.storage.local.clear();
    at(T0 - 5 * DAY);
    await chrome.history.addUrl({ url: "https://news.com" });

    at(T0 + MINUTE);
    await importHistory(fromA);
    expect(await visitCountOf("https://news.com/")).toBe(2); // A's visit arrived

    // B must not hand it back. (B's own five-day-old visit is swallowed with it — A
    // already has a newer one, so nothing is lost to the group, and it is the price of
    // never looping.)
    expect((await exportHistory()).map((i) => i.url)).toEqual([]);

    // Still quiet several cycles later.
    at(T0 + 10 * MINUTE);
    expect((await exportHistory()).map((i) => i.url)).toEqual([]);
    expect(await visitCountOf("https://news.com/")).toBe(2);
  });

  it("and B publishes again as soon as the user actually opens the page there", async () => {
    histFake.__engine = "chrome";
    at(T0 - 5 * DAY);
    await chrome.history.addUrl({ url: "https://news.com" });
    at(T0);
    await importHistory([{ url: "https://news.com", lastVisitTime: T0 - MINUTE, visitCount: 1 }]);
    expect((await exportHistory()).map((i) => i.url)).toEqual([]);

    at(T0 + DAY); // the next day, on this machine, the user opens it
    await chrome.history.addUrl({ url: "https://news.com" });

    expect((await exportHistory()).map((i) => i.url)).toEqual(["https://news.com/"]);
  });

  it("a page received but never opened here is still never published", async () => {
    // The CO-6 guarantee has to survive the change: receiving is not visiting.
    histFake.__engine = "chrome";
    at(T0);
    await importHistory([{ url: "https://theirs.com", lastVisitTime: T0 - DAY, visitCount: 1 }]);

    at(T0 + 30 * DAY);
    expect((await exportHistory()).map((i) => i.url)).toEqual([]);
  });
});

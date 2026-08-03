import { describe, it, expect, vi, afterEach } from "vitest";
import { importHistory, exportHistory } from "@/lib/handlers/history-handler";
import { KEYS } from "@/lib/utils/storage";

// A guard on the WORK a sync does, not on its wall-clock.
//
// Timing can't be measured here and guessing at it is how a first review pass produced
// numbers nobody had taken. Call COUNTS can be measured exactly, and they are the thing
// that was wrong: with nothing whatsoever to do, a cycle still made one addUrl call per
// permanently-rejected URL, took the rejection again, and rewrote the whole 200-entry
// audit array for each one. The log therefore turned over completely every two cycles —
// a field report showed 176 of 188 entries flagged as errors, all the same message.

const PEER_ENTRIES = 400;
const REJECTED = 50;
const REJECT_HOST = "accounts.google.com";

function peerPacket(): Array<{ url: string; title: string; lastVisitTime: number; visitCount: number }> {
  return Array.from({ length: PEER_ENTRIES }, (_, i) => ({
    url: i < REJECTED ? `https://${REJECT_HOST}/o/oauth2/reject-${i}` : `https://site${i}.example/page`,
    title: `Page ${i}`,
    lastVisitTime: 1_700_000_000_000 + i,
    visitCount: 1,
  }));
}

interface Counts { addUrls: number; auditWrites: number }

/** Counts calls, and models an engine that permanently refuses one class of URL. */
function instrument(): Counts {
  const c: Counts = { addUrls: 0, auditWrites: 0 };
  const h = chrome.history as unknown as { addUrl: (d: { url: string }) => Promise<void> };
  const realAdd = h.addUrl.bind(h);
  h.addUrl = async (d) => {
    c.addUrls++;
    if (d.url.includes(REJECT_HOST)) throw new Error("Places rejected the URL");
    return realAdd(d);
  };
  const store = chrome.storage.local as unknown as { set: (o: Record<string, unknown>) => Promise<void> };
  const realSet = store.set.bind(store);
  store.set = async (o) => { if (KEYS.AUDIT_LOG in o) c.auditWrites++; return realSet(o); };
  return c;
}

const settle = (): Promise<unknown> => new Promise((r) => setTimeout(r, 30));

afterEach(() => { vi.restoreAllMocks(); });

describe("an idle history sync must cost nothing", () => {
  it("stops re-attempting URLs the browser will never accept", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    const c = instrument();
    const packet = peerPacket();

    await importHistory(packet);
    await settle();
    // At least one call per page. A genuinely unstorable page costs one extra attempt
    // while we still don't know whether THIS browser accepts a visit time, because a
    // failure could be our property rather than their URL. Bounded, and only until the
    // first successful call settles the question.
    expect(c.addUrls).toBeGreaterThanOrEqual(PEER_ENTRIES);

    // ── Every later cycle, with nothing new on the peer. This is what runs forever.
    const before = { ...c };
    await importHistory(packet);
    await importHistory(packet); // a second peer, same cycle
    await settle();

    expect(c.addUrls - before.addUrls).toBe(0);
    expect(c.auditWrites - before.auditWrites).toBe(0);
  });

  it("collapses a burst of rejections into one line that says what and why", async () => {
    // It used to write one warning per rejected URL — 50 whole-array rewrites of the audit
    // log for one import — and the message ("Skipped a history URL the browser rejected")
    // named neither the reason nor what it meant for the user. The reason was thrown away
    // entirely by a bare `catch {}`, which is why nobody ever found out why Firefox
    // refuses these.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    const c = instrument();

    await importHistory(peerPacket());
    await settle();

    // Count the WRITES, not just how many lines match one phrase. Asserting on the message
    // alone let a re-added per-URL warn slip straight through this test — and the writes
    // are the actual cost: each one rewrites the whole 200-entry array.
    expect(c.auditWrites).toBeLessThanOrEqual(3);

    const r = await chrome.storage.local.get(KEYS.AUDIT_LOG);
    const log = (r[KEYS.AUDIT_LOG] ?? []) as Array<{ action: string; detail?: string; level?: string }>;
    const rejects = log.filter((e) => e.detail?.includes("wouldn't store"));

    expect(rejects).toHaveLength(1);
    expect(rejects[0].detail).toContain(String(REJECTED));
    expect(rejects[0].detail).toContain(REJECT_HOST);
    expect(rejects[0].detail).toContain("Places rejected the URL"); // the reason, at last
    expect(rejects[0].level).toBe("notice"); // a skip is not a failure
  });

  it("gives a rejected URL another chance a week later, not a minute later", async () => {
    // A rejection can be transient — a locked database, a momentarily malformed entry — so
    // "never again" would be wrong. Once a week is the difference between self-healing and
    // a permanent retry storm.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    const c = instrument();
    const packet = peerPacket();

    const T0 = 1_700_000_000_000;
    let clock = T0;
    vi.spyOn(Date, "now").mockImplementation(() => clock);

    await importHistory(packet);
    await settle();
    const afterFirst = c.addUrls;

    clock = T0 + 60_000; // a minute later
    await importHistory(packet);
    expect(c.addUrls).toBe(afterFirst); // not one retry

    clock = T0 + 8 * 24 * 60 * 60 * 1000; // eight days later
    await importHistory(packet);
    expect(c.addUrls).toBe(afterFirst + REJECTED); // exactly one more round
  });
});

describe("we don't publish what the other browser can never store", () => {
  it("keeps local files and browser-internal pages out of the export", async () => {
    // Only isSensitiveUrl was checked, so a Chromium device published its `file://` paths
    // and `chrome://` pages. That is a privacy leak on its own — the tab sync already
    // refuses these for exactly that reason — and the receiving browser rejects them
    // forever, so the retry storm was partly self-inflicted.
    await chrome.history.addUrl({ url: "https://ok.example/page" });
    await chrome.history.addUrl({ url: "file:///C:/Users/Ben/secret.pdf" });
    await chrome.history.addUrl({ url: "chrome://settings/passwords" });

    const urls = (await exportHistory()).map((i) => i.url);

    expect(urls).toEqual(["https://ok.example/page"]);
  });
});

describe("a first sync must not write one page at a time", () => {
  // The import awaited one addUrl per URL, in order. Each of those is a round trip out to
  // the browser process, so a reported first sync of 3,737 entries was 3,737 round trips
  // end to end with nothing overlapping. That is the "Firefox takes forever on the first
  // sync" report, and it is a shape problem rather than a volume one: the call COUNT is
  // the same either way, so counting calls can't catch a regression here. What can is how
  // many are allowed in flight at once.
  it("overlaps the writes instead of serializing them", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});

    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    const h = chrome.history as unknown as { addUrl: (d: { url: string }) => Promise<void> };
    const realAdd = h.addUrl.bind(h);
    h.addUrl = async (d) => {
      calls++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Yield twice, so a genuinely sequential loop can never look concurrent by accident.
      await new Promise((r) => setTimeout(r, 0));
      await realAdd(d);
      inFlight--;
    };

    const packet = Array.from({ length: 200 }, (_, i) => ({
      url: `https://site${i}.example/page`,
      title: `Page ${i}`,
      lastVisitTime: 1_700_000_000_000 + i,
      visitCount: 1,
    }));

    await importHistory(packet);

    expect(calls).toBe(200); // same work…
    expect(maxInFlight).toBeGreaterThan(8); // …but not one at a time
  });

  it("still writes each page exactly once when the peer repeats a URL", async () => {
    // Sequencing used to be what stopped a repeat inside one batch: each iteration saw the
    // previous one's result. Overlapped writes don't, so the dedupe has to be explicit or
    // the same page picks up two visits.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});

    await importHistory([
      { url: "https://dup.example/page", title: "A", lastVisitTime: 1_700_000_000_000, visitCount: 1 },
      { url: "https://dup.example/page", title: "A", lastVisitTime: 1_700_000_000_001, visitCount: 1 },
      { url: "https://dup.example/page/", title: "A", lastVisitTime: 1_700_000_000_002, visitCount: 1 },
    ]);

    const all = await chrome.history.search({ text: "", startTime: 0, maxResults: 100 });
    const row = all.find((e) => e.url === "https://dup.example/page");
    expect(row?.visitCount).toBe(1);
  });
});

describe("the visit time is only sent to a browser that takes it", () => {
  // Chrome validates addUrl's `details` strictly and THROWS on an unknown property, so
  // sending visitTime refused the whole call. The handler assumed for a long time that
  // passing it was "a harmless no-op on Chrome", and a bare `catch {}` hid the result: on
  // Chromium virtually every page arriving from a peer was silently dropped, because
  // virtually every one carries a visit time. It only came to light once rejections
  // started reporting their reason, in a real browser.
  const histFake = chrome.history as unknown as { __engine: "chrome" | "firefox" };

  const packet = [
    { url: "https://a.example/page", title: "A", lastVisitTime: 1_700_000_000_000, visitCount: 1 },
    { url: "https://b.example/page", title: "B", lastVisitTime: 1_700_000_000_001, visitCount: 1 },
    { url: "https://c.example/page", title: "C", lastVisitTime: 1_700_000_000_002, visitCount: 1 },
  ];

  const storedUrls = async (): Promise<string[]> =>
    (await chrome.history.search({ text: "", startTime: 0, maxResults: 100 })).map((h) => h.url as string).sort();

  it("stores the pages on a browser that refuses the property", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    histFake.__engine = "chrome";

    await importHistory(packet);

    expect(await storedUrls()).toEqual([
      "https://a.example/page", "https://b.example/page", "https://c.example/page",
    ]);
  });

  it("does not report them as pages the browser wouldn't store", async () => {
    // The user's Activity log filled with "Your browser wouldn't store 107 page(s)", which
    // read as the peer's data being at fault when the caller was.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    histFake.__engine = "chrome";

    await importHistory(packet);
    await new Promise((r) => setTimeout(r, 20));

    const r = await chrome.storage.local.get(KEYS.AUDIT_LOG);
    const log = (r[KEYS.AUDIT_LOG] ?? []) as Array<{ detail?: string }>;
    expect(log.filter((e) => e.detail?.includes("wouldn't store"))).toHaveLength(0);
  });

  it("stops sending the property once the browser has refused it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    histFake.__engine = "chrome";

    const seen: Array<number | undefined> = [];
    const h = chrome.history as unknown as {
      addUrl: (d: { url: string; visitTime?: number }) => Promise<void>;
    };
    const realAdd = h.addUrl.bind(h);
    h.addUrl = async (d) => { seen.push(d.visitTime); return realAdd(d); };

    await importHistory(packet);
    const firstRound = seen.length;
    await importHistory([
      { url: "https://d.example/page", title: "D", lastVisitTime: 1_700_000_000_003, visitCount: 1 },
    ]);

    // Whatever happened while probing, the calls AFTER the answer is known carry no time.
    expect(seen.slice(firstRound).every((t) => t === undefined)).toBe(true);
  });

  it("still passes the real date to a browser that accepts it", async () => {
    // Firefox keeps the original date, which is the whole reason to send it at all.
    vi.spyOn(console, "info").mockImplementation(() => {});
    histFake.__engine = "firefox";

    await importHistory([packet[0]]);

    const all = await chrome.history.search({ text: "", startTime: 0, maxResults: 100 });
    expect(all.find((h) => h.url === "https://a.example/page")?.lastVisitTime).toBe(1_700_000_000_000);
  });

  it("forgets rejections it recorded while it was the one at fault", async () => {
    // The rejection memory added alongside this would otherwise hold those pages back for
    // a week over our own bad call.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    await chrome.storage.local.set({
      [KEYS.HIST_REJECTED]: { "https://a.example/page": Date.now() },
    });
    histFake.__engine = "chrome";

    await importHistory(packet);

    const r = await chrome.storage.local.get(KEYS.HIST_REJECTED);
    expect(Object.keys((r[KEYS.HIST_REJECTED] ?? {}) as object)).toEqual([]);
  });
});

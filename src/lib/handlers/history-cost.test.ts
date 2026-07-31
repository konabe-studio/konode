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
    expect(c.addUrls).toBe(PEER_ENTRIES); // first sync does the work, as it must

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

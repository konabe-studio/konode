import { describe, it, expect } from "vitest";
import { exportHistory, importHistory } from "@/lib/handlers/history-handler";

// Uses the in-memory chrome.history + chrome.storage fakes from test/setup.ts.

describe("history import/export", () => {
  it("does not re-export a URL that was only imported (CO-6)", async () => {
    // A genuine local visit on this device.
    await chrome.history.addUrl({ url: "https://local.com" });
    // An entry received from a peer via sync.
    await importHistory([{ url: "https://peer.com", lastVisitTime: 1, visitCount: 1 }]);

    const exported = (await exportHistory()).map((i) => i.url).sort();
    expect(exported).toContain("https://local.com"); // genuine visit is published
    expect(exported).not.toContain("https://peer.com"); // imported entry is not re-published
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
    expect(exported).toEqual(["https://a.com"]);
  });

  it("forwards the original visit time as visitTime on import (Firefox honors it; Chrome ignores it)", async () => {
    const originalTime = 1_600_000_000_000; // a real past timestamp, not the sync moment
    await importHistory([{ url: "https://timed.com", lastVisitTime: originalTime, visitCount: 1 }]);
    const [entry] = (await chrome.history.search({ text: "", startTime: 0, maxResults: 100 }))
      .filter((h) => h.url === "https://timed.com");
    // The fake models Firefox (honors visitTime); asserts the handler passed it through
    // rather than dropping it, so the restored entry keeps its real date.
    expect(entry?.lastVisitTime).toBe(originalTime);
  });

  it("skips unsafe URL schemes on import", async () => {
    await importHistory([
      { url: "javascript:alert(1)", lastVisitTime: 1, visitCount: 1 },
      { url: "https://ok.com", lastVisitTime: 1, visitCount: 1 },
    ]);
    // ok.com was imported (so excluded from export), javascript: was never added.
    const all = (await chrome.history.search({ text: "", startTime: 0, maxResults: 100 })).map((h) => h.url);
    expect(all).toContain("https://ok.com");
    expect(all).not.toContain("javascript:alert(1)");
  });
});

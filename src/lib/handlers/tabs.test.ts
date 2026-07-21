import { describe, it, expect } from "vitest";
import { importSession } from "@/lib/handlers/tabs-handler";
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

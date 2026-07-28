import { describe, it, expect, vi, afterEach } from "vitest";
import { request } from "@/lib/utils/messaging";

// Every UI call site used to drop failures on the floor: an { type: "ERROR" } response
// nobody checked, or a rejection of the round-trip itself (a cold worker, or a handler
// that threw before answering) turning into an unhandled promise rejection. Both looked
// the same to the user — nothing happened — and some callers then rendered "no data",
// which on the restore-points screen was an outright lie.

const stubSendMessage = (impl: () => unknown): void => {
  const chromeStub = globalThis as unknown as { chrome: { runtime: Record<string, unknown> } };
  chromeStub.chrome.runtime.sendMessage = impl;
};

afterEach(() => {
  const chromeStub = globalThis as unknown as { chrome: { runtime: Record<string, unknown> } };
  delete chromeStub.chrome.runtime.sendMessage;
  vi.restoreAllMocks();
});

describe("request — failures are values, not silence", () => {
  it("passes a successful response through", async () => {
    stubSendMessage(() => Promise.resolve({ type: "SNAPSHOTS", payload: [{ name: "s", timestamp: 1 }] }));

    const r = await request({ type: "LIST_SNAPSHOTS" });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.res.type).toBe("SNAPSHOTS");
  });

  it("surfaces an ERROR response as a failure with its message", async () => {
    stubSendMessage(() => Promise.resolve({ type: "ERROR", payload: "Repository not found." }));

    const r = await request({ type: "LIST_SNAPSHOTS" });

    expect(r).toEqual({ ok: false, error: "Repository not found." });
  });

  it("surfaces a rejected round-trip instead of throwing at the call site", async () => {
    // A cold worker rejects with something like "Could not establish connection."
    stubSendMessage(() => Promise.reject(new Error("Could not establish connection.")));

    const r = await request({ type: "GET_STATE" });

    expect(r).toEqual({ ok: false, error: "Could not establish connection." });
  });

  it("still reports a failure when the rejection carries no message", async () => {
    stubSendMessage(() => Promise.reject(new Error("")));

    const r = await request({ type: "GET_STATE" });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/couldn't reach/i);
  });

  it("treats an absent response as a failure, not as empty data", async () => {
    // This is the case that produced "No restore points yet" for a load that failed.
    stubSendMessage(() => Promise.resolve(undefined));

    const r = await request({ type: "LIST_SNAPSHOTS" });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no response/i);
  });

  it("narrows ERROR out of the success type", async () => {
    stubSendMessage(() => Promise.resolve({ type: "OK" }));

    const r = await request({ type: "SYNC_NOW" });

    // The point of the union: on the ok branch the caller cannot be looking at an ERROR.
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.res.type).not.toBe("ERROR");
  });
});

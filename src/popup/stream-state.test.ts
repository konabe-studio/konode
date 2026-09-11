import { describe, it, expect } from "vitest";
import { streamState, streamInputFor, streamColor, type StreamInput } from "@/popup/stream-state";
import { DEFAULT_STATE } from "@/lib/utils/storage";
import type { SyncState } from "@/lib/types";

// Whenever a sync was not running, the old inline derivation collapsed to "synced" +
// green for every enabled type — before the first sync had ever run, and right after one
// that failed. The dots claimed all was well while the error banner above them didn't.

const base: StreamInput = {
  enabled: true, syncing: false, current: false, done: false, syncedCount: 3, lastFailed: false,
};

describe("streamState", () => {
  it("reports off for a data type that isn't enabled", () => {
    expect(streamState({ ...base, enabled: false })).toBe("off");
    // ...even mid-sync, and even if it synced in the past.
    expect(streamState({ ...base, enabled: false, syncing: true, current: true })).toBe("off");
  });

  it("reports the live states during a sync", () => {
    expect(streamState({ ...base, syncing: true, current: true })).toBe("syncing");
    expect(streamState({ ...base, syncing: true, current: false, done: false })).toBe("pending");
    expect(streamState({ ...base, syncing: true, done: true })).toBe("synced");
  });

  it("does NOT claim synced before the first cycle has ever run", () => {
    expect(streamState({ ...base, syncedCount: 0 })).toBe("never");
    expect(streamColor("never")).not.toBe(streamColor("synced")); // and not green
  });

  it("does NOT claim synced right after a failed cycle", () => {
    expect(streamState({ ...base, lastFailed: true })).toBe("stale");
    expect(streamColor("stale")).not.toBe(streamColor("synced"));
  });

  it("reports synced only when it has run and the last run was clean", () => {
    expect(streamState(base)).toBe("synced");
    expect(streamColor("synced")).toBe("text-sk-signal");
  });

  it("prefers 'never' over 'stale' — nothing has been proven at all yet", () => {
    expect(streamState({ ...base, syncedCount: 0, lastFailed: true })).toBe("never");
  });
});

describe("streamInputFor", () => {
  const state = (over: Partial<SyncState>): SyncState => ({ ...DEFAULT_STATE, ...over });

  it("reads a fresh install as never-synced, not as synced", () => {
    const input = streamInputFor("bookmarks", {
      state: state({ status: "idle" }),          // sync_counts all 0
      enabledTypes: ["bookmarks"],
      syncingType: null,
      syncedTypes: new Set(),
    });
    expect(streamState(input)).toBe("never");
  });

  it("reads a failed last cycle as stale", () => {
    const input = streamInputFor("bookmarks", {
      state: state({ status: "error", sync_counts: { bookmarks: 5, history: 0, sessions: 0, extensions: 0 } }),
      enabledTypes: ["bookmarks"],
      syncingType: null,
      syncedTypes: new Set(),
    });
    expect(streamState(input)).toBe("stale");
  });

  it("treats a null state (still loading) as nothing-proven", () => {
    const input = streamInputFor("bookmarks", {
      state: null, enabledTypes: ["bookmarks"], syncingType: null, syncedTypes: new Set(),
    });
    expect(streamState(input)).toBe("never");
  });

  describe("an error that belongs to ONE data type", () => {
    // Seen with `management` revoked: the sync reported Error, and all four circles went
    // red with a "stale" tooltip, including bookmarks and history, which had just synced
    // in that very cycle. The engine knows which type it was; this is the popup using it.
    const counts = { bookmarks: 5, history: 5, sessions: 5, extensions: 5 };
    const errored = (failed_types: SyncState["failed_types"]): SyncState =>
      state({ status: "error", sync_counts: counts, failed_types });
    const read = (type: Parameters<typeof streamInputFor>[0], st: SyncState) =>
      streamState(streamInputFor(type, {
        state: st,
        enabledTypes: ["bookmarks", "history", "sessions", "extensions"],
        syncingType: null,
        syncedTypes: new Set(),
      }));

    it("reddens the type that failed and leaves the rest alone", () => {
      const st = errored(["extensions"]);
      expect(read("extensions", st)).toBe("stale");
      expect(read("bookmarks", st)).toBe("synced");
      expect(read("history", st)).toBe("synced");
      expect(read("sessions", st)).toBe("synced");
    });

    it("reddens every type named, not just the first", () => {
      const st = errored(["history", "extensions"]);
      expect(read("history", st)).toBe("stale");
      expect(read("extensions", st)).toBe("stale");
      expect(read("bookmarks", st)).toBe("synced");
    });

    it("still reddens everything when the failure names no type", () => {
      // The backend refused, or there is none: that is every stream's problem, and the
      // empty list is how the engine says so. Same for a state written before the field
      // existed, which carries no list at all.
      for (const st of [errored([]), state({ status: "error", sync_counts: counts })]) {
        expect(read("bookmarks", st)).toBe("stale");
        expect(read("extensions", st)).toBe("stale");
      }
    });

    it("says nothing about a type while the sync is still running", () => {
      const st = state({ status: "syncing", sync_counts: counts, failed_types: ["extensions"] });
      expect(read("extensions", st)).toBe("pending");
    });
  });
});

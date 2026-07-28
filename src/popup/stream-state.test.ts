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
});

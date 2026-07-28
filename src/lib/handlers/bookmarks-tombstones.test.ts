import { describe, it, expect } from "vitest";
import {
  gcTombstones,
  mergeTombstoneLists,
  toDeletedMap,
  normalizePayload,
  exportBookmarkPayload,
} from "@/lib/handlers/bookmarks-handler";
import {
  setTombstones, getTombstones, updateTombstones,
  setMoves, getMoves, updateMoves,
} from "@/lib/utils/storage";

const now = Date.now();
const DAY = 24 * 60 * 60 * 1000;

describe("tombstone helpers", () => {
  it("gcTombstones drops entries older than 90 days and keeps the latest per url", () => {
    const out = gcTombstones([
      { url: "a", deletedAt: now - 100 * DAY }, // expired
      { url: "b", deletedAt: now - 10 * DAY },
      { url: "b", deletedAt: now - 1 * DAY }, // newer duplicate wins
    ]);
    const map = Object.fromEntries(out.map((t) => [t.url, t.deletedAt]));
    expect(map.a).toBeUndefined();
    expect(map.b).toBe(now - 1 * DAY);
  });

  it("mergeTombstoneLists unions and keeps the latest deletedAt per url", () => {
    const out = mergeTombstoneLists(
      [{ url: "a", deletedAt: now - 5 * DAY }],
      [
        { url: "a", deletedAt: now - 2 * DAY },
        { url: "c", deletedAt: now - 1 * DAY },
      ]
    );
    const map = Object.fromEntries(out.map((t) => [t.url, t.deletedAt]));
    expect(map.a).toBe(now - 2 * DAY);
    expect(map.c).toBe(now - 1 * DAY);
  });

  it("toDeletedMap keeps the max deletedAt per url", () => {
    const m = toDeletedMap([
      { url: "a", deletedAt: 1 },
      { url: "a", deletedAt: 5 },
    ]);
    expect(m.get("a")).toBe(5);
  });

  it("normalizePayload accepts the envelope shape", () => {
    const p = normalizePayload({
      tree: [{ id: "1", title: "t", parentId: null, dateAdded: 0 }],
      tombstones: [{ url: "u", deletedAt: 1 }],
    });
    expect(p.tree.length).toBe(1);
    expect(p.tombstones.length).toBe(1);
  });

  it("normalizePayload accepts the legacy bare-array shape", () => {
    const p = normalizePayload([{ id: "1", title: "t", parentId: null, dateAdded: 0 }]);
    expect(Array.isArray(p.tree)).toBe(true);
    expect(p.tombstones).toEqual([]);
  });
});

describe("change logs survive concurrent writes", () => {
  // The export prunes the stored logs, and the bookmark listeners append to them
  // unawaited — `importing` only suppresses the recorders during an IMPORT, so an
  // event landing mid-export used to read the pre-GC list and write it back,
  // silently dropping either the prune or the new record.

  it("a tombstone recorded during the export's GC is not clobbered", async () => {
    await setTombstones([
      { url: "https://keep.example", deletedAt: now - 1 * DAY },
      { url: "https://expired.example", deletedAt: now - 100 * DAY }, // GC should drop
    ]);

    const [, payload] = await Promise.all([
      updateTombstones((cur) => mergeTombstoneLists(cur, [{ url: "https://fresh.example", deletedAt: now }])),
      exportBookmarkPayload(),
    ]);

    // Whichever order the two land in, both effects must hold: the expired entry is
    // pruned AND the concurrently-recorded deletion survives.
    const stored = (await getTombstones()).map((t) => t.url).sort();
    expect(stored).toEqual(["https://fresh.example", "https://keep.example"]);
    // The payload the peers receive must not advertise a tombstone we just dropped.
    expect(payload.tombstones.map((t) => t.url)).not.toContain("https://expired.example");
  });

  it("a move recorded during the export's GC is not clobbered", async () => {
    await setMoves([
      { url: "https://keep.example", at: now - 1 * DAY },
      { url: "https://expired.example", at: now - 100 * DAY },
    ]);

    await Promise.all([
      updateMoves((cur) => [...cur, { url: "https://fresh.example", at: now }]),
      exportBookmarkPayload(),
    ]);

    expect((await getMoves()).map((m) => m.url).sort()).toEqual([
      "https://fresh.example", "https://keep.example",
    ]);
  });
});

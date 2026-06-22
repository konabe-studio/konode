import { describe, it, expect } from "vitest";
import {
  gcTombstones,
  mergeTombstoneLists,
  toDeletedMap,
  normalizePayload,
} from "@/lib/handlers/bookmarks-handler";

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

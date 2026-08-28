import { describe, it, expect } from "vitest";
import { groupConflictsByDevice } from "@/popup/conflict-groups";
import type { ConflictItem, DataType } from "@/lib/types";

function conflict(device_id: string, data_type: DataType, id = `${device_id}-${data_type}`): ConflictItem {
  return { id, data_type, device_id, device_label: `Windows · ${device_id}`, timestamp: "2026-08-28T08:00:00.000Z", resolved: false };
}

describe("groupConflictsByDevice", () => {
  it("puts every card for one device under one heading", () => {
    const groups = groupConflictsByDevice([
      conflict("helium", "bookmarks"),
      conflict("firefox", "bookmarks"),
      conflict("helium", "history"),
      conflict("firefox", "history"),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g[0].device_id)).toEqual(["helium", "firefox"]);
    expect(groups.every((g) => g.length === 2)).toBe(true);
  });

  it("keeps a row per type rather than merging a device into one decision", () => {
    // Deliberate: "keep my bookmarks, take their history" has to stay expressible.
    const [group] = groupConflictsByDevice([conflict("helium", "history"), conflict("helium", "bookmarks")]);

    expect(group.map((c) => c.data_type)).toEqual(["bookmarks", "history"]);
    expect(new Set(group.map((c) => c.id)).size).toBe(2);
  });

  it("orders groups by where the device first appears, not by name", () => {
    // The engine hands us peers newest first. Re-sorting here would throw that away, and
    // a group that moves between renders is a button someone clicks by accident.
    const groups = groupConflictsByDevice([
      conflict("zeta", "bookmarks"),
      conflict("alpha", "bookmarks"),
      conflict("zeta", "history"),
    ]);

    expect(groups.map((g) => g[0].device_id)).toEqual(["zeta", "alpha"]);
  });

  it("has nothing to group when nothing is pending", () => {
    expect(groupConflictsByDevice([])).toEqual([]);
  });
});

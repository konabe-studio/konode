import type { ConflictItem, DataType } from "@/lib/types";

/**
 * One card per DEVICE, with a row per data type inside it.
 *
 * A conflict is queued per diverging peer per conflictable type, so two other devices
 * produce four cards and three produce six. They are stacked in the popup's pinned
 * header, above the region that scrolls, so past about four the scrollable body is
 * squeezed to nothing and the popup stops being usable. Grouping is what stops the count
 * of devices from driving the height: each device costs one heading instead of a title
 * and a name per type.
 *
 * The types are NOT merged into one decision. "Keep my bookmarks but take their history"
 * is a real answer, and a single pair of buttons for a device would take it away, so each
 * type keeps its own pair. What is shared is the heading that says which device is asking.
 *
 * Order is deterministic in both directions, because these are buttons: a group appears
 * where its device first appears in the queue (which the engine already sorts newest peer
 * first), and rows inside a group follow a fixed type order rather than the order the
 * conflicts happened to be queued in. A row that moves between renders is a row someone
 * clicks by accident.
 */
const TYPE_ORDER: DataType[] = ["bookmarks", "history", "sessions", "extensions"];

export function groupConflictsByDevice(list: ConflictItem[]): ConflictItem[][] {
  const groups = new Map<string, ConflictItem[]>();
  for (const c of list) {
    const group = groups.get(c.device_id);
    if (group) group.push(c);
    else groups.set(c.device_id, [c]);
  }
  return [...groups.values()].map((group) =>
    [...group].sort((a, b) => TYPE_ORDER.indexOf(a.data_type) - TYPE_ORDER.indexOf(b.data_type))
  );
}

import { describe, it, expect } from "vitest";
import { ConflictResolver, orderPeersByTime } from "@/lib/sync/conflict-resolver";
import type { SyncPacket } from "@/lib/types";

function packet(over: Partial<SyncPacket>): SyncPacket {
  return {
    version: "1.0",
    device_id: "dev-A",
    timestamp: "2026-01-01T00:00:00.000Z",
    data_type: "bookmarks",
    checksum: "aaa",
    encrypted: false,
    payload: "[]",
    ...over,
  };
}

describe("ConflictResolver", () => {
  it("LWW: the newer timestamp wins", () => {
    const r = new ConflictResolver("lww");
    const local = packet({ device_id: "A", timestamp: "2026-01-02T00:00:00.000Z", checksum: "x" });
    const remote = packet({ device_id: "B", timestamp: "2026-01-01T00:00:00.000Z", checksum: "y" });
    const { winner, conflict } = r.resolve(local, remote);
    expect(conflict).toBeNull();
    expect(winner).toBe(local);
  });

  it("identical checksum is treated as no conflict", () => {
    const r = new ConflictResolver("lww");
    const local = packet({ device_id: "A", checksum: "same" });
    const remote = packet({ device_id: "B", checksum: "same" });
    const { winner, conflict } = r.resolve(local, remote);
    expect(conflict).toBeNull();
    expect(winner).toBe(local);
  });

  it("prefer-remote returns the remote packet", () => {
    const r = new ConflictResolver("prefer-remote");
    const local = packet({ device_id: "A", checksum: "x" });
    const remote = packet({ device_id: "B", checksum: "y" });
    expect(r.resolve(local, remote).winner).toBe(remote);
  });

  it("manual queues a METADATA-ONLY conflict — no payload rides into konode_state", () => {
    const r = new ConflictResolver("manual");
    const local = packet({ device_id: "A", checksum: "x", payload: '{"a":1}' });
    const remote = packet({ device_id: "B", checksum: "y", payload: '{"b":2}' });
    const { winner, conflict } = r.resolve(local, remote);

    expect(winner).toBeNull();
    expect(conflict?.data_type).toBe("bookmarks");
    expect(conflict?.device_id).toBe("B"); // the peer it's against — the dedupe key
    expect(conflict?.id).toBeTruthy();

    // The bulk used to be inlined here — the whole local tree, the whole remote tree AND
    // the raw packet — inside the object every setState() rewrites and every
    // STATE_UPDATE broadcasts. The engine parks the packet in its own key instead.
    expect(conflict?.local_version).toBeUndefined();
    expect(conflict?.remote_version).toBeUndefined();
    expect(conflict?.remote_packet).toBeUndefined();
    expect(JSON.stringify(conflict)).not.toContain('"b":2');
  });

  it("names the peer the card is about, so three devices ask three answerable questions", () => {
    // "Keep local or use remote" says nothing about WHICH remote. One peer you can infer;
    // three you cannot, and a card per diverging peer is the whole design. The name rides
    // outside the encrypted payload, so it survives a peer we cannot otherwise read.
    const r = new ConflictResolver("manual");
    const local = packet({ device_id: "A", checksum: "x" });
    const remote = packet({ device_id: "B", checksum: "y", device_label: "Windows · Helium" });

    expect(r.resolve(local, remote).conflict?.device_label).toBe("Windows · Helium");
  });

  it("leaves the name undefined for a peer too old to send one, rather than inventing it", () => {
    const r = new ConflictResolver("manual");
    const { conflict } = r.resolve(packet({ device_id: "A", checksum: "x" }), packet({ device_id: "B", checksum: "y" }));

    expect(conflict?.device_label).toBeUndefined();
  });

  it("queues a conflict for encrypted payloads too — it never parses them", () => {
    const r = new ConflictResolver("manual");
    const local = packet({ device_id: "A", checksum: "x", payload: "not-json-ciphertext", encrypted: true });
    const remote = packet({ device_id: "B", checksum: "y", payload: "also-ciphertext", encrypted: true });

    const { conflict } = r.resolve(local, remote);

    expect(conflict?.device_id).toBe("B");
    expect(JSON.stringify(conflict)).not.toContain("ciphertext");
  });
});

describe("orderPeersByTime", () => {
  it("orders peers newest-first regardless of input order", () => {
    const old = packet({ device_id: "old", timestamp: "2026-01-01T00:00:00.000Z" });
    const mid = packet({ device_id: "mid", timestamp: "2026-03-01T00:00:00.000Z" });
    const newest = packet({ device_id: "new", timestamp: "2026-06-01T00:00:00.000Z" });
    const out = orderPeersByTime([old, newest, mid]);
    expect(out.map((p) => p.device_id)).toEqual(["new", "mid", "old"]);
  });

  it("does not mutate the input array", () => {
    const a = packet({ device_id: "a", timestamp: "2026-01-01T00:00:00.000Z" });
    const b = packet({ device_id: "b", timestamp: "2026-02-01T00:00:00.000Z" });
    const input = [a, b];
    orderPeersByTime(input);
    expect(input.map((p) => p.device_id)).toEqual(["a", "b"]);
  });

  it("breaks equal-timestamp ties deterministically by device_id (same on every device)", () => {
    const t = "2026-03-01T00:00:00.000Z";
    const x = packet({ device_id: "x-dev", timestamp: t });
    const a = packet({ device_id: "a-dev", timestamp: t });
    const m = packet({ device_id: "m-dev", timestamp: t });
    // Two different backend listing orders must yield the SAME peers[0].
    expect(orderPeersByTime([x, a, m]).map((p) => p.device_id)).toEqual(["a-dev", "m-dev", "x-dev"]);
    expect(orderPeersByTime([m, x, a]).map((p) => p.device_id)).toEqual(["a-dev", "m-dev", "x-dev"]);
  });
});

describe("a packet nobody can date must not win, and must not scramble the order", () => {
  // Nothing validates a peer packet's timestamp, and one really did turn up without a
  // usable one — the sessions normalizer coalesces for that exact reason. `new
  // Date(undefined).getTime()` is NaN, and NaN reaches both readers of this clock.

  const undated = (over: Partial<SyncPacket> = {}): SyncPacket => {
    const p = packet({ device_id: "dev-bad", checksum: "bad", ...over });
    delete (p as { timestamp?: string }).timestamp;
    return p;
  };

  it("does not let an undatable REMOTE beat local under LWW", () => {
    // `localTime >= remoteTime` is false against NaN, so the undatable peer used to win
    // every comparison — the one outcome a packet we cannot date does not deserve.
    const r = new ConflictResolver("lww");
    const local = packet({ device_id: "me", timestamp: "2026-01-01T00:00:00.000Z" });

    expect(r.resolve(local, undated()).winner).toBe(local);
  });

  it("still lets a genuinely newer remote win", () => {
    const r = new ConflictResolver("lww");
    const local = packet({ device_id: "me", timestamp: "2026-01-01T00:00:00.000Z" });
    const remote = packet({ device_id: "peer", checksum: "bbb", timestamp: "2026-06-01T00:00:00.000Z" });

    expect(r.resolve(local, remote).winner).toBe(remote);
  });

  it("sorts an undatable packet last instead of anywhere", () => {
    const newest = packet({ device_id: "dev-new", timestamp: "2026-06-01T00:00:00.000Z" });
    const older = packet({ device_id: "dev-old", timestamp: "2026-01-01T00:00:00.000Z" });

    expect(orderPeersByTime([undated(), newest, older]).map((p) => p.device_id))
      .toEqual(["dev-new", "dev-old", "dev-bad"]);
  });

  it("orders TWO undatable packets deterministically rather than by luck", () => {
    // The subtraction form answered NaN for this pair (-Infinity minus -Infinity), and a
    // comparator returning NaN leaves the order unspecified — the very thing this function
    // exists to rule out. Both orderings of the input must give the same answer.
    const a = undated({ device_id: "dev-a" });
    const b = undated({ device_id: "dev-b" });

    expect(orderPeersByTime([a, b]).map((p) => p.device_id)).toEqual(["dev-a", "dev-b"]);
    expect(orderPeersByTime([b, a]).map((p) => p.device_id)).toEqual(["dev-a", "dev-b"]);
  });
});

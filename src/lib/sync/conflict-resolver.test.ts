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

  it("manual queues a conflict carrying the raw remote packet", () => {
    const r = new ConflictResolver("manual");
    const local = packet({ device_id: "A", checksum: "x", payload: '{"a":1}' });
    const remote = packet({ device_id: "B", checksum: "y", payload: '{"b":2}' });
    const { winner, conflict } = r.resolve(local, remote);
    expect(winner).toBeNull();
    expect(conflict?.remote_packet).toBe(remote);
    expect(conflict?.data_type).toBe("bookmarks");
  });

  it("does not raise a conflict for encrypted payloads (safeParse tolerates non-JSON)", () => {
    const r = new ConflictResolver("manual");
    const local = packet({ device_id: "A", checksum: "x", payload: "not-json-ciphertext", encrypted: true });
    const remote = packet({ device_id: "B", checksum: "y", payload: "also-ciphertext", encrypted: true });
    const { conflict } = r.resolve(local, remote);
    expect(conflict?.local_version).toBeNull();
    expect(conflict?.remote_version).toBeNull();
    expect(conflict?.remote_packet).toBe(remote);
  });

  it("mergeArraysByUrl de-dupes by url", () => {
    const r = new ConflictResolver("lww");
    const merged = r.mergeArraysByUrl(
      [{ url: "a" }, { url: "b" }],
      [{ url: "b" }, { url: "c" }]
    );
    expect(merged.map((x) => x.url)).toEqual(["a", "b", "c"]);
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

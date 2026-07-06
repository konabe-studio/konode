import type {
  ConflictItem,
  ConflictStrategy,
  SyncPacket,
  DataType,
} from "@/lib/types";
import { logger } from "@/lib/utils/logger";

// ─── Conflict Resolver ────────────────────────────────────────────────────

export class ConflictResolver {
  constructor(private strategy: ConflictStrategy) {}

  updateStrategy(strategy: ConflictStrategy): void {
    this.strategy = strategy;
  }

  /**
   * Given a local packet and a remote packet, decide which wins.
   * Returns the winning packet or null if manual resolution is needed.
   */
  resolve(
    local: SyncPacket,
    remote: SyncPacket
  ): { winner: SyncPacket | null; conflict: ConflictItem | null } {
    // Same device — no conflict
    if (local.device_id === remote.device_id) {
      return { winner: local, conflict: null };
    }

    // Same checksum — identical content, no conflict
    if (local.checksum === remote.checksum) {
      return { winner: local, conflict: null };
    }

    switch (this.strategy) {
      case "lww": {
        const localTime = new Date(local.timestamp).getTime();
        const remoteTime = new Date(remote.timestamp).getTime();
        const winner = localTime >= remoteTime ? local : remote;
        logger.info(
          "ConflictResolver",
          `LWW: ${winner === local ? "local" : "remote"} wins for ${local.data_type}`
        );
        return { winner, conflict: null };
      }

      case "prefer-local":
        logger.info("ConflictResolver", `Prefer-local for ${local.data_type}`);
        return { winner: local, conflict: null };

      case "prefer-remote":
        logger.info("ConflictResolver", `Prefer-remote for ${local.data_type}`);
        return { winner: remote, conflict: null };

      case "manual": {
        // Parsing may fail for encrypted payloads — keep the raw packet so the
        // engine can decrypt + apply on resolution; versions are best-effort.
        const safeParse = (s: string): unknown => {
          try { return JSON.parse(s); } catch { return null; }
        };
        const conflict: ConflictItem = {
          id: crypto.randomUUID(),
          data_type: local.data_type,
          local_version: safeParse(local.payload),
          remote_version: safeParse(remote.payload),
          remote_packet: remote,
          timestamp: new Date().toISOString(),
          resolved: false,
        };
        logger.warn(
          "ConflictResolver",
          `Manual conflict queued for ${local.data_type}`
        );
        return { winner: null, conflict };
      }
    }
  }

  /**
   * Merge two bookmark-like arrays by URL deduplication.
   * Used for data types where both sides can be additive (bookmarks, history).
   */
  mergeArraysByUrl<T extends { url?: string }>(
    local: T[],
    remote: T[]
  ): T[] {
    const seen = new Set<string>();
    const result: T[] = [];

    for (const item of [...local, ...remote]) {
      const key = item.url ?? JSON.stringify(item);
      if (!seen.has(key)) {
        seen.add(key);
        result.push(item);
      }
    }

    return result;
  }

  /**
   * Three-way diff: find items added/removed relative to a common base.
   * Used for bookmarks when we have a cached previous snapshot.
   */
  threeWayDiff<T extends { id: string }>(
    base: T[],
    local: T[],
    remote: T[]
  ): { merged: T[]; conflicts: Array<{ local: T; remote: T }> } {
    const baseMap = new Map(base.map((i) => [i.id, i]));
    const localMap = new Map(local.map((i) => [i.id, i]));
    const remoteMap = new Map(remote.map((i) => [i.id, i]));

    const allIds = new Set([...localMap.keys(), ...remoteMap.keys()]);
    const merged: T[] = [];
    const conflicts: Array<{ local: T; remote: T }> = [];

    for (const id of allIds) {
      const inBase = baseMap.has(id);
      const localItem = localMap.get(id);
      const remoteItem = remoteMap.get(id);

      if (localItem && !remoteItem) {
        // Only in local: added locally or deleted remotely
        if (!inBase) merged.push(localItem); // Added locally → keep
        // If it was in base and now gone from remote → deleted remotely → skip
      } else if (!localItem && remoteItem) {
        // Only in remote: added remotely or deleted locally
        if (!inBase) merged.push(remoteItem); // Added remotely → keep
      } else if (localItem && remoteItem) {
        const localStr = JSON.stringify(localItem);
        const remoteStr = JSON.stringify(remoteItem);

        if (localStr === remoteStr) {
          merged.push(localItem);
        } else {
          // Both modified → conflict
          conflicts.push({ local: localItem, remote: remoteItem });
          // Default: prefer local in merged output
          merged.push(localItem);
        }
      }
    }

    return { merged, conflicts };
  }
}

// ─── Peer ordering ─────────────────────────────────────────────────────────

/**
 * Orders peer packets newest-first by their `timestamp` (the same clock LWW uses
 * in `resolve`). Backends list files in arbitrary order (GitHub by filename, WebDAV
 * by PROPFIND order), so the engine sorts here to guarantee `peers[0]` is the most
 * recent regardless of backend. Stable copy — does not mutate the input.
 *
 * Ties (equal timestamps — common when a 1s debounce fans a change out to several
 * devices in the same second) are broken deterministically by `device_id`, so
 * `peers[0]` (the LWW / manual-conflict baseline) is IDENTICAL on every device
 * instead of depending on the backend's listing order.
 */
export function orderPeersByTime(packets: SyncPacket[]): SyncPacket[] {
  return [...packets].sort((a, b) => {
    const dt = new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
    return dt !== 0 ? dt : a.device_id.localeCompare(b.device_id);
  });
}

// ─── Notify helper ───────────────────────────────────────────────────────

export function notifyConflict(dataType: DataType): void {
  chrome.notifications.create(`conflict-${Date.now()}`, {
    type: "basic",
    iconUrl: "icons/icon48.png",
    title: "Synkro: Sync Conflict",
    message: `A conflict was detected in ${dataType}. Open Synkro to resolve it.`,
    priority: 1,
  });
}

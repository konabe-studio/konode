import type { DataType, SyncState } from "@/lib/types";

/**
 * What the popup's "Active streams" dot should say about one data type.
 *
 * This used to be derived inline, and whenever a sync was NOT running it collapsed to
 * "synced" + green for every enabled type — including before the very first sync had
 * ever happened, and immediately after one that failed. The dots claimed everything was
 * fine while the error banner right above them said otherwise.
 *
 * `never` and `stale` are the two states that were missing.
 */
export type StreamState = "off" | "syncing" | "pending" | "never" | "stale" | "synced";

export interface StreamInput {
  /** Is this data type turned on in settings? */
  enabled: boolean;
  /** Is a sync running right now? */
  syncing: boolean;
  /** Is the per-type animation currently on this type? */
  current: boolean;
  /** Has the animation already passed this type in the current run? */
  done: boolean;
  /** `state.sync_counts[type]` — 0 means it has never completed a cycle. */
  syncedCount: number;
  /** Did the last cycle end in an error? */
  lastFailed: boolean;
}

export function streamState(input: StreamInput): StreamState {
  if (!input.enabled) return "off";
  if (input.current) return "syncing";
  if (input.syncing && !input.done) return "pending";
  // Not syncing (or this type is done for this run) — now tell the truth about it.
  if (input.syncedCount === 0) return "never";
  if (input.lastFailed) return "stale";
  return "synced";
}

/** Everything `streamState` needs, pulled off the live state + settings. */
export function streamInputFor(
  type: DataType,
  opts: {
    state: SyncState | null;
    enabledTypes: DataType[] | undefined;
    syncingType: DataType | null;
    syncedTypes: Set<DataType>;
  }
): StreamInput {
  const status = opts.state?.status ?? "idle";
  return {
    enabled: opts.enabledTypes?.includes(type) ?? false,
    syncing: status === "syncing",
    current: opts.syncingType === type,
    done: opts.syncedTypes.has(type),
    syncedCount: opts.state?.sync_counts?.[type] ?? 0,
    lastFailed: status === "error",
  };
}

/** Tailwind text colour class for a stream state. */
export function streamColor(s: StreamState): string {
  switch (s) {
    case "syncing": return "text-sk-warn";
    case "stale":   return "text-sk-danger";
    case "synced":  return "text-sk-signal";
    // off / pending / never — nothing has been proven yet, so don't imply success.
    default:        return "text-sk-subtle";
  }
}

/**
 * The message key for the tooltip / aria wording — not the wording itself.
 *
 * This returned English before. Keeping the lookup out of here leaves the module free of
 * `browser.*`, so it stays a pure function the tests can call directly; the popup wraps
 * the result in `t()`. The keys live in each locale's `messages.json` as `stream_<state>`.
 */
export function streamLabelKey(s: StreamState): string {
  return `stream_${s}`;
}

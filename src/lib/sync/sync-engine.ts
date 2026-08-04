import type { SyncSettings, SyncState, DataType, SyncPacket, SyncSession, SyncExtension, ConflictItem, BackendConfig,
  DeviceInfo,
} from "@/lib/types";
import { createBackend } from "@/lib/backends/abstract-backend";
import { normalizeRepoSlug } from "@/lib/backends/github-backend";
import { createSnapshot as writeSnapshot, listSnapshots as readSnapshots, restoreSnapshot as applySnapshot, deleteSnapshot as dropSnapshot, type SnapshotMeta } from "@/lib/sync/snapshots";
import { exportBookmarkPayload, importBookmarks } from "@/lib/handlers/bookmarks-handler";
import { exportSession, importSession } from "@/lib/handlers/tabs-handler";
import { exportHistory, importHistory } from "@/lib/handlers/history-handler";
import { exportExtensions } from "@/lib/handlers/extensions-handler";
import {
  getState,
  setState,
  getRemoteSessions,
  setRemoteSession,
  setRemoteExtensions,
  getLastUploadChecksum,
  setLastUploadChecksum,
  clearUploadChecksums,
  getResolvedConflicts,
  setResolvedConflict,
  getConflictPacket,
  putConflictPacket,
  pruneConflictPackets,
  getRecoverySnapshotTaken,
  setRecoverySnapshotTaken,
  acquireSyncLock,
  releaseSyncLock,
  dropRemoteDevice,
} from "@/lib/utils/storage";
import { logger } from "@/lib/utils/logger";
import { encrypt, decrypt, sha256, verifyPassphrase } from "@/lib/crypto/encryption";
import { ConflictResolver, notifyConflict, orderPeersByTime } from "./conflict-resolver";

// How long the persisted sync lock stays valid before it's treated as stale, so a
// crashed/suspended sync self-heals. Only governs cross-instance recovery speed:
// within a live worker `isSyncing` already prevents a double-run, so this can be
// short. 2 min comfortably covers a retry-heavy multi-type sync.
const SYNC_LOCK_TTL_MS = 2 * 60 * 1000;

/**
 * A peer's encrypted data can't be read with this device's passphrase — the
 * passphrases don't match (or none is set). Thrown so the sync surfaces a clear,
 * user-visible error instead of silently skipping the peer and diverging forever.
 */
export class PassphraseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PassphraseError";
  }
}

/**
 * E2EE is off/unset on THIS device, but a peer's file is end-to-end encrypted — so
 * the group is encrypted and this device is the odd one out. Surfaced as a non-fatal
 * nudge (recorded by the syncType fold, shown after our own upload) on the device
 * that can actually fix it, rather than silently staying out of the encrypted group.
 * The mirror case (we're encrypted, a peer is plaintext) is handled in the fold by
 * skipping the plaintext peer silently — it's usually a stale/orphan file and not
 * this device's problem, so it must not warn forever.
 */
export class EncryptionMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncryptionMismatchError";
  }
}

/**
 * Whether `sync()` actually did anything. It used to return void, so a caller couldn't
 * tell a completed sync from one that bailed at the door — and the SYNC_NOW handler
 * answered a blanket `OK` either way, which is how a stranded lock turned the manual
 * "Sync now" button into a silent no-op that looked like success.
 *
 * `ran` covers a sync that failed too: the failure is recorded in the state, which is a
 * different thing from never having started.
 */
export type SyncOutcome = "ran" | "no-backend" | "already-running";

/**
 * The status a finished sync should report. `sync()` used to hard-code
 * `problems ? "error" : "success"`, which OVERWROTE the "conflict" status that syncType
 * had just set — so the popup header read "Synced" and the toolbar showed nothing while
 * unresolved conflicts sat waiting for a decision.
 *
 * Errors outrank conflicts: an error may mean nothing synced at all.
 */
export function statusAfterSync(problems: number, pendingConflicts: number): SyncState["status"] {
  if (problems > 0) return "error";
  if (pendingConflicts > 0) return "conflict";
  return "success";
}

// ─── Sync Engine ─────────────────────────────────────────────────────────

/**
 * Bump this whenever a field is added to the packet ENVELOPE (anything outside `payload`).
 *
 * The upload check compares a checksum of the payload, so a change to the envelope does not
 * look like a change at all: adding `device_label` left every existing file on the backend
 * without one, forever, because nothing about the bookmark tree had changed. The device
 * list then showed "Unnamed device" for machines that were perfectly well named.
 *
 * Folding this into the tag means one re-upload per device per bump, which is exactly the
 * cost of the change. Same mechanism the encryption form and the destination already use.
 */
const PACKET_ENVELOPE = "env2";

export class SyncEngine {
  public isSyncing = false;
  private resolver: ConflictResolver;
  // Peers we couldn't safely consume this sync because they disagree on encryption
  // (plaintext peer while we encrypt, encrypted peer we can't decrypt, or a wrong
  // passphrase). Keyed by device_id so the same peer isn't reported once per data
  // type. Non-fatal: we skip merging that peer but still upload our own file, so the
  // group self-heals once every device uses the same E2EE setting + passphrase.
  private encryptionWarnings = new Map<string, string>();
  // Bytes moved over the wire this sync (peer payloads pulled + our packets pushed),
  // accumulated across data types and folded into the cumulative `bytes_transferred`
  // stat at the end. Reset per sync so it's a per-run tally, not a running double-count.
  private bytesThisSync = 0;
  // Types whose own file is missing from the folder this sync, so the upload must go out
  // even though the local checksum record says this content already went. Rebuilt every
  // sync by `findOwnMissingFiles` and consumed by `uploadIfChanged`.
  private ownFilesMissing = new Set<DataType>();
  // Local bookmarks the mass-delete guard refused to remove this sync (recovery
  // signal). >0 → an unusual deletion was blocked; sync() saves an auto-snapshot and
  // flags state.recovery_notice so the popup can surface it.
  private bulkBlockedThisSync = 0;

  constructor(
    private settings: SyncSettings,
    private onStateChange: (state: SyncState) => void
  ) {
    this.resolver = new ConflictResolver(settings.conflict_strategy);
  }

  async updateSettings(settings: SyncSettings): Promise<void> {
    // Encryption state/passphrase change → forget the last-upload checksums so the
    // next sync re-uploads every type in the new encryption form. The checksum is
    // over the plaintext payload, so without this, toggling E2EE on wouldn't change
    // the checksum and the device's own file would stay plaintext on the backend
    // forever (peers then keep seeing it as an unencrypted device).
    const encChanged =
      this.settings.encryption_enabled !== settings.encryption_enabled ||
      this.settings.encryption_passphrase !== settings.encryption_passphrase;
    this.settings = settings;
    this.resolver.updateStrategy(settings.conflict_strategy);
    if (encChanged) await clearUploadChecksums();
  }

  /**
   * Is end-to-end encryption ACTUALLY active here — enabled AND a passphrase set?
   *
   * Not the same as "a passphrase exists": turning E2EE off keeps the passphrase in
   * settings. Conflating the two is what let the snapshot index be read as encrypted and
   * then rewritten in PLAINTEXT on shared storage. This expression was inlined in five
   * places; one accessor so the copies can't drift apart again.
   */
  private get e2eeActive(): boolean {
    return !!this.settings.encryption_enabled && !!this.settings.encryption_passphrase;
  }

  /**
   * Why this peer's packet can't be consumed here, decided WITHOUT decrypting anything.
   *
   * Two of the three encryption disagreements are visible from the packet's `encrypted`
   * flag alone, and both used to be detected only inside applyRemote — which the `manual`
   * strategy never calls. So a device on `manual` was never told it had dropped out of the
   * encrypted group, and it queued conflicts for peers whose data it could not read.
   *
   *   "silent"  we encrypt, the peer doesn't. Usually a stale/orphan file from a removed
   *             device, and not this device's problem — it must not warn forever.
   *   a message the peer encrypts and we don't: the group is encrypted and we're the odd
   *             one out. Surfaced on the device that can actually fix it.
   *   null      nothing detectable from here.
   *
   * The third case — encrypted peer, WRONG passphrase — needs an actual decrypt (a 600k
   * PBKDF2), so it is deliberately not probed here. On the auto path applyRemote still
   * catches it; on the manual path it surfaces when the user picks "Use remote", which the
   * popup now reports instead of swallowing.
   */
  private encryptionBarrier(packet: SyncPacket): "silent" | string | null {
    if (this.e2eeActive && !packet.encrypted) return "silent";
    if (packet.encrypted && !this.e2eeActive) {
      return (
        "Some of your devices are end-to-end encrypted. Enable E2EE with the same " +
        "passphrase here (Settings → Advanced) to sync with them."
      );
    }
    return null;
  }

  // ─── Main Entry Point ─────────────────────────────────────────────────

  async sync(types?: DataType[]): Promise<SyncOutcome> {
    if (this.isSyncing) {
      logger.warn("SyncEngine", "Already syncing, skipping");
      return "already-running";
    }
    // Claim the in-memory guard SYNCHRONOUSLY, before any await, so a tight
    // double-trigger can't both pass the check above and double-run one data type.
    // (It used to be set only after `await acquireSyncLock`, leaving that window
    // open.) Reset on every early return below so a no-op sync doesn't wedge it on.
    this.isSyncing = true;

    if (!this.settings.active_backend) {
      logger.warn("SyncEngine", "No active backend configured");
      this.isSyncing = false;
      return "no-backend";
    }

    const backendConfig = this.settings.backends.find(
      (b) => b.type === this.settings.active_backend
    );
    if (!backendConfig) {
      logger.warn("SyncEngine", "Active backend config not found");
      this.isSyncing = false;
      return "no-backend";
    }

    // Cross-instance guard (CO-4): a persisted TTL lock so a sync interrupted by an
    // MV3 worker suspension can't have a later wake double-run. A stale lock is
    // ignored, so a crashed sync self-heals. isSyncing (above) guards within one
    // worker instance; this guards across suspend/recreate.
    if (!(await acquireSyncLock(SYNC_LOCK_TTL_MS))) {
      logger.warn("SyncEngine", "Another sync holds the lock, skipping");
      this.isSyncing = false;
      return "already-running";
    }

    this.encryptionWarnings.clear();
    this.bytesThisSync = 0;
    this.bulkBlockedThisSync = 0;
    const state = await setState({ status: "syncing", last_error: null, recovery_notice: null });
    this.onStateChange(state);

    const backend = createBackend(backendConfig);

    try {
      await backend.connect();

      const typesToSync = types ?? this.settings.enabled_types;
      const typeErrors = await this.syncAllTypes(typesToSync, backend, state);

      // A device that disagrees on encryption isn't a hard failure — we still synced
      // and re-uploaded our own (correctly-encrypted) data, so the group self-heals
      // once it's aligned. Surface it as a visible error message so the user fixes
      // the misconfig, but only after the upload has happened (never before — that's
      // what used to deadlock the group into mutually-stale plaintext files).
      const recovery = await this.recordBlockedDeletion(
        this.bulkBlockedThisSync,
        typesToSync.includes("bookmarks"),
      );

      // Encryption disagreements and per-type failures share one surface: both mean
      // "the sync ran and published what it could, but something needs the user's
      // attention". Neither aborts the cycle.
      const problems = [...this.encryptionWarnings.values(), ...typeErrors];
      const prevState = await getState();
      const newState = await setState({
        // Read AFTER the fold, so it sees any conflict syncType just queued.
        status: statusAfterSync(problems.length, prevState.pending_conflicts.length),
        last_sync: new Date().toISOString(),
        last_error: problems.length ? problems.join(" ") : null,
        bytes_transferred: prevState.bytes_transferred + this.bytesThisSync,
        recovery_notice: recovery,
      });
      this.onStateChange(newState);
      logger.info("SyncEngine", problems.length ? `Sync complete with ${problems.length} problem(s)` : "Sync complete");

    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      const newState = await setState({ status: "error", last_error: msg });
      this.onStateChange(newState);
      logger.error("SyncEngine.sync", err);
    } finally {
      await this.finishSync(backend);
    }
    // Reached whether the sync succeeded or was recorded as an error — either way it
    // ran, which is what the caller needs to distinguish from bailing at the door.
    return "ran";
  }

  /**
   * Tear-down after a sync, in the only order that cannot strand anything.
   *
   * The `finally` block used to start with `await backend.disconnect()`, so a throw from
   * it skipped everything after: `isSyncing` stayed on for the rest of the worker's
   * lifetime (every later sync answering "already running") and the persisted lock sat
   * there until its TTL. The in-memory guard is cleared FIRST and synchronously — it
   * cannot fail — and the two awaits are isolated so neither can strand the other.
   *
   * No backend's `disconnect()` can throw today, so this is hardening rather than a live
   * bug. It costs nothing, and the previous ordering only looked safe by accident.
   */
  private async finishSync(backend: ReturnType<typeof createBackend>): Promise<void> {
    this.isSyncing = false;
    try {
      await releaseSyncLock();
    } catch (e) {
      logger.warn("SyncEngine", `Releasing the sync lock failed: ${e instanceof Error ? e.message : e}`);
    }
    try {
      await backend.disconnect();
    } catch (e) {
      logger.warn("SyncEngine", `Backend disconnect failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  /**
   * Sync every requested data type, isolating failures. One type must not take the
   * others down with it — the same principle the peer fold and the encryption warnings
   * already follow. Returns one message per failed type; `sync()` surfaces them.
   *
   * This was a bare loop whose throw propagated straight out of `sync()`, so a single
   * failing type aborted every type AFTER it and skipped the post-loop work entirely.
   * Concretely: revoking the optional `history` (or `management`) permission in
   * chrome://extensions makes the export throw, which silently stopped BOOKMARKS from
   * syncing and meant the mass-delete recovery snapshot never ran. Which types survived
   * was arbitrary too — `enabled_types` is appended to as the user toggles, so it is not
   * a fixed order.
   */
  private async syncAllTypes(
    types: DataType[],
    backend: ReturnType<typeof createBackend>,
    state: SyncState
  ): Promise<string[]> {
    const errors: string[] = [];
    await this.findOwnMissingFiles(backend, types);
    for (const dataType of types) {
      try {
        await this.syncType(dataType, backend, state);
      } catch (err) {
        // syncType already logged it — just collect the message.
        errors.push(`${dataType}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return errors;
  }

  /**
   * Put back anything of OURS that has gone missing from the folder.
   *
   * `uploadIfChanged` skips an upload when the LOCAL checksum record says this exact
   * content already went out. That record lives on this device, so it knows nothing about
   * the file being deleted at the other end — and then a payload that does not change on
   * its own is never re-uploaded. The installed-extension list is exactly that: it can sit
   * unchanged for months.
   *
   * Three ways that happens, all real:
   *  - another device used "Forget this device" on us,
   *  - the user tidied the folder by hand at their storage provider (which we have
   *    actively suggested as a workaround),
   *  - the provider lost a file.
   *
   * In every case the device carries on syncing and quietly stops publishing, which is the
   * same silent shape as the device_id bug fixed earlier: present, working, invisible.
   *
   * This only MARKS the type; `uploadIfChanged` does the re-upload and logs it. That split
   * matters, because it is not this pass's business whether an upload happens at all: an
   * EMPTY payload is deliberately never uploaded (`isPayloadEmpty`), so clearing its
   * checksum here produced a file that stayed missing, was noticed missing again on the
   * next cycle, and warned once a minute forever. Real case: a browser whose only open tab
   * is the extension page has no syncable session, so its sessions file could never come
   * back after another device used Forget on it. Marking instead means a type that is never
   * uploaded is never announced — and the type that this feature exists for (the
   * installed-extension list, unchanged for months) still goes out on the same cycle.
   *
   * One listing per sync, not per type. Never fatal: if the listing fails we simply do not
   * know, and a sync that works is worth more than this check.
   */
  private async findOwnMissingFiles(
    backend: ReturnType<typeof createBackend>,
    types: DataType[]
  ): Promise<void> {
    this.ownFilesMissing = new Set();
    let names: string[];
    try {
      names = await backend.listFiles("konode_");
    } catch {
      return;
    }
    const present = new Set(names);
    for (const dataType of types) {
      if (present.has(`konode_${dataType}_${this.settings.device_id}.json`)) continue;
      // Nothing recorded means we have never uploaded this type, so there is nothing that
      // has gone missing — leave the normal first-upload path to handle it.
      if ((await getLastUploadChecksum(dataType)) === null) continue;
      this.ownFilesMissing.add(dataType);
    }
  }

  /**
   * The mass-delete guard refused a peer's deletions this sync — the tree is still
   * intact, so preserve it as a restore point and flag the event for the popup
   * ("unusual deletion blocked", with a pointer to Settings → Activity).
   *
   * At most ONE restore point per incident. The guard re-evaluates the same peer
   * deletions on every merge (their tombstones live for 90 days and the local
   * bookmarks are still present, because we refused to remove them), so this used to
   * write a snapshot on every cycle — and with a 10-slot ring on a 60s interval that
   * evicted every pre-incident restore point within ~10 minutes, destroying exactly
   * the history the user would recover from. Repeat syncs can't add value anyway: the
   * deletions stay blocked, so the tree they'd capture is the same one.
   *
   * The latch clears on the first sync that merged bookmarks and blocked nothing — a
   * later block is then a NEW incident and earns its own restore point. `syncedBookmarks`
   * gates that: a sync that never touched bookmarks proves nothing about the guard.
   *
   * The notice itself is returned on every blocked sync (not just the first), so the
   * banner keeps showing while the situation persists.
   */
  private async recordBlockedDeletion(
    blocked: number,
    syncedBookmarks: boolean
  ): Promise<SyncState["recovery_notice"]> {
    if (blocked <= 0) {
      if (syncedBookmarks && (await getRecoverySnapshotTaken())) {
        await setRecoverySnapshotTaken(false);
      }
      return null;
    }
    if (!(await getRecoverySnapshotTaken())) {
      try {
        await this.snapshotNow();
        await setRecoverySnapshotTaken(true);
      } catch (e) {
        // Leave the latch clear so the next cycle retries the write — a failed
        // snapshot must not count as "this incident is covered".
        logger.warn("SyncEngine", `Recovery snapshot failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    return { at: new Date().toISOString(), blocked };
  }

  // ─── Snapshots (restore points) ───────────────────────────────────────

  private activeBackendConfig(): BackendConfig | null {
    return this.settings.backends.find((b) => b.type === this.settings.active_backend) ?? null;
  }

  private async withBackend<T>(fn: (b: ReturnType<typeof createBackend>) => Promise<T>): Promise<T> {
    const cfg = this.activeBackendConfig();
    if (!cfg) throw new Error("No active backend configured");
    const backend = createBackend(cfg);
    await backend.connect();
    try { return await fn(backend); }
    finally { await backend.disconnect(); }
  }

  /**
   * Every device with files in the sync folder.
   *
   * Deliberately cheap. The inventory comes from the file NAMES, and then ONE file per
   * device is fetched for its name and its timestamp — the smallest type that device has,
   * because a history packet can be megabytes and a device list has no business downloading
   * it. Both fields sit outside the encrypted payload, so this works with E2EE on and
   * without the passphrase.
   *
   * An unreadable file costs that device its name, not the whole list: the same rule as
   * downloadAll, and for the same reason.
   */
  async listDevices(): Promise<DeviceInfo[]> {
    const cfg = this.activeBackendConfig();
    if (!cfg) return [];
    return this.withBackend(async (b) => {
      const names = await b.listFiles("konode_");
      const types = new Map<string, Set<DataType>>();
      for (const name of names) {
        // konode_snap_* files live alongside these and are not per-device, so match the
        // four data types by name rather than accepting anything with an id in it.
        const m = /^konode_(bookmarks|history|sessions|extensions)_(.+)\.json$/.exec(name);
        if (!m) continue;
        const set = types.get(m[2]) ?? new Set<DataType>();
        set.add(m[1] as DataType);
        types.set(m[2], set);
      }

      // Smallest first: an extension list is a few KB, a session a few more, a bookmark
      // tree tens, history can be megabytes.
      const CHEAPEST: DataType[] = ["extensions", "sessions", "bookmarks", "history"];
      const out: DeviceInfo[] = [];
      for (const [device_id, set] of types) {
        const pick = CHEAPEST.find((t) => set.has(t));
        let label: string | null = null;
        let lastSeen: string | null = null;
        if (pick) {
          const name = `konode_${pick}_${device_id}.json`;
          try {
            const raw = await b.getFile(name);
            if (raw === null) {
              // The listing named this file a moment ago, so a null here is a real fetch
              // problem, not an old peer. Without saying so, an unreadable file and a
              // pre-name build look identical: both just show up as unnamed.
              logger.warn("listDevices", `${name} is in the folder listing but came back empty, so that device has no name here`);
            } else {
              const p = JSON.parse(raw) as Partial<SyncPacket>;
              label = p.device_label ?? null;
              lastSeen = p.timestamp ?? null;
              if (!label) {
                logger.info("listDevices", `${name} carries no device name yet; it will once that device syncs on a build that sends one`);
              }
            }
          } catch (err) {
            logger.warn("listDevices", `Couldn't read ${name} (${err instanceof Error ? err.message : err}), so that device has no name here`);
          }
        }
        out.push({
          device_id, label, lastSeen,
          types: [...set].sort(),
          isSelf: device_id === this.settings.device_id,
        });
      }
      // This device first, then the rest newest-seen first; nameless ones sink to the end.
      out.sort((a, c) => {
        if (a.isSelf !== c.isSelf) return a.isSelf ? -1 : 1;
        return (c.lastSeen ?? "").localeCompare(a.lastSeen ?? "");
      });
      return out;
    });
  }

  /**
   * Delete another device's files from the shared folder.
   *
   * This removes NO bookmarks from any browser. The merge is additive, so whatever that
   * device contributed was folded into the others long ago; all this stops is a machine
   * that is gone from going on offering its old state forever. A device that is still
   * running will upload itself again on its next sync, which the UI says out loud.
   *
   * Refuses to target this device. Doing that would delete our own contribution from every
   * peer's view, and it is not what anyone means by "forget a device"; resetting this
   * device is a different action.
   */
  async forgetDevice(deviceId: string): Promise<number> {
    if (deviceId === this.settings.device_id) {
      throw new Error("That's this device. Use Reset to disconnect this one instead.");
    }
    const removed = await this.withBackend(async (b) => {
      let n = 0;
      for (const t of ["bookmarks", "history", "sessions", "extensions"] as DataType[]) {
        try { await b.deleteFile(`konode_${t}_${deviceId}.json`); n++; }
        catch { /* not every device syncs every type; a missing file is the normal case */ }
      }
      return n;
    });
    // Its cached session and extension list are local to us, so they have to go too or the
    // popup keeps listing a device the folder no longer has.
    await dropRemoteDevice(deviceId);
    logger.event("forgetDevice", `Removed ${removed} file(s) for a device that is no longer in use`);
    return removed;
  }

  /** Write a snapshot of the current bookmark tree to the backend. */
  async snapshotNow(): Promise<SnapshotMeta> {
    return this.withBackend((b) => writeSnapshot(b, this.settings));
  }

  /** List the backend's bookmark restore points, newest first. */
  async getSnapshots(): Promise<SnapshotMeta[]> {
    const cfg = this.activeBackendConfig();
    if (!cfg) return [];
    return this.withBackend((b) => readSnapshots(b, this.settings));
  }

  /**
   * Restore a snapshot (re-adds missing bookmarks), then sync so peers get them.
   *
   * The sync is AWAITED, not detached. In MV3 it's the pending RESTORE_SNAPSHOT message
   * response that keeps the worker alive, so returning first — `void this.sync(...)` —
   * let the worker be suspended mid-upload: the user was told "restored N bookmarks"
   * while the peers got nothing, and the persisted lock was left for a later worker to
   * clear. This is the same rule the SYNC_NOW handler already spells out. The cost is a
   * slower response for a bookmarks-only sync, which is the right trade.
   */
  async restoreFromSnapshot(name: string): Promise<number> {
    const restored = await this.withBackend((b) => applySnapshot(b, name, this.settings));
    if (restored > 0) {
      const outcome = await this.sync(["bookmarks"]);
      if (outcome !== "ran") {
        // e.g. a periodic sync already holds the lock. The restore itself stands; the
        // next cycle publishes it. Worth a line so it isn't a silent gap.
        logger.warn(
          "SyncEngine",
          `Restored ${restored} bookmark(s) but couldn't publish yet (${outcome}) — the next sync will.`
        );
      }
    }
    return restored;
  }

  /** Delete one restore point from the backend. */
  async removeSnapshot(name: string): Promise<void> {
    await this.withBackend((b) => dropSnapshot(b, this.settings, name));
  }

  // ─── Per-type Sync ────────────────────────────────────────────────────

  private async syncType(
    dataType: DataType,
    backend: ReturnType<typeof createBackend>,
    _state: SyncState
  ): Promise<void> {
    logger.info("SyncEngine", `Syncing: ${dataType}`);

    try {

      // 1. PULL every peer's file (excluding our own), so we converge against
      //    ALL devices in one cycle — not just the most recent one. Order
      //    newest-first by packet timestamp: backends list files in arbitrary
      //    order, but both the manual-conflict path and the newest→oldest fold
      //    below rely on peers[0] being the most recent.
      const peers = orderPeersByTime(
        await backend.downloadAll(dataType, this.settings.device_id)
      );
      // Count pulled bytes (the serialized peer payloads) toward the transfer stat.
      for (const p of peers) this.bytesThisSync += p.payload?.length ?? 0;

      // 2. Build local payload
      const localPayload = await this.buildPayload(dataType);
      const isEmpty = this.isPayloadEmpty(dataType, localPayload);

      // Verbose troubleshooting line (only emitted when Debug mode is on).
      logger.debug("SyncEngine", `${dataType}: ${peers.length} peer(s), local ${isEmpty ? "empty" : "non-empty"}, strategy ${this.settings.conflict_strategy}`);

      // 3. Decide flow
      if (peers.length === 0) {
        // No peers yet — push our own data if we have any.
        if (!isEmpty) {
          await this.uploadIfChanged(backend, dataType, localPayload);
        } else {
          logger.info("SyncEngine", `${dataType}: nothing to sync`);
        }
      } else if (!isEmpty && this.settings.conflict_strategy === "manual") {
        // Manual: queue a conflict for EACH diverging peer, not just the newest —
        // otherwise with 3+ devices the other peers' differences are never surfaced.
        // Dedupe by data_type + peer device so the same conflict doesn't pile up
        // every cycle while it sits unresolved.
        const localPacket = await this.buildPacket(dataType, localPayload);
        const currentState = await getState();
        const already = new Set(
          currentState.pending_conflicts.map((c) => `${c.data_type}:${c.device_id}`)
        );
        // A resolution (keep-local OR keep-remote) doesn't rewrite the peer's file,
        // so the peer still diverges from us next cycle. Skip a peer we've already
        // resolved against *this exact content* (matched by checksum) so the same
        // conflict doesn't re-queue and re-notify forever. A genuine later change on
        // the peer yields a new checksum, so a fresh conflict still surfaces.
        const resolved = await getResolvedConflicts();
        const fresh: ConflictItem[] = [];
        for (const peer of peers) {
          const key = `${dataType}:${peer.device_id}`;
          if (already.has(key)) continue;
          if (resolved[key] === peer.checksum) continue;
          // Don't queue a conflict for a peer we couldn't consume even if the user picked
          // it. `manual` never reaches applyRemote, so this was the one path where an
          // encryption disagreement went completely unreported.
          const barrier = this.encryptionBarrier(peer);
          if (barrier === "silent") continue;
          if (barrier) {
            this.encryptionWarnings.set(peer.device_id, barrier);
            continue;
          }
          const { conflict } = this.resolver.resolve(localPacket, peer);
          if (conflict) {
            fresh.push(conflict);
            // Park the raw peer packet OUTSIDE konode_state — "use remote" needs it to
            // decrypt and verify, but it must not ride along on every status broadcast.
            await putConflictPacket(conflict.id, peer);
          }
        }
        if (fresh.length) {
          await setState({
            status: "conflict",
            pending_conflicts: [...currentState.pending_conflicts, ...fresh],
          });
          if (this.settings.notifications_enabled) notifyConflict(dataType);
        }
        // Publish our own file anyway. `manual` gates what we IMPORT — it was never
        // meant to stop us EXPORTING: every device writes its own
        // konode_<type>_<device_id>.json, so an upload here cannot overwrite a peer's
        // data or pre-empt the user's choice. Without it, a device on `manual` with any
        // peer present never uploaded at all (the only other upload paths are "no peers
        // yet" and a keep-local resolution), so its changes reached no other device —
        // silently, while the sync reported success. Same principle as the E2EE-mismatch
        // path above: skip the merge, still publish, let the group converge.
        await this.uploadIfChanged(backend, dataType, localPayload);
      } else {
        // Auto-resolve across ALL peers. applyRemote is non-destructive for every
        // data type (bookmarks/history merge additively + tombstones; sessions/
        // extensions are stored for display/restore), so fold each peer in — this
        // is what makes 3+ devices converge in a single cycle. Per-strategy deletion
        // handling (lww/prefer-local/prefer-remote) lives inside the bookmark merge.
        //
        // NEWEST→OLDEST (peers is already sorted newest-first). This used to fold
        // oldest→newest "so any snapshot-style store ends on the most recent peer",
        // but that reason is gone: sessions/extensions are device-keyed upserts now
        // (one entry per peer, order-irrelevant) and history is additive + deduped. So
        // ordering only affects bookmarks — where oldest-first actively RESURRECTED
        // deleted bookmarks: a stale peer still holding X was folded in before the
        // newest peer's tombstone for X was known, and since importBookmarks persists
        // each peer's tombstones before merging its tree, the fresher deletion arrived
        // too late to suppress the add. Worse, the merge's own create() stamps a fresh
        // `dateAdded` (the API can't set it), which then reads as "the user just
        // re-added this" and beats the older tombstone — so X came back and this device
        // republished it to the whole mesh. Newest-first establishes the most recent
        // deletions and moves BEFORE older trees are folded in, which also saves the
        // redundant intermediate move an older peer's stale placement used to cause.
        for (const peer of peers) {
          // We're encrypted, this peer's file is plaintext. It's either a stale/orphan
          // file (a device that was removed → its file lingers forever) or a device
          // that simply hasn't enabled E2EE yet. Either way it's not something we merge
          // into our encrypted world, and it's NOT this device's actionable problem —
          // the plaintext device gets nudged to enable E2EE on its own sync. So skip
          // it SILENTLY: this is what stops an abandoned plaintext file from warning
          // forever. (The reverse — we're plaintext, a peer is encrypted — is surfaced
          // below as a non-fatal "enable E2EE here" nudge, on the device that can fix it.)
          if (this.encryptionBarrier(peer) === "silent") {
            logger.debug("SyncEngine", `Skipping plaintext peer ${peer.device_id} (E2EE on here) — stale/unencrypted, not merged`);
            continue;
          }
          try {
            await this.applyRemote(dataType, peer, false);
          } catch (err) {
            // An encryption disagreement (plaintext peer while we encrypt, encrypted
            // peer we can't decrypt, or a wrong passphrase) must NOT be swallowed
            // silently — but it must NOT abort before our own upload either, or the
            // group deadlocks into mutually-stale files that never get re-encrypted.
            // So: skip merging this peer, record a per-device warning, keep folding
            // the rest, and let sync() upload our own file + surface the warning.
            if (err instanceof PassphraseError || err instanceof EncryptionMismatchError) {
              this.encryptionWarnings.set(peer.device_id, err.message);
              logger.warn("SyncEngine", `Encryption mismatch, skipping peer ${peer.device_id}: ${err.message}`);
              continue;
            }
            // One bad peer file (corrupt JSON, checksum mismatch, import error) must
            // not abort the whole sync — skip it and fold in the rest.
            logger.warn(
              "SyncEngine",
              `Skipping peer ${peer.device_id} for ${dataType}: ${err instanceof Error ? err.message : err}`
            );
          }
        }
        const merged = await this.buildPayload(dataType);
        if (!this.isPayloadEmpty(dataType, merged)) {
          await this.uploadIfChanged(backend, dataType, merged);
        }
      }

      // 4. Update sync count
      const currentState = await getState();
      await setState({
        sync_counts: {
          ...currentState.sync_counts,
          [dataType]: (currentState.sync_counts[dataType] ?? 0) + 1,
        },
      });
    } catch (err) {
      logger.error(`SyncEngine.syncType[${dataType}]`, err);
      throw err;
    }
  }

  // ─── Empty detection ──────────────────────────────────────────────────

  /**
   * "Empty" means there is nothing a peer could act on, so skipping the upload costs
   * the group nothing. It is NOT the same as "the tree has no bookmarks": for
   * bookmarks the payload is a `{ tree, tombstones }` envelope and the DELETION LOG
   * is content in its own right.
   *
   * Judging bookmarks on the tree alone meant that deleting every bookmark produced an
   * "empty" payload that was never uploaded — so the tombstones never left this device,
   * the deletion propagated to nobody, and our own stale remote file kept advertising
   * the entire old tree to every peer. Once the local tombstones aged out (90 days),
   * the whole tree came back.
   */
  private isPayloadEmpty(dataType: DataType, payload: unknown): boolean {
    if (!payload) return true;
    switch (dataType) {
      case "bookmarks": {
        // Payload is a { tree, tombstones } envelope (or a legacy bare array).
        const bare = Array.isArray(payload);
        const tree = bare ? payload : ((payload as { tree?: unknown[] }).tree ?? []);
        const flat = this.flattenBookmarks(tree as Array<{ children?: unknown[]; url?: string }>);
        if (flat.some((n) => n.url)) return false;
        // No bookmarks left — but a deletion still has to reach the peers.
        const tombstones = bare ? [] : ((payload as { tombstones?: unknown[] }).tombstones ?? []);
        return tombstones.length === 0;
      }
      case "history":
        return !Array.isArray(payload) || payload.length === 0;
      case "sessions": {
        // A tab-less session is nothing a peer can restore (normalizeRemoteSessions
        // drops it anyway), and uploading one OVERWRITES this device's previously-good
        // session file for every peer. That is reachable, not theoretical: revoke the
        // optional `tabs` permission and tabs.query still resolves, but every tab comes
        // back without a url, so the export filters them all out and the session goes
        // empty. Skipping the upload leaves peers with the last session they can
        // actually restore.
        const tabs = (payload as { tabs?: unknown[] }).tabs;
        return !tabs?.length;
      }
      case "extensions":
        return !Array.isArray(payload) || payload.length === 0;
      default:
        return false;
    }
  }

  private flattenBookmarks(nodes: Array<{ children?: unknown[]; url?: string }>): Array<{ url?: string }> {
    const result: Array<{ url?: string }> = [];
    const walk = (n: { children?: unknown[]; url?: string }) => {
      result.push(n);
      (n.children as Array<{ children?: unknown[]; url?: string }>)?.forEach(walk);
    };
    nodes.forEach(walk);
    return result;
  }

  // ─── Payload Builders ─────────────────────────────────────────────────

  private async buildPayload(dataType: DataType): Promise<unknown> {
    switch (dataType) {
      case "bookmarks":
        return exportBookmarkPayload();
      case "sessions": {
        // Make the synced session deterministic: identical open tabs must yield
        // an identical payload (and checksum), otherwise a fresh UUID/timestamp
        // every cycle churns versions and causes LWW ping-pong between devices.
        const session = await exportSession();
        session.id = `session_${this.settings.device_id}`;
        session.device_id = this.settings.device_id;
        session.savedAt = "";
        // Carry the human-readable device name so peers can label the session
        // list. Stable per device, so the payload stays deterministic (no churn).
        session.label = this.settings.device_label;
        return session;
      }
      case "history":
        return exportHistory(this.settings.history_days_limit);
      case "extensions":
        return exportExtensions();
      default: {
        const _e: never = dataType;
        throw new Error(`Unknown data type: ${_e}`);
      }
    }
  }

  /**
   * A stable identity for the current upload DESTINATION — the backend type plus the
   * folder/repo/server it actually writes into.
   *
   * The dedup checksum below is over the PAYLOAD, so nothing about it changes when the
   * destination does. Without this, switching provider (or GitHub repo/branch/path, or
   * WebDAV server) left the previous checksum matching, `uploadIfChanged` skipped, and
   * the NEW destination silently stayed empty while the UI reported a clean sync — only
   * a later bookmark edit healed it, which on a stable tree can be days.
   *
   * The repo is normalized the same way the backend addresses it, so re-typing
   * `owner/repo` as a full GitHub URL isn't mistaken for a move. Tokens/passwords are
   * deliberately excluded: what matters is WHERE we write, and a secret has no business
   * being copied into a second storage key.
   */
  private destinationTag(): string {
    const cfg = this.activeBackendConfig();
    if (!cfg) return "none";
    switch (cfg.type) {
      case "gdrive":
        return `gdrive:${cfg.gdrive?.folderId ?? "default"}`;
      case "github": {
        const g = cfg.github;
        return `github:${normalizeRepoSlug(g?.repo)}@${g?.branch ?? "main"}/${g?.path ?? "konode"}`;
      }
      case "webdav": {
        const w = cfg.webdav;
        return `webdav:${w?.username ?? ""}@${(w?.url ?? "").replace(/\/$/, "")}/${w?.path ?? "konode"}`;
      }
      default: {
        const _e: never = cfg.type;
        return String(_e);
      }
    }
  }

  /**
   * The "what this device last uploaded" record for a data type. The plaintext
   * checksum alone isn't enough: the encryption FORM and the DESTINATION both change
   * what actually sits on the backend WITHOUT changing the payload, so both are folded
   * in here. An old tag written by an earlier build matches neither, so an existing
   * install re-uploads once and then stabilizes — no need to re-save settings.
   */
  private uploadTag(payloadChecksum: string, useE2ee: boolean): string {
    return `${PACKET_ENVELOPE}|${this.destinationTag()}|${useE2ee ? "enc" : "plain"}:${payloadChecksum}`;
  }

  /**
   * Upload only when the payload changed since our last successful upload. The
   * checksum is over the plaintext payload (stable for identical data, independent
   * of the packet's per-cycle timestamp), so a sync that finds nothing new doesn't
   * spam the backend with a fresh commit every interval — and can't race its own
   * write into a 409.
   */
  private async uploadIfChanged(
    backend: ReturnType<typeof createBackend>,
    dataType: DataType,
    payload: unknown
  ): Promise<void> {
    // Compute the (cheap) plaintext checksum BEFORE building the full packet, so an
    // unchanged encrypted sync doesn't pay the expensive PBKDF2 for encrypt+verifier
    // on every idle interval — only when there's actually something to upload.
    // `uploadTag` folds in the encryption form + destination (see above).
    const tag = this.uploadTag(await sha256(JSON.stringify(payload)), this.e2eeActive);
    // Our file has gone from the folder (see findOwnMissingFiles), so "unchanged since our
    // last upload" is no reason to skip — there is nothing out there to be unchanged from.
    // Announced here rather than in the pre-pass so it is only ever said about an upload
    // that actually happens. Taken off the set so one sync cannot say it twice.
    const missing = this.ownFilesMissing.delete(dataType);
    if (missing) {
      logger.warn(
        "SyncEngine",
        `This device's ${dataType} file is no longer on the backend, so it will be uploaded again`
      );
    }
    if (!missing && (await getLastUploadChecksum(dataType)) === tag) {
      logger.info("SyncEngine", `${dataType}: unchanged since last upload, skipping`);
      return;
    }
    const packet = await this.buildPacket(dataType, payload);
    await backend.upload(packet);
    this.bytesThisSync += packet.payload?.length ?? 0; // pushed bytes → transfer stat
    await setLastUploadChecksum(dataType, tag);
  }

  private async buildPacket(dataType: DataType, payload: unknown): Promise<SyncPacket> {
    const payloadStr = JSON.stringify(payload);
    const useE2ee = this.e2eeActive;
    return {
      version: "1.0",
      device_id: this.settings.device_id,
      // Carried on every packet, not just the session one, so a device is nameable to its
      // peers even with Sessions turned off. Purely for display; nothing keys off it.
      device_label: this.settings.device_label,
      timestamp: new Date().toISOString(),
      data_type: dataType,
      // SHA-256 over the plaintext, so identical content across devices still
      // matches even though each encrypted blob uses a fresh IV/salt.
      // Trade-off (accepted): with E2EE on, this is a plaintext-confirmation oracle
      // — an observer of the backend could confirm a *guessed* payload by hashing
      // it. Harmless in practice: bookmark/history payloads carry far too much
      // entropy to guess whole, and switching to HMAC(key, …) would break the
      // cross-device dedup (the per-blob PBKDF2 salt makes the AES key non-stable).
      checksum: await sha256(payloadStr),
      encrypted: useE2ee,
      payload: useE2ee
        ? await encrypt(payloadStr, this.settings.encryption_passphrase!)
        : payloadStr,
      // Deliberately NO passphrase `verifier`. Earlier builds attached
      // encrypt("konode-verify-v1") to every encrypted packet, but a known-plaintext
      // blob sitting on third-party storage is a purpose-built offline brute-force
      // oracle on the passphrase. A mismatched peer fails just as loudly via the
      // payload's GCM auth failure (applyRemote throws PassphraseError), so the
      // verifier added attack surface without adding signal. Verifiers on packets
      // from older builds are still CHECKED on download for the clearer error.
    };
  }

  // ─── Remote Apply ─────────────────────────────────────────────────────

  private async applyRemote(
    dataType: DataType,
    packet: SyncPacket,
    isLocalEmpty = false
  ): Promise<void> {
    const localE2ee = this.e2eeActive;
    // Refuse to import a plaintext peer while E2EE is active here. The auto-merge
    // path already skips plaintext peers before calling applyRemote (they're stale/
    // orphan files), so this is the guard for the MANUAL resolve-remote path —
    // without it a manual "keep remote" could pull an unauthenticated plaintext
    // packet into an encrypted device, silently downgrading it. Mirrors the auto skip.
    if (!packet.encrypted && localE2ee) {
      throw new EncryptionMismatchError(
        `Device ${packet.device_id.slice(0, 8)}'s data is not end-to-end encrypted. ` +
          "Enable E2EE with the same passphrase there before merging it, so this device stays encrypted."
      );
    }
    let raw = packet.payload;
    if (packet.encrypted) {
      // Only participate in the encrypted group when E2EE is actually ACTIVE here
      // (enabled AND a passphrase set) — NOT merely when a passphrase lingers in
      // settings. A device that turned E2EE off keeps its passphrase, but it must
      // not silently decrypt an encrypted peer: doing so absorbed the group's data
      // and re-published it in plaintext, and hid the fact that this device had
      // dropped out of the encrypted group (C1). Surface it as an actionable nudge
      // on THIS device (the one that can fix it) instead of a silent partition.
      if (!localE2ee) {
        throw new EncryptionMismatchError(
          "Some of your devices are end-to-end encrypted. Enable E2EE with the same " +
            "passphrase here (Settings → Advanced) to sync with them."
        );
      }
      const pass = this.settings.encryption_passphrase!;
      // Check the peer's passphrase verifier first, so a mismatch is reported as a
      // clear "passphrases don't match" error rather than a silent decrypt skip.
      if (packet.verifier && !(await verifyPassphrase(pass, packet.verifier))) {
        throw new PassphraseError(
          `Your encryption passphrase doesn't match device ${packet.device_id.slice(0, 8)}. ` +
            "Use the same passphrase on all your devices (Settings → Advanced)."
        );
      }
      try {
        raw = await decrypt(packet.payload, pass);
      } catch {
        // No verifier on the packet (legacy) but decrypt failed — still a mismatch.
        throw new PassphraseError(
          "Could not decrypt a peer's synced data. Check that your encryption passphrase matches your other devices."
        );
      }
    }
    // Verify integrity before importing. Every packet is v1.0 with a SHA-256
    // checksum (64 hex chars); require one and reject anything without it, so a
    // tampered/corrupt file can't bypass verification by truncating or omitting
    // the checksum.
    const actual = await sha256(raw);
    if (packet.checksum?.length !== 64 || actual !== packet.checksum) {
      throw new Error("Sync packet checksum invalid or missing. Refusing to import unverified data.");
    }
    const payload = JSON.parse(raw);
    await this.applyPayload(dataType, payload, {
      device_id: packet.device_id,
      timestamp: packet.timestamp,
    }, isLocalEmpty);
  }

  /** Applies an already-decrypted, already-parsed payload for a data type. */
  private async applyPayload(
    dataType: DataType,
    payload: unknown,
    meta: { device_id: string; timestamp: string },
    isLocalEmpty: boolean
  ): Promise<void> {
    // Validate the parsed payload shape before handing untrusted remote data to
    // the Chrome APIs (a corrupt/tampered file must not crash or mis-import).
    if ((dataType === "history" || dataType === "extensions") && !Array.isArray(payload)) {
      throw new Error(`Invalid ${dataType} payload: expected an array.`);
    }
    if (dataType === "bookmarks" && !Array.isArray(payload) &&
        !Array.isArray((payload as { tree?: unknown }).tree)) {
      throw new Error("Invalid bookmarks payload: expected a tree or { tree, tombstones }.");
    }

    switch (dataType) {
      case "bookmarks":
        // Fresh device → replace; existing device → merge with deletion tracking.
        await importBookmarks(
          payload,
          isLocalEmpty ? "replace" : "merge",
          this.settings.conflict_strategy,
          this.settings.bulk_delete_percent,
          (blocked) => { this.bulkBlockedThisSync += blocked; },
        );
        break;
      case "history":
        await importHistory(payload as never);
        break;
      case "sessions":
        // Peer maps are keyed by device_id — refuse to upsert under an empty key,
        // which would create a bogus peer entry the popup then lists.
        if (!meta.device_id) {
          logger.warn("applyRemote", "Skipping session with empty device_id");
          break;
        }
        // Persist the remote session, keyed by device_id, so every peer's session
        // survives (not just the newest) and the popup can list/restore each.
        await setRemoteSession({
          device_id: meta.device_id,
          timestamp: meta.timestamp,
          session: payload as SyncSession,
        });
        logger.info("applyRemote", `Stored remote session for ${meta.device_id}`);
        break;
      case "extensions": {
        if (!meta.device_id) {
          logger.warn("applyRemote", "Skipping extensions with empty device_id");
          break;
        }
        // Store per device (keyed by device_id) so the popup can union every peer's
        // list — "missing on this device" then reflects extensions installed on ANY
        // peer, not just the newest one.
        const extensions = (payload as SyncExtension[]) ?? [];
        await setRemoteExtensions({
          device_id: meta.device_id,
          timestamp: meta.timestamp,
          extensions,
        });
        logger.info(
          "applyRemote",
          `Stored remote extensions for ${meta.device_id} (${extensions.length} items)`
        );
        break;
      }
    }
  }

  // ─── Conflict Resolution ──────────────────────────────────────────────

  /** Resolves a queued manual conflict by applying the local or remote version. */
  async resolveConflict(id: string, resolution: "local" | "remote"): Promise<void> {
    const state = await getState();
    const conflict = state.pending_conflicts.find((c) => c.id === id);
    if (!conflict) {
      logger.warn("SyncEngine", `resolveConflict: ${id} not found`);
      return;
    }

    // The peer's raw packet lives in its own storage key, out of konode_state; a
    // conflict queued by an older build still carries it inline.
    const remotePacket = (await getConflictPacket(id)) ?? conflict.remote_packet ?? null;

    if (resolution === "remote") {
      // The packet is preferred: applyRemote decrypts and verifies the checksum.
      if (remotePacket) {
        await this.applyRemote(conflict.data_type, remotePacket, false);
      } else if (conflict.remote_version !== undefined) {
        // Oldest legacy shape: only the parsed payload was stored.
        await this.applyPayload(
          conflict.data_type,
          conflict.remote_version,
          { device_id: conflict.device_id, timestamp: conflict.timestamp },
          false
        );
      } else {
        // Nothing left to apply — don't silently drop the conflict as if we had.
        throw new Error(
          "That peer's data is no longer available to apply. Keep local, or sync again to re-check the peer."
        );
      }
    } else {
      // Keep local → re-upload current local data, overwriting remote.
      const cfg = this.settings.backends.find((b) => b.type === this.settings.active_backend);
      if (cfg) {
        const backend = createBackend(cfg);
        await backend.connect();
        try {
          const payload = await this.buildPayload(conflict.data_type);
          const packet = await this.buildPacket(conflict.data_type, payload);
          await backend.upload(packet); // forced: conflict resolution overwrites remote
          // Store the same tag uploadIfChanged writes (encryption form + destination),
          // so the next periodic sync doesn't see a mismatch and re-upload needlessly.
          const useE2ee = this.e2eeActive;
          await setLastUploadChecksum(conflict.data_type, this.uploadTag(packet.checksum, useE2ee));
        } finally {
          await backend.disconnect();
        }
      }
    }

    // Remember the peer content we just resolved against so the same conflict
    // doesn't re-queue every cycle (the resolution doesn't rewrite the peer's file,
    // so it keeps diverging from ours). Keyed by data_type:device_id → peer checksum.
    if (remotePacket?.checksum) {
      await setResolvedConflict(
        `${conflict.data_type}:${conflict.device_id}`,
        remotePacket.checksum
      );
    }

    const remaining = state.pending_conflicts.filter((c) => c.id !== id);
    // Drop the packet we just consumed (and any orphan from an earlier interruption).
    await pruneConflictPackets(remaining.map((c) => c.id));
    const newState = await setState({
      pending_conflicts: remaining,
      status: remaining.length > 0 ? "conflict" : "idle",
    });
    this.onStateChange(newState);
    logger.event("SyncEngine", `Resolved conflict ${id} → ${resolution}`);
  }

  // ─── Session restore ──────────────────────────────────────────────────

  /**
   * Opens the tabs from a stored peer session. Pass a session `id` to restore a
   * specific device; omit it to restore the most recent one (legacy behavior).
   */
  async restoreSession(sessionId?: string): Promise<void> {
    const entries = await getRemoteSessions();
    const entry = sessionId
      ? entries.find((e) => e.session.id === sessionId)
      : entries[0];
    if (!entry?.session?.tabs?.length) {
      logger.warn("SyncEngine", "restoreSession: no remote session available");
      return;
    }
    await importSession(entry.session);
  }
}

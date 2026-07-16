import type { SyncSettings, SyncState, DataType, SyncPacket, SyncSession, SyncExtension, ConflictItem } from "@/lib/types";
import { createBackend } from "@/lib/backends/abstract-backend";
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
  acquireSyncLock,
  releaseSyncLock,
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

// ─── Sync Engine ─────────────────────────────────────────────────────────

export class SyncEngine {
  public isSyncing = false;
  private resolver: ConflictResolver;
  // Peers we couldn't safely consume this sync because they disagree on encryption
  // (plaintext peer while we encrypt, encrypted peer we can't decrypt, or a wrong
  // passphrase). Keyed by device_id so the same peer isn't reported once per data
  // type. Non-fatal: we skip merging that peer but still upload our own file, so the
  // group self-heals once every device uses the same E2EE setting + passphrase.
  private encryptionWarnings = new Map<string, string>();

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

  // ─── Main Entry Point ─────────────────────────────────────────────────

  async sync(types?: DataType[]): Promise<void> {
    if (this.isSyncing) {
      logger.warn("SyncEngine", "Already syncing, skipping");
      return;
    }
    // Claim the in-memory guard SYNCHRONOUSLY, before any await, so a tight
    // double-trigger can't both pass the check above and double-run one data type.
    // (It used to be set only after `await acquireSyncLock`, leaving that window
    // open.) Reset on every early return below so a no-op sync doesn't wedge it on.
    this.isSyncing = true;

    if (!this.settings.active_backend) {
      logger.warn("SyncEngine", "No active backend configured");
      this.isSyncing = false;
      return;
    }

    const backendConfig = this.settings.backends.find(
      (b) => b.type === this.settings.active_backend
    );
    if (!backendConfig) {
      logger.warn("SyncEngine", "Active backend config not found");
      this.isSyncing = false;
      return;
    }

    // Cross-instance guard (CO-4): a persisted TTL lock so a sync interrupted by an
    // MV3 worker suspension can't have a later wake double-run. A stale lock is
    // ignored, so a crashed sync self-heals. isSyncing (above) guards within one
    // worker instance; this guards across suspend/recreate.
    if (!(await acquireSyncLock(SYNC_LOCK_TTL_MS))) {
      logger.warn("SyncEngine", "Another sync holds the lock — skipping");
      this.isSyncing = false;
      return;
    }

    this.encryptionWarnings.clear();
    const state = await setState({ status: "syncing", last_error: null });
    this.onStateChange(state);

    const backend = createBackend(backendConfig);

    try {
      await backend.connect();

      const typesToSync = types ?? this.settings.enabled_types;

      for (const dataType of typesToSync) {
        await this.syncType(dataType, backend, state);
      }

      // A device that disagrees on encryption isn't a hard failure — we still synced
      // and re-uploaded our own (correctly-encrypted) data, so the group self-heals
      // once it's aligned. Surface it as a visible error message so the user fixes
      // the misconfig, but only after the upload has happened (never before — that's
      // what used to deadlock the group into mutually-stale plaintext files).
      const warnings = [...this.encryptionWarnings.values()];
      const newState = await setState({
        status: warnings.length ? "error" : "success",
        last_sync: new Date().toISOString(),
        last_error: warnings.length ? warnings.join(" ") : null,
      });
      this.onStateChange(newState);
      logger.info("SyncEngine", warnings.length ? `Sync complete with ${warnings.length} encryption warning(s)` : "Sync complete");

    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      const newState = await setState({ status: "error", last_error: msg });
      this.onStateChange(newState);
      logger.error("SyncEngine.sync", err);
    } finally {
      await backend.disconnect();
      this.isSyncing = false;
      await releaseSyncLock();
    }
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
      //    order, but the manual-conflict path and the oldest→newest fold below
      //    both assume peers[0] is the most recent.
      const peers = orderPeersByTime(
        await backend.downloadAll(dataType, this.settings.device_id)
      );

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
          const { conflict } = this.resolver.resolve(localPacket, peer);
          if (conflict) fresh.push(conflict);
        }
        if (fresh.length) {
          await setState({
            status: "conflict",
            pending_conflicts: [...currentState.pending_conflicts, ...fresh],
          });
          if (this.settings.notifications_enabled) notifyConflict(dataType);
        }
      } else {
        // Auto-resolve across ALL peers. applyRemote is non-destructive for every
        // data type (bookmarks/history merge additively + tombstones; sessions/
        // extensions are stored for display/restore), so fold each peer in — this
        // is what makes 3+ devices converge in a single cycle. Apply oldest→newest
        // so any snapshot-style store ends on the most recent peer. Per-strategy
        // deletion handling (lww/prefer-local/prefer-remote) lives inside the
        // bookmark merge.
        const localE2ee =
          this.settings.encryption_enabled && !!this.settings.encryption_passphrase;
        for (const peer of [...peers].reverse()) {
          // We're encrypted, this peer's file is plaintext. It's either a stale/orphan
          // file (a device that was removed → its file lingers forever) or a device
          // that simply hasn't enabled E2EE yet. Either way it's not something we merge
          // into our encrypted world, and it's NOT this device's actionable problem —
          // the plaintext device gets nudged to enable E2EE on its own sync. So skip
          // it SILENTLY: this is what stops an abandoned plaintext file from warning
          // forever. (The reverse — we're plaintext, a peer is encrypted — is surfaced
          // below as a non-fatal "enable E2EE here" nudge, on the device that can fix it.)
          if (localE2ee && !peer.encrypted) {
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
              logger.warn("SyncEngine", `Encryption mismatch — skipping peer ${peer.device_id}: ${err.message}`);
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

  private isPayloadEmpty(dataType: DataType, payload: unknown): boolean {
    if (!payload) return true;
    switch (dataType) {
      case "bookmarks": {
        // Payload is a { tree, tombstones } envelope (or a legacy bare array).
        const tree = Array.isArray(payload)
          ? payload
          : ((payload as { tree?: unknown[] }).tree ?? []);
        const flat = this.flattenBookmarks(tree as Array<{ children?: unknown[]; url?: string }>);
        return flat.filter((n) => n.url).length === 0;
      }
      case "history":
        return !Array.isArray(payload) || payload.length === 0;
      case "sessions":
        return false;
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
    // Tag the record with the encryption FORM (enc/plain): the checksum is over the
    // plaintext, so without the tag, toggling E2EE on wouldn't change the checksum and
    // the device's own file would stay in its old form on the backend. An old bare
    // checksum (no tag) won't match either form, so it forces one re-upload and then
    // stabilizes — this is what lets an already-mixed group self-heal on the next sync
    // without the user having to re-save settings.
    const useE2ee =
      this.settings.encryption_enabled && !!this.settings.encryption_passphrase;
    const tag = `${useE2ee ? "enc" : "plain"}:${await sha256(JSON.stringify(payload))}`;
    if ((await getLastUploadChecksum(dataType)) === tag) {
      logger.info("SyncEngine", `${dataType}: unchanged since last upload — skipping`);
      return;
    }
    const packet = await this.buildPacket(dataType, payload);
    await backend.upload(packet);
    await setLastUploadChecksum(dataType, tag);
  }

  private async buildPacket(dataType: DataType, payload: unknown): Promise<SyncPacket> {
    const payloadStr = JSON.stringify(payload);
    const useE2ee =
      this.settings.encryption_enabled && !!this.settings.encryption_passphrase;
    return {
      version: "1.0",
      device_id: this.settings.device_id,
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
    const localE2ee =
      this.settings.encryption_enabled && !!this.settings.encryption_passphrase;
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
          "Could not decrypt a peer's synced data — check that your encryption passphrase matches your other devices."
        );
      }
    }
    // Verify integrity before importing. Every packet is v1.0 with a SHA-256
    // checksum (64 hex chars); require one and reject anything without it, so a
    // tampered/corrupt file can't bypass verification by truncating or omitting
    // the checksum.
    const actual = await sha256(raw);
    if (packet.checksum?.length !== 64 || actual !== packet.checksum) {
      throw new Error("Sync packet checksum invalid or missing — refusing to import unverified data.");
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
      throw new Error(`Invalid ${dataType} payload — expected an array.`);
    }
    if (dataType === "bookmarks" && !Array.isArray(payload) &&
        !Array.isArray((payload as { tree?: unknown }).tree)) {
      throw new Error("Invalid bookmarks payload — expected a tree or { tree, tombstones }.");
    }

    switch (dataType) {
      case "bookmarks":
        // Fresh device → replace; existing device → merge with deletion tracking.
        await importBookmarks(
          payload,
          isLocalEmpty ? "replace" : "merge",
          this.settings.conflict_strategy,
          this.settings.bulk_delete_percent
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

    if (resolution === "remote") {
      // Prefer the raw packet (handles decryption); fall back to the parsed version.
      if (conflict.remote_packet) {
        await this.applyRemote(conflict.data_type, conflict.remote_packet, false);
      } else {
        await this.applyPayload(
          conflict.data_type,
          conflict.remote_version,
          { device_id: conflict.device_id, timestamp: conflict.timestamp },
          false
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
          // Store the encryption-form-tagged record (see uploadIfChanged) so the next
          // periodic sync doesn't see a format mismatch and re-upload needlessly.
          const useE2ee = this.settings.encryption_enabled && !!this.settings.encryption_passphrase;
          await setLastUploadChecksum(conflict.data_type, `${useE2ee ? "enc" : "plain"}:${packet.checksum}`);
        } finally {
          await backend.disconnect();
        }
      }
    }

    // Remember the peer content we just resolved against so the same conflict
    // doesn't re-queue every cycle (the resolution doesn't rewrite the peer's file,
    // so it keeps diverging from ours). Keyed by data_type:device_id → peer checksum.
    if (conflict.remote_packet?.checksum) {
      await setResolvedConflict(
        `${conflict.data_type}:${conflict.device_id}`,
        conflict.remote_packet.checksum
      );
    }

    const remaining = state.pending_conflicts.filter((c) => c.id !== id);
    const newState = await setState({
      pending_conflicts: remaining,
      status: remaining.length > 0 ? "conflict" : "idle",
    });
    this.onStateChange(newState);
    logger.info("SyncEngine", `Resolved conflict ${id} → ${resolution}`);
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

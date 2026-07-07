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
  acquireSyncLock,
  releaseSyncLock,
} from "@/lib/utils/storage";
import { logger } from "@/lib/utils/logger";
import { encrypt, decrypt, sha256, createKeyVerifier, verifyPassphrase } from "@/lib/crypto/encryption";
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
 * A peer is syncing UNencrypted data while E2EE is enabled on this device (or vice
 * versa) — the devices disagree on encryption. Silently merging the plaintext peer
 * would (a) mean trusting an unencrypted feed, and (b) leave that peer's data
 * readable on the storage backend even though the user turned E2EE on here. Thrown
 * so the mixed state is surfaced and blocked instead of silently degrading — the
 * reverse case (encrypted peer, no passphrase here) already throws PassphraseError.
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

  constructor(
    private settings: SyncSettings,
    private onStateChange: (state: SyncState) => void
  ) {
    this.resolver = new ConflictResolver(settings.conflict_strategy);
  }

  updateSettings(settings: SyncSettings): void {
    this.settings = settings;
    this.resolver.updateStrategy(settings.conflict_strategy);
  }

  // ─── Main Entry Point ─────────────────────────────────────────────────

  async sync(types?: DataType[]): Promise<void> {
    if (this.isSyncing) {
      logger.warn("SyncEngine", "Already syncing, skipping");
      return;
    }

    if (!this.settings.active_backend) {
      logger.warn("SyncEngine", "No active backend configured");
      return;
    }

    const backendConfig = this.settings.backends.find(
      (b) => b.type === this.settings.active_backend
    );
    if (!backendConfig) {
      logger.warn("SyncEngine", "Active backend config not found");
      return;
    }

    // Cross-instance guard (CO-4): a persisted TTL lock so a sync interrupted by an
    // MV3 worker suspension can't have a later wake double-run. A stale lock is
    // ignored, so a crashed sync self-heals. isSyncing (above) guards within one
    // worker instance; this guards across suspend/recreate.
    if (!(await acquireSyncLock(SYNC_LOCK_TTL_MS))) {
      logger.warn("SyncEngine", "Another sync holds the lock — skipping");
      return;
    }

    this.isSyncing = true;
    const state = await setState({ status: "syncing", last_error: null });
    this.onStateChange(state);

    const backend = createBackend(backendConfig);

    try {
      await backend.connect();

      const typesToSync = types ?? this.settings.enabled_types;

      for (const dataType of typesToSync) {
        await this.syncType(dataType, backend, state);
      }

      const newState = await setState({
        status: "success",
        last_sync: new Date().toISOString(),
      });
      this.onStateChange(newState);
      logger.info("SyncEngine", "Sync complete");

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
        const fresh: ConflictItem[] = [];
        for (const peer of peers) {
          if (already.has(`${dataType}:${peer.device_id}`)) continue;
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
        for (const peer of [...peers].reverse()) {
          try {
            await this.applyRemote(dataType, peer, false);
          } catch (err) {
            // A passphrase mismatch or an encryption on/off mismatch must NOT be
            // swallowed — otherwise the devices diverge silently (or a peer's data
            // sits unencrypted). Surface it loudly (outer catch → error state).
            if (err instanceof PassphraseError || err instanceof EncryptionMismatchError) throw err;
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
    const checksum = await sha256(JSON.stringify(payload));
    if ((await getLastUploadChecksum(dataType)) === checksum) {
      logger.info("SyncEngine", `${dataType}: unchanged since last upload — skipping`);
      return;
    }
    const packet = await this.buildPacket(dataType, payload);
    await backend.upload(packet);
    await setLastUploadChecksum(dataType, packet.checksum);
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
      // Attach a passphrase verifier so peers can detect a mismatch up front.
      ...(useE2ee
        ? { verifier: await createKeyVerifier(this.settings.encryption_passphrase!) }
        : {}),
    };
  }

  // ─── Remote Apply ─────────────────────────────────────────────────────

  private async applyRemote(
    dataType: DataType,
    packet: SyncPacket,
    isLocalEmpty = false
  ): Promise<void> {
    let raw = packet.payload;
    const localE2ee =
      this.settings.encryption_enabled && !!this.settings.encryption_passphrase;
    // Mixed-state guard (the half PassphraseError doesn't cover): we're encrypting,
    // but this peer's file is plaintext. Don't silently merge it — that peer's data
    // is sitting unencrypted on the backend, breaking the E2EE promise for the group.
    if (localE2ee && !packet.encrypted) {
      throw new EncryptionMismatchError(
        `Device ${packet.device_id.slice(0, 8)} is syncing unencrypted data, but end-to-end ` +
          "encryption is on here. Enable E2EE on that device with the same passphrase, or turn " +
          "it off here — mixing the two leaves that device's data unencrypted on your storage."
      );
    }
    if (packet.encrypted) {
      const pass = this.settings.encryption_passphrase;
      if (!pass) {
        throw new PassphraseError(
          "A peer's synced data is encrypted, but no passphrase is set on this device. " +
            "Enable encryption with the SAME passphrase as your other devices in Settings → Advanced."
        );
      }
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
          this.settings.conflict_strategy
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
          await setLastUploadChecksum(conflict.data_type, packet.checksum);
        } finally {
          await backend.disconnect();
        }
      }
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

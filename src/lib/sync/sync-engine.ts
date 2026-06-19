import type { SyncSettings, SyncState, DataType, SyncPacket } from "@/lib/types";
import { createBackend } from "@/lib/backends/abstract-backend";
import { exportBookmarkPayload, importBookmarks } from "@/lib/handlers/bookmarks-handler";
import { exportSession, importSession } from "@/lib/handlers/tabs-handler";
import { exportHistory, importHistory } from "@/lib/handlers/history-handler";
import { exportExtensions } from "@/lib/handlers/extensions-handler";
import { getState, setState } from "@/lib/utils/storage";
import { logger } from "@/lib/utils/logger";
import { encrypt, decrypt, sha256 } from "@/lib/crypto/encryption";
import { ConflictResolver, notifyConflict } from "./conflict-resolver";

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
      // 1. PULL remote first — always. Exclude our own file so we compare
      //    against a peer's data instead of re-reading what we just uploaded.
      const remote = await backend.download(dataType, this.settings.device_id);

      // 2. Build local payload
      const localPayload = await this.buildPayload(dataType);
      const isEmpty = this.isPayloadEmpty(dataType, localPayload);

      // 3. Decide flow based on state
      if (remote && remote.device_id !== this.settings.device_id) {
        // Remote exists from another device
        if (isEmpty) {
          // Fresh device → replace entire structure
          logger.info("SyncEngine", `${dataType}: fresh device, applying remote`);
          await this.applyRemote(dataType, remote, true);
          const freshPayload = await this.buildPayload(dataType);
          if (!this.isPayloadEmpty(dataType, freshPayload)) {
            await backend.upload(await this.buildPacket(dataType, freshPayload));
          }
        } else if (this.settings.conflict_strategy === "manual") {
          // Manual: queue the conflict for the user to resolve from the popup.
          const localPacket = await this.buildPacket(dataType, localPayload);
          const { conflict } = this.resolver.resolve(localPacket, remote);
          if (conflict) {
            const currentState = await getState();
            await setState({
              status: "conflict",
              pending_conflicts: [...currentState.pending_conflicts, conflict],
            });
            if (this.settings.notifications_enabled) notifyConflict(dataType);
          }
        } else {
          // Auto-resolve. applyRemote is NON-destructive for every current data
          // type (bookmarks/history merge additively by URL; sessions/extensions
          // are just stored for display/restore), so — unless the user explicitly
          // chose "prefer-local" — always pull the peer's data in, then push the
          // merged result. Without this, LWW always picked the local packet (its
          // timestamp is the sync time, i.e. "now"), so remote additions from
          // another device never arrived.
          if (this.settings.conflict_strategy !== "prefer-local") {
            await this.applyRemote(dataType, remote, false);
          }
          const mergedPayload = await this.buildPayload(dataType);
          await backend.upload(await this.buildPacket(dataType, mergedPayload));
        }
      } else if (!isEmpty) {
        // No remote from other device, but we have local data → push
        await backend.upload(await this.buildPacket(dataType, localPayload));
      } else {
        // Both empty — nothing to do
        logger.info("SyncEngine", `${dataType}: nothing to sync`);
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
        session.label = "Current session";
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
      checksum: await sha256(payloadStr),
      encrypted: useE2ee,
      payload: useE2ee
        ? await encrypt(payloadStr, this.settings.encryption_passphrase!)
        : payloadStr,
    };
  }

  // ─── Remote Apply ─────────────────────────────────────────────────────

  private async applyRemote(
    dataType: DataType,
    packet: SyncPacket,
    isLocalEmpty = false
  ): Promise<void> {
    let raw = packet.payload;
    if (packet.encrypted) {
      if (!this.settings.encryption_passphrase) {
        throw new Error(
          "Remote data is encrypted, but no passphrase is set on this device. " +
            "Enable encryption and enter the same passphrase in Settings → Advanced."
        );
      }
      raw = await decrypt(packet.payload, this.settings.encryption_passphrase);
    }
    // Verify integrity before importing. Legacy packets used a short djb2 hash;
    // only verify when the checksum is a SHA-256 hex string (64 chars).
    if (packet.checksum?.length === 64) {
      const actual = await sha256(raw);
      if (actual !== packet.checksum) {
        throw new Error("Sync packet checksum mismatch — refusing to import corrupted data.");
      }
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
        // Persist the remote session so the user can restore it on demand
        // (RESTORE_SESSION → restoreSession()). Previously this only logged.
        await chrome.storage.local.set({
          synkro_remote_sessions: {
            device_id: meta.device_id,
            timestamp: meta.timestamp,
            session: payload,
          },
        });
        logger.info("applyRemote", "Stored remote session for restore");
        break;
      case "extensions":
        await chrome.storage.local.set({
          synkro_remote_extensions: {
            device_id: meta.device_id,
            timestamp: meta.timestamp,
            extensions: payload,
          },
        });
        logger.info(
          "applyRemote",
          `Stored remote extensions list (${Array.isArray(payload) ? payload.length : 0} items)`
        );
        break;
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
          { device_id: "", timestamp: conflict.timestamp },
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
          await backend.upload(await this.buildPacket(conflict.data_type, payload));
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

  /** Opens the tabs from the most recently downloaded remote session. */
  async restoreSession(): Promise<void> {
    const r = await chrome.storage.local.get("synkro_remote_sessions");
    const session = r["synkro_remote_sessions"]?.session;
    if (!session?.tabs?.length) {
      logger.warn("SyncEngine", "restoreSession: no remote session available");
      return;
    }
    await importSession(session);
  }
}

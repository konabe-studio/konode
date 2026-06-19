import type { SyncSettings, SyncState, DataType, SyncPacket } from "@/lib/types";
import { createBackend } from "@/lib/backends/abstract-backend";
import { exportBookmarks, importBookmarks } from "@/lib/handlers/bookmarks-handler";
import { exportSession } from "@/lib/handlers/tabs-handler";
import { exportHistory, importHistory } from "@/lib/handlers/history-handler";
import { exportExtensions } from "@/lib/handlers/extensions-handler";
import { getState, setState } from "@/lib/utils/storage";
import { logger } from "@/lib/utils/logger";
import { encrypt, decrypt } from "@/lib/crypto/encryption";
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
      // 1. PULL remote first — always
      const remote = await backend.download(dataType);

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
        } else {
          // Both have data → conflict resolution
          const localPacket = await this.buildPacket(dataType, localPayload);
          const { winner, conflict } = this.resolver.resolve(localPacket, remote);

          if (conflict) {
            const currentState = await getState();
            await setState({
              status: "conflict",
              pending_conflicts: [...currentState.pending_conflicts, conflict],
            });
            if (this.settings.notifications_enabled) notifyConflict(dataType);
          } else if (winner) {
            if (winner.device_id !== this.settings.device_id) {
              await this.applyRemote(dataType, winner, false);
            }
            await backend.upload(await this.buildPacket(dataType, localPayload));
          }
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
        const flat = this.flattenBookmarks(payload as Array<{ children?: unknown[]; url?: string }>);
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
        return exportBookmarks();
      case "sessions":
        return exportSession();
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
      // Checksum is over the plaintext so identical content across devices
      // still matches even though each blob uses a fresh IV/salt.
      checksum: this.simpleChecksum(payloadStr),
      encrypted: useE2ee,
      payload: useE2ee
        ? await encrypt(payloadStr, this.settings.encryption_passphrase!)
        : payloadStr,
    };
  }

  private simpleChecksum(str: string): string {
    // Simple djb2 hash for non-security checksum
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
    }
    return (hash >>> 0).toString(16);
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
    const payload = JSON.parse(raw);

    switch (dataType) {
      case "bookmarks":
        // Fresh device → replace entire structure (preserves folders)
        // Existing device → merge (add missing, don't overwrite)
        await importBookmarks(payload, isLocalEmpty ? "replace" : "merge");
        break;
      case "history":
        await importHistory(payload);
        break;
      case "sessions":
        logger.info("applyRemote", `Stored remote sessions for user review`);
        break;
      case "extensions":
        await chrome.storage.local.set({
          synkro_remote_extensions: {
            device_id: packet.device_id,
            timestamp: packet.timestamp,
            extensions: payload,
          },
        });
        logger.info("applyRemote", `Stored remote extensions list (${payload.length} items)`);
        break;
    }
  }
}

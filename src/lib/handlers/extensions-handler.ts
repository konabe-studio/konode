import type { SyncExtension } from "@/lib/types";
import { logger } from "@/lib/utils/logger";

const CWS_BASE = "https://chromewebstore.google.com/detail/";

// ─── Export ──────────────────────────────────────────────────────────────────

/**
 * Exports installed extensions using chrome.management API.
 * Filters out: themes, built-in Chrome extensions, and Synkro itself.
 */
export async function exportExtensions(): Promise<SyncExtension[]> {
  return new Promise((resolve, reject) => {
    chrome.management.getAll((extensions) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      const selfId = chrome.runtime.id;

      const filtered = extensions
        .filter((ext) => {
          // Skip: self, Chrome built-ins, component extensions
          if (ext.id === selfId) return false;
          if (ext.installType === "other") return false; // built-in
          if (ext.installType === "admin") return false;
          return true;
        })
        .map((ext): SyncExtension => ({
          id: ext.id,
          name: ext.name,
          version: ext.version,
          enabled: ext.enabled,
          homepageUrl: ext.homepageUrl,
          storeUrl: `${CWS_BASE}${ext.id}`,
          description: ext.description,
          type: ext.type as "extension" | "theme" | "app",
        }));

      logger.info("extensions.export", `Exported ${filtered.length} extensions`);
      resolve(filtered);
    });
  });
}

// ─── Diff (what's missing on this device) ────────────────────────────────────

export interface ExtensionDiff {
  missing: SyncExtension[];   // on remote, not installed locally
  extra: SyncExtension[];     // installed locally, not on remote
  disabled: SyncExtension[];  // installed but disabled locally
}

export async function diffExtensions(
  remote: SyncExtension[]
): Promise<ExtensionDiff> {
  const local = await exportExtensions();
  const localIds = new Set(local.map((e) => e.id));
  const remoteIds = new Set(remote.map((e) => e.id));

  const missing = remote.filter(
    (e) => !localIds.has(e.id) && e.type === "extension"
  );
  const extra = local.filter((e) => !remoteIds.has(e.id));
  const disabled = local.filter(
    (e) => remoteIds.has(e.id) && !e.enabled
  );

  return { missing, extra, disabled };
}

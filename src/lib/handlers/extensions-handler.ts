import type { SyncExtension } from "@/lib/types";
import { logger } from "@/lib/utils/logger";

// Legacy webstore URL: Chrome redirects /detail/<id> to the correct listing.
// The new chromewebstore.google.com/detail/<id> form needs a slug we don't have.
const CWS_BASE = "https://chrome.google.com/webstore/detail/";

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
          if (ext.id === selfId) return false;             // don't sync ourselves
          if (ext.type === "theme") return false;          // themes aren't installable "extensions"
          if (ext.installType === "admin") return false;   // policy force-installs the user can't manage
          // NOTE: previously "other" was also dropped as "built-in", but that also
          // silently excluded sideloaded/externally-installed extensions. Chrome
          // reports genuine dev/sideload installs as "development"/"sideload", so
          // keep everything else and let the user see the full picture.
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

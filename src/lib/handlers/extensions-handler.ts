import type { SyncExtension } from "@/lib/types";
import { logger } from "@/lib/utils/logger";
import { browser, currentStore } from "@/lib/utils/ext";
import { storeUrlFor } from "@/lib/utils/extensions-match";

// Legacy webstore URL: Chrome redirects /detail/<id> to the correct listing.
// The new chromewebstore.google.com/detail/<id> form needs a slug we don't have.

// ─── Export ──────────────────────────────────────────────────────────────────

/**
 * Exports installed extensions using chrome.management API.
 * Filters out: themes, built-in Chrome extensions, and Konode itself.
 */
export async function exportExtensions(): Promise<SyncExtension[]> {
  const extensions = await browser.management.getAll();
  const selfId = browser.runtime.id;
  const store = currentStore();

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
      store,
      storeUrl: storeUrlFor({ id: ext.id, name: ext.name, store }),
      description: ext.description,
      type: ext.type as "extension" | "theme" | "app",
    }));

  logger.info("extensions.export", `Exported ${filtered.length} extensions`);
  return filtered;
}


import type { SyncExtension } from "@/lib/types";
import { logger } from "@/lib/utils/logger";
import { browser, currentStore } from "@/lib/utils/ext";
import { storeUrlFor } from "@/lib/utils/extensions-match";
import { dataTypeApiPresent } from "@/lib/utils/capabilities";

// Legacy webstore URL: Chrome redirects /detail/<id> to the correct listing.
// The new chromewebstore.google.com/detail/<id> form needs a slug we don't have.

// ─── Export ──────────────────────────────────────────────────────────────────

/**
 * Exports installed extensions using chrome.management API.
 * Filters out: themes, built-in Chrome extensions, and Konode itself.
 */
export async function exportExtensions(): Promise<SyncExtension[]> {
  // Deliberately NOT assertDataTypeApi(), which every other handler entry point uses so a
  // missing API reads as a sentence rather than a TypeError. This one has a better answer
  // than either. `management` is an OPTIONAL permission, revocable from the browser's own
  // extensions page without telling us, and the API object goes with it, so a throw here
  // fails the extensions half of every sync for as long as that lasts. Answering with an
  // empty list instead costs nothing, because an empty payload is never published
  // (`isPayloadEmpty` skips the upload): the last good remote list stands, and no peer
  // loses this device from its "missing on this device" count. Publishing the empty list
  // over a good one is the only outcome here that would cost the user something.
  if (!dataTypeApiPresent("extensions")) {
    logger.warn(
      "exportExtensions",
      "No extension-management API here (the permission was revoked, or this browser has none), so the extension list isn't published this sync"
    );
    return [];
  }
  let extensions: chrome.management.ExtensionInfo[];
  try {
    extensions = await browser.management.getAll();
  } catch (err) {
    // The API was there a moment ago and the call still failed. Same answer, same reason.
    logger.warn(
      "exportExtensions",
      `Couldn't read the extension list, so it isn't published this sync: ${err instanceof Error ? err.message : err}`
    );
    return [];
  }
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
      type: ext.type,
    }));

  logger.info("extensions.export", `Exported ${filtered.length} extensions`);
  return filtered;
}


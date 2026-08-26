import { describe, it, expect, afterEach } from "vitest";
import { exportExtensions } from "@/lib/handlers/extensions-handler";
import { KEYS } from "@/lib/utils/storage";

// `management` is an OPTIONAL permission: it can be revoked from the browser's own
// extensions page at any moment, and the API object goes with it. The export threw on that,
// which took the extensions half of every sync down until the permission came back. An
// empty list is the better answer, because an empty payload is never published, so the
// last good list on the backend stands and no peer loses this device from its "missing on
// this device" count. Publishing the empty list over a good one is the only outcome here
// that would actually cost the user something.

/* eslint-disable @typescript-eslint/no-explicit-any */
const realManagement = (globalThis as any).chrome.management;
afterEach(() => { (globalThis as any).chrome.management = realManagement; });

async function auditText(): Promise<string> {
  await new Promise((r) => setTimeout(r, 0)); // the logger fires appendAudit unawaited
  const r = await chrome.storage.local.get(KEYS.AUDIT_LOG);
  return JSON.stringify(r[KEYS.AUDIT_LOG] ?? []);
}

describe("exportExtensions: a revoked `management` permission is not a sync failure", () => {
  it("answers [] and says why when the API has gone", async () => {
    (globalThis as any).chrome.management = undefined;

    await expect(exportExtensions()).resolves.toEqual([]);
    expect(await auditText()).toContain("isn't published this sync");
  });

  it("answers [] when the call itself fails, instead of throwing into the sync", async () => {
    (globalThis as any).chrome.management = {
      getAll: () => Promise.reject(new Error("Permission 'management' is required")),
    };

    await expect(exportExtensions()).resolves.toEqual([]);
    expect(await auditText()).toContain("Permission 'management' is required");
  });

  it("still exports the list when the permission is held", async () => {
    (globalThis as any).chrome.management = {
      getAll: () => Promise.resolve([
        { id: "keep-me", name: "Keep", version: "1.0", enabled: true, type: "extension", installType: "normal" },
      ]),
    };

    expect((await exportExtensions()).map((e) => e.id)).toEqual(["keep-me"]);
  });
});

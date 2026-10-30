import { describe, it, expect } from "vitest";
import { auditLogText } from "@/lib/utils/audit-text";
import type { AuditEntry } from "@/lib/utils/storage";

// The copy the Activity tab's button puts on the clipboard. Word for word by decision: a
// redacted log would hide the host a bug report needs.

const ABOUT = { version: "1.4.0", browser: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0" };

// Newest first, as appendAudit keeps them.
const LOG: AuditEntry[] = [
  { timestamp: "2026-09-29T10:05:00.000Z", action: "SyncEngine.sync", detail: "Konode no longer has permission to reach dav.example.org.", ok: false, level: "error" },
  { timestamp: "2026-09-29T10:02:00.000Z", action: "exportExtensions", detail: "isn't published this sync", ok: false, level: "notice", count: 3, last: "2026-09-29T10:04:00.000Z" },
  { timestamp: "2026-09-29T10:00:00.000Z", action: "Tombstones", detail: "Recorded 25 deletion(s)", ok: true, level: "ok" },
];

describe("the Activity log as text for a bug report", () => {
  it("reads oldest first, every entry on one line with its time and level", () => {
    expect(auditLogText(LOG, ABOUT)).toBe(
      "Konode 1.4.0, Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0\n" +
      "Activity log, 3 entries, oldest first\n" +
      "\n" +
      "2026-09-29T10:00:00.000Z OK    Tombstones: Recorded 25 deletion(s)\n" +
      "2026-09-29T10:02:00.000Z WARN  exportExtensions: isn't published this sync (×3, last 2026-09-29T10:04:00.000Z)\n" +
      "2026-09-29T10:05:00.000Z ERROR SyncEngine.sync: Konode no longer has permission to reach dav.example.org.\n"
    );
  });

  it("keeps the host, since that is what the report needs", () => {
    expect(auditLogText(LOG, ABOUT)).toContain("dav.example.org");
  });

  it("reads an entry from before `level` by its `ok`, as the Activity tab does", () => {
    const old: AuditEntry[] = [
      { timestamp: "2026-07-01T09:00:00.000Z", action: "A", ok: false },
      { timestamp: "2026-07-01T08:00:00.000Z", action: "B", ok: true },
    ];
    expect(auditLogText(old, ABOUT).split("\n").slice(3, 5)).toEqual([
      "2026-07-01T08:00:00.000Z OK    B",
      "2026-07-01T09:00:00.000Z ERROR A",
    ]);
  });

  it("says so when there is one entry, and when there are none", () => {
    expect(auditLogText(LOG.slice(0, 1), ABOUT)).toContain("Activity log, 1 entry, oldest first");
    expect(auditLogText([], ABOUT)).toContain("Activity log, 0 entries, oldest first");
  });

  it("does not reorder the log it was given", () => {
    const copy = [...LOG];
    auditLogText(LOG, ABOUT);
    expect(LOG).toEqual(copy);
  });
});

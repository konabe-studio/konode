import type { AuditEntry } from "@/lib/utils/storage";

/**
 * The Activity log as plain text, for pasting into a bug report.
 *
 * The `logger` lines are deliberately English because people paste them into reports, and
 * doing that meant selecting up to 200 rows by hand, which also picked up the icons and
 * lost the levels. This is the same log, word for word: a redacted copy that hides a host
 * would be useless for the report it exists to support, and Settings says so beside the
 * button rather than leaving it to be found in someone's issue.
 *
 * Oldest first, the order a log is read in, with ISO times that mean the same thing in
 * every locale. A repeated warning (appendAudit's `count` and `last`) keeps both.
 */
export function auditLogText(entries: AuditEntry[], about: { version: string; browser: string }): string {
  const lines = [
    `Konode ${about.version}, ${about.browser}`,
    `Activity log, ${entries.length} ${entries.length === 1 ? "entry" : "entries"}, oldest first`,
    "",
  ];
  for (const e of [...entries].reverse()) {
    // Older entries have no `level`; the Activity tab reads `ok` for them, and so does this.
    const level = e.level ?? (e.ok ? "ok" : "error");
    const tag = level === "ok" ? "OK" : level === "notice" ? "WARN" : "ERROR";
    let line = `${e.timestamp} ${tag.padEnd(5)} ${e.action}`;
    if (e.detail) line += `: ${e.detail}`;
    if ((e.count ?? 1) > 1) line += ` (×${e.count}, last ${e.last ?? "?"})`;
    lines.push(line);
  }
  return `${lines.join("\n")}\n`;
}

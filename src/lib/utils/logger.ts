import { appendAudit } from "./storage";

const PREFIX = "[Konode]";

// Gates logger.debug — set from settings.debug_mode (see service worker) so the
// "Debug mode" toggle actually controls verbose console output instead of being
// inert. Defaults off.
let debugEnabled = false;
export function setLoggerDebug(on: boolean): void {
  debugEnabled = on;
}

function timestamp(): string {
  return new Date().toISOString();
}

/**
 * Four levels, and only THREE of them reach the persisted audit log (Settings →
 * Activity):
 *
 *   event  console + audit — a notable thing happened, worth remembering
 *   warn   console + audit — always; this is what the user is sent to look for
 *   error  console + audit — always
 *   info   console only    — routine operational detail
 *   debug  console + audit, but ONLY while Debug mode is on
 *
 * `info` used to be audited too, and that flooded the 200-entry log: an idle sync of
 * four data types writes ~11 lines a minute ("Syncing: X", "unchanged since last
 * upload, skipping", the connect line, "Sync complete", plus "Initialized" and
 * "Registered" on every worker wake). The ring turned over in about 17 minutes — so the
 * "unusual deletion blocked" warning that the popup banner tells the user to go and read
 * in Settings → Activity was routinely gone before they got there. It also meant every
 * log line rewrote a 200-element array in chrome.storage.
 *
 * The default is deliberately the QUIET one: a newly added `logger.info` cannot bring
 * the noise back, and the audited set stays small enough to eyeball. Reach for `event`
 * only for something a user would actually want in their history — a restore point, a
 * restore, a sign-in, a recovery, a migration, a merge that changed something.
 */
export const logger = {
  /** Routine operational detail. Console only — see the note above. */
  info(action: string, detail?: string) {
    console.info(`${PREFIX} [INFO] ${action}`, detail ?? "");
  },
  /** A notable event worth keeping in the user's Activity log. */
  event(action: string, detail?: string) {
    console.info(`${PREFIX} [INFO] ${action}`, detail ?? "");
    appendAudit({ timestamp: timestamp(), action, detail, ok: true });
  },
  warn(action: string, detail?: string) {
    console.warn(`${PREFIX} [WARN] ${action}`, detail ?? "");
    appendAudit({ timestamp: timestamp(), action, detail, ok: false });
  },
  error(action: string, err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`${PREFIX} [ERROR] ${action}`, detail);
    appendAudit({ timestamp: timestamp(), action, detail, ok: false });
  },
  debug(action: string, data?: unknown) {
    if (!debugEnabled) return; // gated by settings.debug_mode
    const detail = data === undefined ? undefined : typeof data === "string" ? data : JSON.stringify(data);
    console.debug(`${PREFIX} [DEBUG] ${action}`, detail ?? "");
    // Persisted WHILE Debug mode is on, and only then.
    //
    // The standard troubleshooting request is "turn on Debug mode and send us Settings →
    // Activity" — and that produced nothing, because debug only ever reached the service
    // worker's console, which a user is not going to open. It hid exactly the lines someone
    // chasing a missing device needs, such as "Skipping plaintext peer". Yes, this crowds
    // the 200-entry log; that is the trade Debug mode is asking for, and it stops the
    // moment the toggle goes off.
    appendAudit({ timestamp: timestamp(), action, detail, ok: true });
  },
};

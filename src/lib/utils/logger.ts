import { appendAudit } from "./storage";

const PREFIX = "[Synkro]";

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

export const logger = {
  info(action: string, detail?: string) {
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
    console.debug(`${PREFIX} [DEBUG] ${action}`, data ?? "");
  },
};

import { appendAudit } from "./storage";

type LogLevel = "info" | "warn" | "error" | "debug";

const PREFIX = "[Synkro]";

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
    appendAudit({ timestamp: timestamp(), action, detail, ok: true });
  },
  error(action: string, err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`${PREFIX} [ERROR] ${action}`, detail);
    appendAudit({ timestamp: timestamp(), action, detail, ok: false });
  },
  debug(action: string, data?: unknown) {
    // Only log in debug mode — checked at call site via settings
    console.debug(`${PREFIX} [DEBUG] ${action}`, data ?? "");
  },
};

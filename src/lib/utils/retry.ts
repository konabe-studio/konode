// ─── Exponential Backoff Retry ─────────────────────────────────────────────

/** Error carrying an HTTP status so retry logic can tell transient from terminal. */
export class HttpError extends Error {
  /**
   * `retryAfterMs` is how long the server asked us to wait (a 429's `Retry-After`), when it
   * said. `withRetry` waits exactly that instead of its own backoff, and gives up at once
   * when it is longer than the backoff would ever wait: holding a sync for five minutes is
   * worse than failing it and trying again at the next interval.
   */
  constructor(public readonly status: number, message?: string, public readonly retryAfterMs?: number) {
    super(message ?? `HTTP ${status}`);
    this.name = "HttpError";
  }
}

/**
 * How long a storage request waits for the server to start answering.
 *
 * Konode set no limit, so a server that took a request and never answered held the sync,
 * and every sync after it ("Already syncing, skipping"), for as long as the worker lived.
 * Chrome ends that wait its own way: it stops an extension's service worker whose fetch()
 * response takes more than 30 seconds to arrive (developer.chrome.com, "The extension
 * service worker lifecycle"), which kills the whole sync midway and leaves the popup on
 * "Syncing" until the worker starts again. Firefox has no such limit. Under Chrome's 30
 * seconds, so the request fails on its own, the sync carries on without it, and the next
 * sync asks again. It times the wait for the response only, not the download of its body:
 * a large history file on a slow line may take longer than this, and that is not a hang.
 */
export const RESPONSE_TIMEOUT_MS = 25_000;

/** The storage did not start answering within `RESPONSE_TIMEOUT_MS`. Not retried by
 *  `withRetry`: asking a server that does not answer twice more holds the sync for over a
 *  minute, and the next sync is the retry. */
export class ResponseTimeoutError extends Error {
  constructor(public readonly host: string, public readonly ms: number) {
    super(`${host || "The storage server"} did not answer within ${Math.round(ms / 1000)} seconds. Konode tries again at the next sync.`);
    this.name = "ResponseTimeoutError";
  }
}

/** `fetch`, for every request to the storage and its sign-in service, given up after
 *  `ms` without a response (see `RESPONSE_TIMEOUT_MS`). */
export async function timedFetch(url: string, init: RequestInit = {}, ms = RESPONSE_TIMEOUT_MS): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    if (ctrl.signal.aborted) {
      let host = "";
      try { host = new URL(url).host; } catch { /* a relative or odd URL: say "the storage server" */ }
      throw new ResponseTimeoutError(host, ms);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A response's `Retry-After`, in milliseconds: delta-seconds or an HTTP date, as RFC 9110
 * allows both. Undefined when absent or unreadable. 0 is a real answer ("retry now"), and
 * Dropbox sends it for some write contention.
 */
export function retryAfterMs(res: Response, now = Date.now()): number | undefined {
  const raw = res.headers?.get?.("Retry-After")?.trim();
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/**
 * What to say when the storage answers 429 Too Many Requests.
 *
 * Every backend said "HTTP 429" or "WebDAV PUT failed: 429" and nothing else, which tells
 * someone it failed and not what to do (reported on appinn, 2026-09-10: "keeps returning
 * HTTP 429, tried several, none work"). A provider that meters requests, Nutstore's 600 per
 * 30 minutes the best known, is the usual reason, and the one lever the user holds is the
 * sync interval. Cure first, status last: the popup shows two lines of this.
 */
export function rateLimitMessage(where: string): string {
  return `Too many requests: ${where} is turning Konode away for a while. Raise Sync interval in Settings → Device to stay under its limit. (HTTP 429)`;
}

/** Retry only transient failures: network errors and HTTP 408/423/429/5xx. */
export function defaultShouldRetry(err: Error): boolean {
  if (err instanceof HttpError) {
    // 423 Locked is WebDAV's "something else is writing this right now", which is the
    // definition of transient: the lock clears on its own. Koofr returns it when two
    // writes to one file overlap, and it reached a user as "WebDAV PUT failed: 423" on a
    // burst of conflict resolutions. The backend already treats a 423 from MKCOL as
    // benign; a 423 from PUT is the same fact about the same server, and the one thing to
    // do with it is come back in a moment.
    return err.status === 408 || err.status === 423 || err.status === 429 || err.status >= 500;
  }
  // fetch() rejects with a TypeError on network/CORS failures — treat as transient.
  // But a bare `TypeError` is also how programming bugs surface (e.g. "x is not a
  // function"); retrying those just burns ~90s of backoff and hides the real stack.
  // Only retry TypeErrors whose message looks like a network failure.
  if (err.name === "TypeError") return /fetch|network|load failed/i.test(err.message);
  return false;
}

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: boolean;
  shouldRetry?: (error: Error) => boolean;
  onRetry?: (attempt: number, error: Error) => void;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    baseDelayMs = 1000,
    maxDelayMs = 30000,
    jitter = true,
    shouldRetry = defaultShouldRetry,
    onRetry,
  } = options;

  let lastError: Error = new Error("Unknown error");

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // Stop immediately on terminal errors (e.g. 401/403/404) — retrying a
      // deterministic failure just wastes time and rate-limit budget.
      if (attempt === maxAttempts || !shouldRetry(lastError)) break;

      // A server that said how long to wait is taken at its word, unless the wait is longer
      // than this helper would ever sleep: then the next sync is the retry.
      const asked = lastError instanceof HttpError ? lastError.retryAfterMs : undefined;
      if (asked !== undefined && asked > maxDelayMs) break;

      const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
      const finalDelay = asked !== undefined ? asked : jitter ? delay * (0.5 + Math.random() * 0.5) : delay;

      onRetry?.(attempt, lastError);
      await sleep(finalDelay);
    }
  }

  throw lastError;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

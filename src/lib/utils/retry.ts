// ─── Exponential Backoff Retry ─────────────────────────────────────────────

/** Error carrying an HTTP status so retry logic can tell transient from terminal. */
export class HttpError extends Error {
  constructor(public readonly status: number, message?: string) {
    super(message ?? `HTTP ${status}`);
    this.name = "HttpError";
  }
}

/** Retry only transient failures: network errors and HTTP 408/429/5xx. */
export function defaultShouldRetry(err: Error): boolean {
  if (err instanceof HttpError) {
    return err.status === 408 || err.status === 429 || err.status >= 500;
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

      const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
      const finalDelay = jitter ? delay * (0.5 + Math.random() * 0.5) : delay;

      onRetry?.(attempt, lastError);
      await sleep(finalDelay);
    }
  }

  throw lastError;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Rate Limiter ──────────────────────────────────────────────────────────

export class RateLimiter {
  private queue: Array<() => void> = [];
  private running = 0;

  constructor(
    private readonly maxConcurrent: number = 2,
    private readonly delayMs: number = 200
  ) {}

  async acquire(): Promise<void> {
    if (this.running < this.maxConcurrent) {
      this.running++;
      return;
    }

    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) {
      this.running++;
      setTimeout(next, this.delayMs);
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

// ─── Exponential Backoff Retry ─────────────────────────────────────────────

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: boolean;
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
    onRetry,
  } = options;

  let lastError: Error = new Error("Unknown error");

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt === maxAttempts) break;

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

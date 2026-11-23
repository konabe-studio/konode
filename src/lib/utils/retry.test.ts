import { describe, it, expect, vi } from "vitest";
import { withRetry, HttpError } from "@/lib/utils/retry";

describe("withRetry", () => {
  it("returns immediately on success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    expect(await withRetry(fn)).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a transient 5xx then succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new HttpError(503))
      .mockResolvedValue("ok");
    expect(await withRetry(fn, { baseDelayMs: 1, jitter: false })).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a terminal 4xx", async () => {
    const fn = vi.fn().mockRejectedValue(new HttpError(404));
    await expect(withRetry(fn, { baseDelayMs: 1 })).rejects.toBeInstanceOf(HttpError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a 423, because a WebDAV lock is a wait rather than a refusal", async () => {
    // Koofr locks a file while a write to it is in flight and answers the next one 423.
    // A burst of Keep local resolutions hit it and the user was shown "WebDAV PUT failed:
    // 423" for a file that was about to be writable again.
    const fn = vi.fn()
      .mockRejectedValueOnce(new HttpError(423))
      .mockResolvedValue("ok");
    await expect(withRetry(fn, { baseDelayMs: 1 })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries network errors (TypeError)", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue("ok");
    await withRetry(fn, { baseDelayMs: 1, jitter: false });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a non-network TypeError (a programming bug, not a fetch failure)", async () => {
    const fn = vi.fn().mockRejectedValue(new TypeError("x is not a function"));
    await expect(
      withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, jitter: false })
    ).rejects.toBeInstanceOf(TypeError);
    expect(fn).toHaveBeenCalledTimes(1); // terminal → no wasted backoff
  });

  it("gives up after maxAttempts", async () => {
    const fn = vi.fn().mockRejectedValue(new HttpError(500));
    await expect(
      withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, jitter: false })
    ).rejects.toBeInstanceOf(HttpError);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("retries a 409 only when shouldRetry opts in (GitHub stale-SHA conflict)", async () => {
    // Default: a 409 is terminal.
    const terminal = vi.fn().mockRejectedValue(new HttpError(409));
    await expect(withRetry(terminal, { baseDelayMs: 1 })).rejects.toBeInstanceOf(HttpError);
    expect(terminal).toHaveBeenCalledTimes(1);

    // Opted in (as the GitHub upload does): the 409 is retried, then succeeds.
    const recovering = vi
      .fn()
      .mockRejectedValueOnce(new HttpError(409))
      .mockResolvedValue("ok");
    const out = await withRetry(recovering, {
      baseDelayMs: 1,
      jitter: false,
      shouldRetry: (e) => e instanceof HttpError && e.status === 409,
    });
    expect(out).toBe("ok");
    expect(recovering).toHaveBeenCalledTimes(2);
  });
});

describe("Retry-After", () => {
  const res = (v?: string) => new Response(null, { status: 429, headers: v === undefined ? {} : { "Retry-After": v } });

  it("reads delta-seconds and an HTTP date, and nothing else", async () => {
    const { retryAfterMs } = await import("@/lib/utils/retry");
    const now = Date.parse("2026-11-23T10:00:00Z");
    expect(retryAfterMs(res("0"), now)).toBe(0);
    expect(retryAfterMs(res("7"), now)).toBe(7000);
    expect(retryAfterMs(res("Mon, 23 Nov 2026 10:00:30 GMT"), now)).toBe(30_000);
    expect(retryAfterMs(res("Mon, 23 Nov 2026 09:00:00 GMT"), now)).toBe(0);
    expect(retryAfterMs(res(), now)).toBeUndefined();
    expect(retryAfterMs(res("soon"), now)).toBeUndefined();
  });

  it("waits what the server asked instead of the backoff", async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      const p = withRetry(async () => {
        if (++n === 1) throw new HttpError(429, "slow down", 2000);
        return "ok";
      }, { baseDelayMs: 10, maxDelayMs: 30_000 });
      await vi.advanceTimersByTimeAsync(1999);
      expect(n).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await p).toBe("ok");
      expect(n).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up at once when asked to wait longer than it ever would", async () => {
    let n = 0;
    await expect(withRetry(async () => { n++; throw new HttpError(429, "come back in five minutes", 300_000); }))
      .rejects.toThrow("come back in five minutes");
    expect(n).toBe(1);
  });
});

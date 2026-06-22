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

  it("retries network errors (TypeError)", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue("ok");
    await withRetry(fn, { baseDelayMs: 1, jitter: false });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("gives up after maxAttempts", async () => {
    const fn = vi.fn().mockRejectedValue(new HttpError(500));
    await expect(
      withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, jitter: false })
    ).rejects.toBeInstanceOf(HttpError);
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

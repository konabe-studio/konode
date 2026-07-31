import { describe, it, expect, afterEach, vi } from "vitest";
import { GitHubBackend } from "./github-backend";
import type { BackendConfig } from "@/lib/types";

// Initializing an empty repository threw away the result of the call that creates the
// first commit and set `repoInitialized = true` either way. A token without Contents:
// write failed right there — where we know exactly what went wrong — but the user saw it
// later as an unexplained upload failure, once per data type, with nothing naming the
// cause. The same eight lines also pinned that first commit to "main" while every other
// request used the configured branch.

const cfg = (branch?: string): BackendConfig => ({
  type: "github", label: "GitHub", enabled: true,
  github: { token: "t", repo: "owner/repo", ...(branch ? { branch } : {}) },
});

/** An EMPTY private repo (no default_branch), with the README PUT answering `initStatus`. */
function emptyRepo(initStatus: number): { puts: Array<Record<string, unknown>> } {
  const puts: Array<Record<string, unknown>> = [];
  vi.stubGlobal("fetch", (url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === "PUT") {
      puts.push(JSON.parse(init.body ?? "{}"));
      // ONLY the README (the initializing commit) answers `initStatus`. The data file that
      // follows always succeeds — otherwise a test asserting the init failure would pass
      // just because the later upload failed too, which is how it passed with the check
      // deleted.
      const isInit = String(url).includes("README.md");
      const status = isInit ? initStatus : 201;
      return Promise.resolve({
        ok: status >= 200 && status < 300, status,
        text: () => Promise.resolve(""), json: () => Promise.resolve({}),
      } as Response);
    }
    // repo metadata: private, and empty (no default_branch)
    return Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve({ private: true }),
    } as Response);
  });
  return { puts };
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("GitHub: initializing an empty repository", () => {
  it("fails loudly when the first commit can't be written", async () => {
    emptyRepo(403); // token without Contents: write

    await expect(
      new GitHubBackend(cfg()).upload({
        version: "1.0", device_id: "d1", timestamp: "2026-07-31T10:00:00.000Z",
        data_type: "bookmarks", checksum: "a".repeat(64), encrypted: false, payload: "[]",
      })
    ).rejects.toThrow(/403/);
  });

  it("names the likely cause rather than just the status", async () => {
    emptyRepo(403);

    await expect(
      new GitHubBackend(cfg()).upload({
        version: "1.0", device_id: "d1", timestamp: "2026-07-31T10:00:00.000Z",
        data_type: "bookmarks", checksum: "a".repeat(64), encrypted: false, payload: "[]",
      })
    ).rejects.toThrow(/Contents: write/);
  });

  it("writes the first commit to the CONFIGURED branch, not always main", async () => {
    // Pinning it to main put the initial commit on a branch nothing else touched, and
    // then every upload failed against a branch that did not exist.
    const { puts } = emptyRepo(201);

    await new GitHubBackend(cfg("konode")).upload({
      version: "1.0", device_id: "d1", timestamp: "2026-07-31T10:00:00.000Z",
      data_type: "bookmarks", checksum: "a".repeat(64), encrypted: false, payload: "[]",
    });

    const readme = puts.find((p) => String(p.message).includes("initialize"));
    expect(readme?.branch).toBe("konode");
  });

  it("still defaults to main when no branch is configured", async () => {
    const { puts } = emptyRepo(201);

    await new GitHubBackend(cfg()).upload({
      version: "1.0", device_id: "d1", timestamp: "2026-07-31T10:00:00.000Z",
      data_type: "bookmarks", checksum: "a".repeat(64), encrypted: false, payload: "[]",
    });

    expect(puts.find((p) => String(p.message).includes("initialize"))?.branch).toBe("main");
  });
});

import { describe, it, expect, afterEach, vi } from "vitest";
import { GiteaBackend, forgeBaseUrl, giteaApiBase, normalizeForgeRepoSlug } from "./gitea-backend";
import { GitHubBackend, isEmptyRepo } from "./github-backend";
import { createBackend } from "./abstract-backend";
import { backendOrigins, storageName } from "@/lib/sync/sync-engine";
import { providerFromConfig, providerById } from "@/lib/storage-providers";
import type { BackendConfig, SyncPacket } from "@/lib/types";

// Gitea and Forgejo (#32, #76) run on the GitHub backend with the differences listed at the
// top of gitea-backend.ts. Each test here pins one of them: the request a Gitea instance
// would answer differently from GitHub, made the way Gitea expects it.

const cfg = (gitea: NonNullable<BackendConfig["gitea"]>): BackendConfig => ({
  type: "gitea", label: "Gitea / Forgejo", enabled: true, gitea,
});
const ready = cfg({ url: "https://git.example.com", token: "tok", repo: "me/sync" });

const packet: SyncPacket = {
  version: "1.0", device_id: "d1", timestamp: "2026-11-23T10:00:00.000Z",
  data_type: "bookmarks", checksum: "a".repeat(64), encrypted: false, payload: "[]",
};

type Call = { url: string; method: string; headers: Record<string, string>; body?: Record<string, unknown> };

/** Answer each request through `route`; every request is recorded. */
function serve(route: (c: Call) => { status: number; json?: unknown; text?: string }): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    const c: Call = {
      url: String(url),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(c);
    const r = route(c);
    return Promise.resolve({
      ok: r.status >= 200 && r.status < 300, status: r.status,
      json: () => Promise.resolve(r.json ?? {}),
      text: () => Promise.resolve(r.text ?? JSON.stringify(r.json ?? {})),
    } as Response);
  });
  return calls;
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("forgeBaseUrl / giteaApiBase", () => {
  it("adds https:// to a bare host and drops a trailing slash", () => {
    expect(forgeBaseUrl("git.example.com")).toBe("https://git.example.com");
    expect(forgeBaseUrl("  https://git.example.com/  ")).toBe("https://git.example.com");
    expect(giteaApiBase("git.example.com")).toBe("https://git.example.com/api/v1");
  });

  it("keeps a subpath install and a port", () => {
    expect(giteaApiBase("example.com/gitea/")).toBe("https://example.com/gitea/api/v1");
    expect(giteaApiBase("http://localhost:3000")).toBe("http://localhost:3000/api/v1");
  });

  it("does not double a pasted /api/v1", () => {
    expect(giteaApiBase("https://git.example.com/api/v1/")).toBe("https://git.example.com/api/v1");
  });

  it("lowercases the host and drops a query or fragment", () => {
    expect(forgeBaseUrl("https://Git.Example.com/?tab=x#top")).toBe("https://git.example.com");
  });

  it("is empty for nothing usable", () => {
    expect(forgeBaseUrl("")).toBe("");
    expect(forgeBaseUrl(undefined)).toBe("");
    expect(forgeBaseUrl("ftp://git.example.com")).toBe("");
    expect(giteaApiBase("   ")).toBe("");
  });
});

describe("normalizeForgeRepoSlug", () => {
  it("passes a clean owner/repo through", () => {
    expect(normalizeForgeRepoSlug("me/sync")).toBe("me/sync");
    expect(normalizeForgeRepoSlug(" /me/sync/ ")).toBe("me/sync");
  });

  it("reads the repository's web address, also a deeper page of it", () => {
    expect(normalizeForgeRepoSlug("https://git.example.com/me/sync")).toBe("me/sync");
    expect(normalizeForgeRepoSlug("https://git.example.com/me/sync.git")).toBe("me/sync");
    expect(normalizeForgeRepoSlug("https://git.example.com/me/sync/src/branch/main")).toBe("me/sync");
  });

  it("tells a subpath install's prefix apart from the owner", () => {
    expect(normalizeForgeRepoSlug("https://example.com/gitea/me/sync", "example.com/gitea")).toBe("me/sync");
  });

  it("reads clone addresses", () => {
    expect(normalizeForgeRepoSlug("git@git.example.com:me/sync.git")).toBe("me/sync");
    expect(normalizeForgeRepoSlug("ssh://git@git.example.com:2222/me/sync.git")).toBe("me/sync");
  });

  it("is empty for nothing", () => {
    expect(normalizeForgeRepoSlug(undefined)).toBe("");
    expect(normalizeForgeRepoSlug("")).toBe("");
  });
});

describe("isEmptyRepo", () => {
  it("reads GitHub's missing default_branch and Gitea's empty flag", () => {
    expect(isEmptyRepo({ default_branch: "main" })).toBe(false);
    expect(isEmptyRepo({})).toBe(true); // GitHub, empty
    // Gitea names a default branch for an empty repository too.
    expect(isEmptyRepo({ empty: true, default_branch: "main" })).toBe(true);
    expect(isEmptyRepo({ empty: false, default_branch: "main" })).toBe(false);
  });
});

describe("Gitea requests", () => {
  it("is its own backend type, built by the factory", () => {
    expect(createBackend(ready)).toBeInstanceOf(GiteaBackend);
    expect(createBackend(ready).type).toBe("gitea");
    expect(new GitHubBackend({ type: "github", label: "GitHub", enabled: true }).type).toBe("github");
  });

  it("is not configured without the instance address", () => {
    expect(new GiteaBackend(ready).isConfigured()).toBe(true);
    expect(new GiteaBackend(cfg({ token: "tok", repo: "me/sync" })).isConfigured()).toBe(false);
  });

  it("sends the token as `token`, to the instance's /api/v1, never to GitHub", async () => {
    const calls = serve(() => ({ status: 200, json: { login: "me", private: true, full_name: "me/sync", default_branch: "main" } }));
    await new GiteaBackend(ready).testConnection();
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.url.startsWith("https://git.example.com/api/v1/")).toBe(true);
      expect(c.headers.Authorization).toBe("token tok");
      expect(c.headers["X-GitHub-Api-Version"]).toBeUndefined();
    }
  });

  it("creates a file with POST and no sha", async () => {
    const calls = serve((c) => {
      if (c.url.endsWith("/repos/me/sync")) return { status: 200, json: { private: true, empty: false, default_branch: "main" } };
      if (c.method === "GET") return { status: 404 }; // the file isn't there yet
      return { status: 201 };
    });
    await new GiteaBackend(ready).upload(packet);
    const write = calls.find((c) => c.url.includes("/contents/konode/konode_bookmarks_d1.json") && c.method !== "GET");
    expect(write?.method).toBe("POST");
    expect(write?.body?.sha).toBeUndefined();
    expect(write?.body?.branch).toBe("main");
  });

  it("updates a file with PUT and its sha", async () => {
    const calls = serve((c) => {
      if (c.url.endsWith("/repos/me/sync")) return { status: 200, json: { private: true, empty: false, default_branch: "main" } };
      if (c.method === "GET") return { status: 200, json: { sha: "blob-1" } };
      return { status: 200 };
    });
    await new GiteaBackend(ready).upload(packet);
    const write = calls.find((c) => c.method !== "GET");
    expect(write?.method).toBe("PUT");
    expect(write?.body?.sha).toBe("blob-1");
  });

  it("retries a 422 stale-sha write, re-reading the sha", async () => {
    let shaReads = 0;
    let writes = 0;
    serve((c) => {
      if (c.url.endsWith("/repos/me/sync")) return { status: 200, json: { private: true, empty: false, default_branch: "main" } };
      if (c.method === "GET") { shaReads++; return { status: 200, json: { sha: `blob-${shaReads}` } }; }
      writes++;
      return writes === 1 ? { status: 422, json: { message: "sha does not match" } } : { status: 200 };
    });
    await new GiteaBackend(ready).upload(packet);
    expect(writes).toBe(2);
    expect(shaReads).toBe(2);
  });

  it("initializes an empty repository that still names a default branch", async () => {
    const calls = serve((c) => {
      if (c.url.endsWith("/repos/me/sync")) return { status: 200, json: { private: true, empty: true, default_branch: "main" } };
      if (c.method === "GET") return { status: 404 };
      return { status: 201 };
    });
    await new GiteaBackend(cfg({ ...ready.gitea!, branch: "konode" })).upload(packet);
    const init = calls.find((c) => c.url.endsWith("/contents/README.md"));
    expect(init?.method).toBe("POST");
    expect(init?.body?.branch).toBe("konode");
  });

  it("reads a file's bytes from /raw, with the branch as ref", async () => {
    const calls = serve(() => ({ status: 200, text: "{\"x\":1}" }));
    expect(await new GiteaBackend(cfg({ ...ready.gitea!, branch: "dev" })).getFile("konode_snap_index.json")).toBe("{\"x\":1}");
    expect(calls[0].url).toBe("https://git.example.com/api/v1/repos/me/sync/raw/konode/konode_snap_index.json?ref=dev");
  });

  it("skips a peer whose listed blob sha is the known one (#96), and downloads the rest from /raw", async () => {
    const peer = (id: string): SyncPacket => ({ ...packet, data_type: "history", device_id: id });
    const calls = serve((c) => {
      if (c.url.includes("/raw/")) return { status: 200, text: JSON.stringify(peer(c.url.includes("_b.json") ? "b" : "?")) };
      return {
        status: 200,
        json: [
          { name: "konode_history_a.json", type: "file", sha: "sha-a" },
          { name: "konode_history_b.json", type: "file", sha: "sha-b2" },
          { name: "konode_history_me.json", type: "file", sha: "sha-me" },
        ],
      };
    });
    const pull = await new GiteaBackend(ready).downloadChanged("history", "me", { a: "sha-a", b: "sha-b1" });
    expect(pull.unchanged).toEqual([{ device_id: "a", marker: "sha-a", exact: true }]);
    expect(pull.fetched.map((f) => [f.packet.device_id, f.file.marker])).toEqual([["b", "sha-b2"]]);
    expect(calls.filter((c) => c.url.includes("/raw/")).map((c) => c.url))
      .toEqual(["https://git.example.com/api/v1/repos/me/sync/raw/konode/konode_history_b.json?ref=main"]);
  });

  it("deletes with the sha in a JSON body", async () => {
    const calls = serve((c) => (c.method === "GET" ? { status: 200, json: { sha: "blob-9" } } : { status: 200 }));
    await new GiteaBackend(ready).deleteFile("konode_snap_x.json");
    const del = calls.find((c) => c.method === "DELETE");
    expect(del?.body).toMatchObject({ sha: "blob-9", branch: "main" });
  });

  it("refuses a plain http:// instance before sending the token", async () => {
    const calls = serve(() => ({ status: 200 }));
    const b = new GiteaBackend(cfg({ ...ready.gitea!, url: "http://git.example.com" }));
    expect((await b.testConnection()).message).toMatch(/plain http/);
    await expect(b.upload(packet)).rejects.toThrow(/plain http/);
    expect(calls).toHaveLength(0);
  });

  it("allows http:// on localhost, the way WebDAV does", async () => {
    const calls = serve(() => ({ status: 200, json: { login: "me", private: true, full_name: "me/sync", default_branch: "main" } }));
    const r = await new GiteaBackend(cfg({ ...ready.gitea!, url: "http://localhost:3000" })).testConnection();
    expect(r.ok).toBe(true);
    expect(calls[0].url).toBe("http://localhost:3000/api/v1/user");
  });

  it("still passes the test with a token that may not read /user", async () => {
    serve((c) => c.url.endsWith("/user")
      ? { status: 403 }
      : { status: 200, json: { private: true, full_name: "me/sync", default_branch: "main" } });
    const r = await new GiteaBackend(ready).testConnection();
    expect(r.ok).toBe(true);
    expect(r.message).toContain("me/sync");
  });

  it("says when the address has no Gitea API", async () => {
    serve(() => ({ status: 404 }));
    const r = await new GiteaBackend(ready).testConnection();
    expect(r).toMatchObject({ ok: false });
    expect(r.message).toContain("https://git.example.com/api/v1");
  });
});

describe("Gitea around the backend", () => {
  it("asks for the instance's origin as its host permission", () => {
    expect(backendOrigins(cfg({ url: "git.example.com/gitea", token: "t", repo: "me/sync" }))).toEqual(["https://git.example.com/*"]);
    expect(backendOrigins(cfg({ url: "http://localhost:3000", token: "t", repo: "me/sync" }))).toEqual(["http://localhost:3000/*"]);
    expect(backendOrigins(cfg({ token: "t", repo: "me/sync" }))).toEqual([]);
  });

  it("names the instance's host as the storage", () => {
    expect(storageName(ready)).toBe("git.example.com");
  });

  it("maps to its own card, which asks for a host", () => {
    expect(providerFromConfig("gitea", undefined)).toBe("gitea");
    expect(providerById("gitea")).toMatchObject({ backend: "gitea", needsHost: true });
  });
});

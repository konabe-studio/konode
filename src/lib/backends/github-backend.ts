import type { IBackend, BackendConfig, DataType, SyncPacket } from "@/lib/types";
import { withRetry, HttpError } from "@/lib/utils/retry";
import { logger } from "@/lib/utils/logger";

const GITHUB_API = "https://api.github.com";

/**
 * Coerce whatever the user pasted into the Repository field to an `owner/repo`
 * slug. Accepts `owner/repo`, an `https://github.com/owner/repo` URL (with or
 * without a `.git` suffix or trailing slash), and the `git@github.com:owner/repo`
 * SSH form. The GitHub API 404s on a trailing slash or a full URL, so this keeps
 * the field forgiving instead of failing with a confusing "not found".
 */
export function normalizeRepoSlug(input: string | undefined): string {
  return (input ?? "")
    .trim()
    .replace(/^git@github\.com:/i, "")
    .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "");
}

export interface GitHubUserInfo {
  login: string;
  name: string;
  avatarUrl: string;
}

export class GitHubBackend implements IBackend {
  readonly type = "github" as const;

  constructor(private config: BackendConfig) {}

  isConfigured(): boolean {
    const gh = this.config.github;
    return !!(gh?.token && gh?.repo);
  }

  private get gh() {
    if (!this.config.github?.token) throw new Error("GitHub token not configured");
    return this.config.github;
  }

  private get branch(): string { return this.gh.branch ?? "main"; }
  private get path(): string { return this.gh.path ?? "synkro"; }
  /** `owner/repo`, tolerant of a pasted URL / `.git` suffix / trailing slash. */
  private get repoSlug(): string { return normalizeRepoSlug(this.gh.repo); }

  private headers(): HeadersInit {
    return {
      Authorization: `Bearer ${this.gh.token}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  async getUser(): Promise<GitHubUserInfo | null> {
    try {
      const res = await fetch(`${GITHUB_API}/user`, { headers: this.headers() });
      if (!res.ok) return null;
      const d = await res.json();
      return { login: d.login ?? "", name: d.name ?? d.login ?? "", avatarUrl: d.avatar_url ?? "" };
    } catch { return null; }
  }

  async connect(): Promise<void> {
    if (!this.gh.token) throw new Error("No token configured");
    if (!this.gh.repo) throw new Error("No repository configured");
    logger.info("GitHub connected", this.gh.repo ?? "");
  }

  async disconnect(): Promise<void> {}

  async upload(packet: SyncPacket): Promise<void> {
    // Ensure repo is initialized before first upload
    await this.ensureRepoInitialized();

    await withRetry(async () => {
      const branch = this.gh.branch ?? "main";
      const filename = `${this.path}/synkro_${packet.data_type}_${packet.device_id}.json`;
      const content = btoa(unescape(encodeURIComponent(JSON.stringify(packet, null, 2))));

      // Always fetch fresh SHA to avoid 409 conflicts
      const sha = await this.getFileSHA(filename, branch);
      const body: Record<string, unknown> = {
        message: `sync: ${packet.data_type} [${packet.device_id.slice(0, 8)}]`,
        content,
        branch,
      };
      if (sha) body.sha = sha;

      const res = await fetch(
        `${GITHUB_API}/repos/${this.repoSlug}/contents/${filename}`,
        { method: "PUT", headers: this.headers(), body: JSON.stringify(body) }
      );

      if (res.status === 409) {
        // SHA mismatch — fetch fresh SHA and retry
        const freshSha = await this.getFileSHA(filename, branch);
        if (freshSha) body.sha = freshSha;
        const retry = await fetch(
          `${GITHUB_API}/repos/${this.repoSlug}/contents/${filename}`,
          { method: "PUT", headers: this.headers(), body: JSON.stringify(body) }
        );
        if (!retry.ok) {
          const err = await retry.json().catch(() => ({}));
          throw new HttpError(retry.status, `GitHub upload failed: ${retry.status} — ${err.message ?? ""}`);
        }
      } else if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new HttpError(res.status, `GitHub upload failed: ${res.status} — ${err.message ?? ""}`);
      }

      logger.info("GitHub.upload", `${packet.data_type} → ${filename}`);
    });
  }

  private repoInitialized = false;

  private async ensureRepoInitialized(): Promise<void> {
    if (this.repoInitialized) return;

    const repoRes = await fetch(
      `${GITHUB_API}/repos/${this.repoSlug}`,
      { headers: this.headers() }
    );

    if (!repoRes.ok) {
      throw new Error(
        repoRes.status === 404
          ? `Repository '${this.repoSlug}' not found. Create it on GitHub first.`
          : `GitHub repo check failed: ${repoRes.status}`
      );
    }

    const repoData = await repoRes.json();

    // If repo is empty (no commits), initialize it
    if (!repoData.default_branch) {
      await fetch(`${GITHUB_API}/repos/${this.repoSlug}/contents/README.md`, {
        method: "PUT",
        headers: this.headers(),
        body: JSON.stringify({
          message: "chore: initialize Synkro sync repository",
          content: btoa("# Synkro Sync\n\nThis repository is used by the Synkro browser extension to sync browser data.\n"),
          branch: "main",
        }),
      });
    }

    this.repoInitialized = true;
  }

  private async getFileSHA(path: string, branch: string): Promise<string | null> {
    try {
      const res = await fetch(
        `${GITHUB_API}/repos/${this.repoSlug}/contents/${path}?ref=${branch}`,
        { headers: this.headers() }
      );
      if (!res.ok) return null;
      return (await res.json()).sha ?? null;
    } catch { return null; }
  }

  async downloadAll(data_type: DataType, excludeDeviceId?: string): Promise<SyncPacket[]> {
    return withRetry(async () => {
      const res = await fetch(
        `${GITHUB_API}/repos/${this.repoSlug}/contents/${this.path}?ref=${this.branch}`,
        { headers: this.headers() }
      );
      if (!res.ok) return [];
      const files: Array<{ name: string }> = await res.json();
      const own = excludeDeviceId ? `synkro_${data_type}_${excludeDeviceId}.json` : null;
      const matches = files.filter(
        f => f.name.includes(`synkro_${data_type}_`) && f.name.endsWith(".json") && f.name !== own
      );
      // Fetch each via the authenticated Contents API (Accept: raw); the public
      // download_url is unauthenticated and 404s/HTMLs on private repos.
      const packets: SyncPacket[] = [];
      for (const m of matches) {
        const r = await fetch(
          `${GITHUB_API}/repos/${this.repoSlug}/contents/${this.path}/${m.name}?ref=${this.branch}`,
          { headers: { ...this.headers(), Accept: "application/vnd.github.raw+json" } }
        );
        if (r.ok) packets.push((await r.json()) as SyncPacket);
      }
      return packets;
    });
  }

  async listVersions(_: DataType): Promise<string[]> { return []; }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      if (!this.gh.token) return { ok: false, message: "No token — paste a Personal Access Token or Fine-grained token" };

      // Verify token works
      const userRes = await fetch(`${GITHUB_API}/user`, { headers: this.headers() });
      if (!userRes.ok) {
        return {
          ok: false,
          message: userRes.status === 401
            ? "Invalid token — check it hasn't expired"
            : `Token check failed (HTTP ${userRes.status})`,
        };
      }
      const user = await userRes.json();

      if (!this.gh.repo) return { ok: true, message: `Signed in as @${user.login} — set a repository below` };

      // Check repo access
      const repoRes = await fetch(`${GITHUB_API}/repos/${this.repoSlug}`, { headers: this.headers() });

      if (repoRes.status === 404) {
        return {
          ok: false,
          message: `Repository '${this.repoSlug}' not found. Create it on GitHub (private) then retry.`,
        };
      }
      if (repoRes.status === 403) {
        return {
          ok: false,
          message: `No access to '${this.repoSlug}'. For Fine-grained tokens: ensure Contents → Read & Write is enabled.`,
        };
      }
      if (!repoRes.ok) {
        return { ok: false, message: `Repo check failed (HTTP ${repoRes.status})` };
      }

      const repo = await repoRes.json();
      const isEmpty = !repo.default_branch;
      return {
        ok: true,
        message: `@${user.login} → ${repo.full_name}${isEmpty ? " (empty repo — will initialize on first sync)" : ""}`,
      };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "Connection failed" };
    }
  }
}

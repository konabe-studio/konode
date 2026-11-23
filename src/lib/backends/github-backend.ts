import { peerDeviceId } from "@/lib/types";
import type { IBackend, BackendConfig, BackendType, DataType, SyncPacket, PeerFile, PeerPull } from "@/lib/types";
import { withRetry, HttpError, defaultShouldRetry, rateLimitMessage } from "@/lib/utils/retry";
import { logger } from "@/lib/utils/logger";
import { utf8ToBase64 } from "@/lib/utils/base64";

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

/**
 * Is this repository empty, so the first write has to create its branch?
 *
 * GitHub leaves `default_branch` out of an empty repository. Gitea and Forgejo name one
 * anyway (the instance's default, `main` unless configured) and say `empty: true`
 * instead, so asking only for the branch would read every new Gitea repository as
 * initialized.
 */
export function isEmptyRepo(repo: { empty?: boolean; default_branch?: string | null }): boolean {
  return repo.empty === true || !repo.default_branch;
}

/** The settings a git forge backend reads: GitHub's block, or Gitea's minus its `url`. */
export interface ForgeSettings {
  token?: string;
  repo?: string;
  branch?: string;
  path?: string;
}

/**
 * The GitHub contents API backend, and the base of `GiteaBackend` (Gitea and Forgejo,
 * whose contents API is shaped like GitHub's). What differs per forge is in the
 * overridable members at the top; everything under them is shared.
 */
export class GitHubBackend implements IBackend {
  readonly type: BackendType = "github";

  constructor(protected config: BackendConfig) {}

  // ── What differs per forge. GitHub's answers here; GiteaBackend overrides them. ──

  /** The name the log lines and error messages use. */
  protected get forgeName(): string { return "GitHub"; }
  /** Where `/user` and `/repos/…` live, without a trailing slash. */
  protected get api(): string { return GITHUB_API; }
  protected get settings(): ForgeSettings | undefined { return this.config.github; }
  /** `owner/repo`, tolerant of a pasted URL / `.git` suffix / trailing slash. */
  protected get repoSlug(): string { return normalizeRepoSlug(this.forge.repo); }

  protected headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.forge.token}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  /** A file's bytes. GitHub answers the contents URL with them when asked for `raw`. */
  protected rawRequest(filePath: string): { url: string; headers: Record<string, string> } {
    return {
      url: `${this.contentsUrl(filePath)}?ref=${encodeURIComponent(this.branch)}`,
      headers: { ...this.headers(), Accept: "application/vnd.github.raw+json" },
    };
  }

  /** GitHub's contents PUT creates a file without a `sha` and updates one with it. */
  protected writeMethod(_sha: string | null): "PUT" | "POST" { return "PUT"; }

  /** A write that lost a race on our own file: re-read the `sha` and try again. */
  protected isWriteConflict(status: number): boolean { return status === 409; }

  /** What a 403 on the repository usually means for this forge's tokens. */
  protected get noAccessHint(): string {
    return "For Fine-grained tokens: ensure Contents → Read & Write is enabled.";
  }

  /** The likely cause when the first commit of an empty repository is refused. */
  protected get cannotWriteHint(): string {
    return "The token likely doesn't have Contents: write on this repository.";
  }

  /** May `GET /user` refuse the token while the repository still works? */
  protected get userCheckOptional(): boolean { return false; }

  /** Anything wrong with the settings before a request is made, or null. */
  protected settingsProblem(): string | null { return null; }

  // ── Shared from here on ──

  isConfigured(): boolean {
    const s = this.settings;
    return !!(s?.token && s?.repo);
  }

  protected get forge(): ForgeSettings {
    const s = this.settings;
    if (!s?.token) throw new Error(`${this.forgeName} token not configured`);
    return s;
  }

  protected get branch(): string { return this.forge.branch ?? "main"; }
  protected get path(): string { return this.forge.path ?? "konode"; }

  protected contentsUrl(filePath: string): string {
    return `${this.api}/repos/${this.repoSlug}/contents/${filePath}`;
  }

  /** Create or update one file, with `sha` when it already exists. */
  private writeFile(filePath: string, body: Record<string, unknown>, sha: string | null): Promise<Response> {
    return fetch(this.contentsUrl(filePath), {
      method: this.writeMethod(sha),
      headers: this.headers(),
      body: JSON.stringify(sha ? { ...body, sha } : body),
    });
  }

  async connect(): Promise<void> {
    if (!this.forge.token) throw new Error("No token configured");
    if (!this.forge.repo) throw new Error("No repository configured");
    const problem = this.settingsProblem();
    if (problem) throw new Error(problem);
    logger.info(`${this.forgeName} connected`, this.forge.repo ?? "");
  }

  async disconnect(): Promise<void> {}

  async upload(packet: SyncPacket): Promise<void> {
    // Ensure repo is initialized before first upload
    await this.ensureRepoInitialized();

    const branch = this.branch;
    const filename = `${this.path}/konode_${packet.data_type}_${packet.device_id}.json`;
    // Same UTF-8-then-base64 as before, via the shared helper — the old
    // btoa(unescape(encodeURIComponent(…))) idiom is byte-identical but leans on
    // deprecated `unescape` and was duplicated per call site.
    const content = utf8ToBase64(JSON.stringify(packet, null, 2));

    await withRetry(
      async () => {
        // Re-read the SHA on every attempt. GitHub's Contents API is eventually
        // consistent, so right after a write a stale SHA can come back and cause a
        // 409 ("…does not match <sha>"); backing off and re-reading lets it settle.
        const sha = await this.getFileSHA(filename, branch);
        const res = await this.writeFile(filename, {
          message: `sync: ${packet.data_type} [${packet.device_id.slice(0, 8)}]`,
          content,
          branch,
        }, sha);
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new HttpError(res.status, `${this.forgeName} upload failed: ${res.status}. ${err.message ?? ""}`);
        }

        logger.info(`${this.forgeName}.upload`, `${packet.data_type} → ${filename}`);
      },
      {
        // A 409 here (422 on Gitea) is a stale-SHA conflict on our *own* file. Retry
        // it (with backoff, re-reading the SHA) on top of the default transient set.
        maxAttempts: 5,
        shouldRetry: (e) =>
          defaultShouldRetry(e) || (e instanceof HttpError && this.isWriteConflict(e.status)),
      }
    );
  }

  private repoInitialized = false;

  private async ensureRepoInitialized(): Promise<void> {
    if (this.repoInitialized) return;
    const problem = this.settingsProblem();
    if (problem) throw new Error(problem);

    const repoRes = await fetch(
      `${this.api}/repos/${this.repoSlug}`,
      { headers: this.headers() }
    );

    if (!repoRes.ok) {
      throw new Error(
        repoRes.status === 404
          ? `Repository '${this.repoSlug}' not found. Create it on ${this.forgeName} first.`
          : `${this.forgeName} repo check failed: ${repoRes.status}`
      );
    }

    const repoData = await repoRes.json();

    // Refuse to sync browser data to a public repo — with E2EE off (the default)
    // it would publish bookmarks/history to the open internet.
    if (repoData.private === false) {
      throw new Error(
        `Repository '${this.repoSlug}' is public. Refusing to sync your browser data to a public repo. Make it private and retry.`
      );
    }

    // If repo is empty (no commits), initialize it
    if (isEmptyRepo(repoData)) {
      const initRes = await this.writeFile("README.md", {
        message: "chore: initialize Konode sync repository",
        content: btoa("# Konode Sync\n\nThis repository is used by the Konode browser extension to sync browser data.\n"),
        // The CONFIGURED branch, not a hardcoded "main". Every other request here uses
        // `this.branch`, so pinning the first commit to main meant a user who had set
        // any other branch got their initial commit on a branch nothing else ever
        // touches, and then every single upload failed against a branch that did not
        // exist. On an empty repo this call is what creates the branch.
        branch: this.branch,
      }, null);
      // The result was thrown away, and `repoInitialized` was set regardless. A token
      // without Contents: write fails HERE, where we know exactly what went wrong — but
      // the error surfaced later as an unexplained upload failure instead, once per data
      // type, with nothing pointing at the real cause.
      if (!initRes.ok) {
        throw new HttpError(
          initRes.status,
          `Couldn't initialize '${this.repoSlug}': writing the first commit failed (HTTP ${initRes.status}). ${this.cannotWriteHint}`
        );
      }
    }

    this.repoInitialized = true;
  }

  private async getFileSHA(path: string, branch: string): Promise<string | null> {
    const res = await fetch(
      `${this.contentsUrl(path)}?ref=${encodeURIComponent(branch)}`,
      // GitHub sends `Cache-Control: max-age=60` on contents reads, so the browser
      // HTTP cache can hand back a stale SHA right after a write — which then makes
      // the next PUT 409 ("does not match"). `no-store` forces a fresh read.
      { headers: this.headers(), cache: "no-store" }
    );
    // 404 = the file doesn't exist yet → create it (no sha). Any OTHER non-ok
    // (500, 403 rate-limit, network blip) is NOT "no file" — throw so the upload's
    // withRetry can back off and re-read, instead of silently omitting the sha and
    // turning a transient read failure into a spurious 409/422 create attempt.
    if (res.status === 404) return null;
    if (!res.ok) throw new HttpError(res.status, `${this.forgeName} SHA read failed: ${res.status}`);
    return (await res.json()).sha ?? null;
  }

  async downloadAll(data_type: DataType, excludeDeviceId?: string): Promise<SyncPacket[]> {
    return (await this.downloadChanged(data_type, excludeDeviceId ?? "", {})).fetched.map((f) => f.packet);
  }

  /**
   * Every peer file, minus the ones whose blob `sha` still equals the one in `known` (#96).
   * The contents listing carries each file's git blob sha, which is a hash of its bytes,
   * so an equal one is equal content (`exact`) and the check costs no extra request.
   * Gitea and Forgejo fill the same `sha` on every listed entry (`entry.ID`), so this
   * holds there too.
   */
  async downloadChanged(data_type: DataType, excludeDeviceId: string, known: Record<string, string>): Promise<PeerPull> {
    return withRetry(async () => {
      const res = await fetch(
        `${this.contentsUrl(this.path)}?ref=${encodeURIComponent(this.branch)}`,
        { headers: this.headers(), cache: "no-store" }
      );
      // 404 = the sync folder doesn't exist yet (no peers). Any other non-OK is a
      // transient/real error — throw so withRetry retries it and a persistent failure
      // surfaces, instead of silently masquerading as "no peers" (which would hide the
      // peers' data and let this device overwrite the group with its own).
      if (res.status === 404) return { fetched: [], unchanged: [] };
      if (!res.ok) throw new HttpError(res.status, `${this.forgeName} list failed: ${res.status}`);
      const files: Array<{ name: string; sha?: string }> = await res.json();
      // Fetch each through the authenticated API (`rawRequest`); the public
      // download_url is unauthenticated and 404s/HTMLs on private repos.
      const fetched: PeerPull["fetched"] = [];
      const unchanged: PeerFile[] = [];
      for (const m of files) {
        const deviceId = peerDeviceId(m.name, data_type);
        if (!deviceId || deviceId === excludeDeviceId) continue;
        const file: PeerFile = { device_id: deviceId, marker: m.sha || null, exact: true };
        if (file.marker && known[deviceId] === file.marker) {
          unchanged.push(file);
          continue;
        }
        const raw = this.rawRequest(`${this.path}/${m.name}`);
        const r = await fetch(raw.url, { headers: raw.headers, cache: "no-store" });
        if (!r.ok) {
          // See the note in webdav-backend: a peer we can't fetch silently vanished from
          // the sync while it still reported success.
          logger.warn(
            `${this.forgeName}.downloadAll`,
            `Couldn't download ${m.name} (HTTP ${r.status}) — that device is left out of this sync`
          );
          continue;
        }
        try {
          fetched.push({ packet: JSON.parse(await r.text()) as SyncPacket, file });
        } catch {
          logger.warn(`${this.forgeName}.downloadAll`, `Skipping unreadable sync file: ${m.name}`);
        }
      }
      return { fetched, unchanged };
    });
  }

  async putFile(name: string, content: string): Promise<void> {
    await this.ensureRepoInitialized();
    const filename = `${this.path}/${name}`;
    const encoded = utf8ToBase64(content);
    await withRetry(
      async () => {
        const sha = await this.getFileSHA(filename, this.branch);
        const res = await this.writeFile(filename, { message: `snapshot: ${name}`, content: encoded, branch: this.branch }, sha);
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new HttpError(res.status, `${this.forgeName} putFile failed: ${res.status}. ${err.message ?? ""}`);
        }
      },
      { maxAttempts: 5, shouldRetry: (e) => defaultShouldRetry(e) || (e instanceof HttpError && this.isWriteConflict(e.status)) }
    );
  }

  async getFile(name: string): Promise<string | null> {
    return withRetry(async () => {
      const raw = this.rawRequest(`${this.path}/${name}`);
      const res = await fetch(raw.url, { headers: raw.headers, cache: "no-store" });
      if (res.status === 404) return null;
      if (!res.ok) throw new HttpError(res.status, `${this.forgeName} getFile failed: ${res.status}`);
      return res.text();
    });
  }

  async listFiles(prefix: string): Promise<string[]> {
    return withRetry(async () => {
      const res = await fetch(
        `${this.contentsUrl(this.path)}?ref=${encodeURIComponent(this.branch)}`,
        { headers: this.headers(), cache: "no-store" }
      );
      if (res.status === 404) return [];
      if (!res.ok) throw new HttpError(res.status, `${this.forgeName} list failed: ${res.status}`);
      const files: Array<{ name: string }> = await res.json();
      return files.map(f => f.name).filter(n => n.startsWith(prefix));
    });
  }

  async deleteFile(name: string): Promise<void> {
    const filename = `${this.path}/${name}`;
    await withRetry(async () => {
      const sha = await this.getFileSHA(filename, this.branch);
      if (!sha) return; // already gone
      const res = await fetch(this.contentsUrl(filename), {
        method: "DELETE", headers: this.headers(),
        body: JSON.stringify({ message: `snapshot: delete ${name}`, sha, branch: this.branch }),
      });
      if (!res.ok && res.status !== 404) throw new HttpError(res.status, `${this.forgeName} DELETE failed: ${res.status}`);
    });
  }


  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      if (!this.settings?.token) return { ok: false, message: "No token. Paste a Personal Access Token or Fine-grained token" };
      const problem = this.settingsProblem();
      if (problem) return { ok: false, message: problem };

      // Verify token works
      const userRes = await fetch(`${this.api}/user`, { headers: this.headers() });
      if (userRes.status === 429) return { ok: false, message: rateLimitMessage(this.forgeName) };
      // A Gitea token scoped to the repository alone is refused here with 403 and still
      // syncs, so there it only costs the name in the result.
      const userSkipped = userRes.status === 403 && this.userCheckOptional;
      if (!userRes.ok && !userSkipped) {
        return {
          ok: false,
          message: userRes.status === 401
            ? "Invalid token. Check it hasn't expired"
            : userRes.status === 404
              ? `No ${this.forgeName} API at ${this.api}. Check the address.`
              : `Token check failed (HTTP ${userRes.status})`,
        };
      }
      const user: { login?: string } = userSkipped ? {} : await userRes.json();
      const who = user.login ? `@${user.login}` : "Token accepted";

      if (!this.settings?.repo) return { ok: true, message: `${user.login ? `Signed in as @${user.login}` : who}. Set a repository below` };

      // Check repo access
      const repoRes = await fetch(`${this.api}/repos/${this.repoSlug}`, { headers: this.headers() });

      if (repoRes.status === 404) {
        return {
          ok: false,
          message: `Repository '${this.repoSlug}' not found. Create it on ${this.forgeName} (private) then retry.`,
        };
      }
      if (repoRes.status === 403) {
        return {
          ok: false,
          message: `No access to '${this.repoSlug}'. ${this.noAccessHint}`,
        };
      }
      if (!repoRes.ok) {
        return { ok: false, message: `Repo check failed (HTTP ${repoRes.status})` };
      }

      const repo = await repoRes.json();
      if (repo.private === false) {
        return {
          ok: false,
          message: `'${repo.full_name}' is a public repository. Your synced data would be visible to everyone. Use a private repo.`,
        };
      }
      const isEmpty = isEmptyRepo(repo);

      // Verify the BRANCH as well. A typo here passed this test and then 404'd on every
      // upload — and 404 isn't retried, so the sync failed permanently while the test
      // still said everything was fine. Skipped for an empty repo: it has no branches
      // yet, the first upload creates one.
      if (!isEmpty) {
        const branch = this.branch;
        const brRes = await fetch(
          `${this.api}/repos/${this.repoSlug}/branches/${encodeURIComponent(branch)}`,
          { headers: this.headers() }
        );
        if (brRes.status === 404) {
          return {
            ok: false,
            message: `Branch '${branch}' doesn't exist in ${repo.full_name}. Its default branch is '${repo.default_branch}'.`,
          };
        }
        if (!brRes.ok) return { ok: false, message: `Branch check failed (HTTP ${brRes.status})` };
      }

      return {
        ok: true,
        message: `${who} → ${repo.full_name}${isEmpty ? " (empty repo, will initialize on first sync)" : ` (${this.branch})`}`,
      };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "Connection failed" };
    }
  }
}

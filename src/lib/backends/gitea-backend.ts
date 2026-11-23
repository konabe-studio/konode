import type { BackendType } from "@/lib/types";
import { isSecureBackendUrl } from "@/lib/utils/url";
import { GitHubBackend, type ForgeSettings } from "./github-backend";

/**
 * Gitea and Forgejo (#32, #76), on the GitHub backend.
 *
 * Gitea's contents API is shaped like GitHub's and Forgejo follows Gitea, so this is the
 * same backend with these differences, each checked against Gitea's own source and API
 * docs (2026-11, `routers/api/v1/repo/file.go`, `services/repository/files/`) and then
 * against a real Gitea in the QA harness:
 *
 * - The API lives at `<instance>/api/v1`, on a host the user names.
 * - The documented auth header is `Authorization: token <t>`. (Bearer is accepted too.)
 * - Contents reads ignore GitHub's `Accept: …raw` and always answer JSON, so a file's
 *   bytes come from `GET /repos/{o}/{r}/raw/{path}?ref=` instead.
 * - POST creates a file, PUT with `sha` updates it. Newer Gitea also creates on a PUT
 *   without `sha`, older releases required it, so a create always goes out as POST.
 * - A stale `sha`, or a create of a file that appeared meanwhile, answers 422, not
 *   GitHub's 409, and is retried the same way.
 * - An empty repository still names a default branch and says `empty: true`
 *   (`isEmptyRepo`).
 * - The directory listing carries the git blob `sha` of every entry and is not paginated,
 *   so the #96 change marker works unchanged.
 * - CORS is off by default, so the extension reaches the instance through a host
 *   permission asked for at save time, as with a WebDAV server.
 */

/**
 * The instance address as the user typed it, reduced to scheme, host and any subpath the
 * instance is served under: `git.example.com` → `https://git.example.com`, and a pasted
 * `…/api/v1` or trailing slash is dropped. Empty when it can't be read as an address.
 */
export function forgeBaseUrl(input: string | undefined): string {
  let s = (input ?? "").trim();
  if (!s) return "";
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && u.protocol !== "http:") return "";
    return `${u.origin}${u.pathname}`.replace(/\/+$/, "").replace(/\/api\/v1$/i, "");
  } catch {
    return "";
  }
}

/** The API root of a Gitea or Forgejo instance. */
export function giteaApiBase(input: string | undefined): string {
  const base = forgeBaseUrl(input);
  return base ? `${base}/api/v1` : "";
}

/**
 * `owner/repo` from whatever was pasted into the Repository field: the slug itself, the
 * repository's web address (also under a subpath install, and also a deeper page of it
 * such as `/src/branch/main`), or a clone address (`git@host:owner/repo.git`,
 * `ssh://git@host:2222/owner/repo.git`). `instance` lets a subpath install's prefix be
 * told apart from the owner.
 */
export function normalizeForgeRepoSlug(input: string | undefined, instance?: string): string {
  let s = (input ?? "").trim();
  if (!s) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      s = u.pathname;
      const basePath = (() => {
        try { return new URL(forgeBaseUrl(instance)).pathname.replace(/\/+$/, ""); } catch { return ""; }
      })();
      if (basePath && s.toLowerCase().startsWith(`${basePath.toLowerCase()}/`)) s = s.slice(basePath.length);
    } catch { /* not an address after all: read it as a slug */ }
  } else {
    s = s.replace(/^[^@\s/]+@[^:\s/]+:/, ""); // scp-style clone address
  }
  const parts = s.split("/").filter(Boolean).slice(0, 2);
  if (parts.length === 2) parts[1] = parts[1].replace(/\.git$/i, "");
  return parts.join("/");
}

export class GiteaBackend extends GitHubBackend {
  readonly type: BackendType = "gitea";

  protected get forgeName(): string { return "Gitea"; }
  protected get api(): string { return giteaApiBase(this.config.gitea?.url); }
  protected get settings(): ForgeSettings | undefined { return this.config.gitea; }
  protected get repoSlug(): string { return normalizeForgeRepoSlug(this.forge.repo, this.config.gitea?.url); }

  isConfigured(): boolean {
    return super.isConfigured() && !!this.api;
  }

  protected headers(): Record<string, string> {
    return {
      Authorization: `token ${this.forge.token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  protected rawRequest(filePath: string): { url: string; headers: Record<string, string> } {
    return {
      url: `${this.api}/repos/${this.repoSlug}/raw/${filePath}?ref=${encodeURIComponent(this.branch)}`,
      headers: this.headers(),
    };
  }

  protected writeMethod(sha: string | null): "PUT" | "POST" { return sha ? "PUT" : "POST"; }

  protected isWriteConflict(status: number): boolean { return status === 409 || status === 422; }

  protected get noAccessHint(): string {
    return "Give the token the repository: Read and Write permission.";
  }

  protected get cannotWriteHint(): string {
    return "The token likely doesn't have the repository: Read and Write permission.";
  }

  protected get userCheckOptional(): boolean { return true; }

  /**
   * The token goes in every request, so a plain http:// instance is refused the way a
   * WebDAV server's is, loopback aside. The browser could not be asked for such a host
   * anyway: the manifest grants http only on localhost.
   */
  protected settingsProblem(): string | null {
    const url = this.config.gitea?.url;
    if (!forgeBaseUrl(url)) return "No Gitea or Forgejo address. Enter the address of your instance, such as https://git.example.com";
    if (!isSecureBackendUrl(forgeBaseUrl(url))) {
      return "Gitea over plain http:// is not allowed. Your token would be sent unencrypted on every request. Use an https:// address (http is permitted only for localhost).";
    }
    return null;
  }
}

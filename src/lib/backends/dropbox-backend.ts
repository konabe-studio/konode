import { peerDeviceId } from "@/lib/types";
import type { IBackend, BackendConfig, DataType, ListedFile, PeerFile, PeerPull, SyncPacket } from "@/lib/types";
import { withRetry, HttpError, rateLimitMessage, retryAfterMs } from "@/lib/utils/retry";
import { logger } from "@/lib/utils/logger";
import { getDropboxAccessToken, getStoredDropboxUser, DROPBOX_EXPIRED_MSG } from "./dropbox-oauth";

/**
 * Dropbox, through its HTTP API v2, in an App folder.
 *
 * Why an App folder rather than full Dropbox access: Konode only ever reads and writes its
 * own files, and an App folder app's token can reach nothing outside `Apps/Konode`, which
 * is the same promise Drive's `drive.file` scope makes. Every Konode file sits at the root
 * of that folder (path `""` in the API), so there is no folder to look up or create, and no
 * way for two devices to race into two of them as on Drive. Dropbox also lists the folder
 * under the app's name in the user's Dropbox, so the user can see and back up the files.
 *
 * The listing (`files/list_folder`, paginated through `list_folder/continue`) carries each
 * file's `content_hash`, Dropbox's hash over the file's bytes, so it is the #96 change
 * marker and is exact, like Drive's md5Checksum: an equal hash is equal content and the file
 * is not downloaded again. `rev` is the fallback, also exact (a revision is one version).
 *
 * Errors, as Dropbox gives them:
 * - 401: the access token is no longer taken. Refreshed once and the call repeated, unless
 *   the body says `missing_scope`, which no refresh can fix.
 * - 409: the endpoint's own error, `error_summary` like `path/not_found/..`. A missing file
 *   is an answer (null, nothing to delete); anything else is thrown with its summary.
 * - 429: rate limited (`too_many_requests`, or `too_many_write_operations` when writes
 *   contend). `Retry-After` is honoured by `withRetry`.
 * - 5xx: transient, retried.
 */

const API = "https://api.dropboxapi.com/2";
const CONTENT = "https://content.dropboxapi.com/2";

/** Dropbox's page size cap for list_folder. One page covers every realistic group. */
const LIST_LIMIT = 2000;

interface DropboxEntry {
  ".tag": "file" | "folder" | "deleted";
  name: string;
  path_lower?: string;
  server_modified?: string;
  rev?: string;
  content_hash?: string;
}

/**
 * The `Dropbox-API-Arg` header value: JSON with every character above 0x7E escaped as
 * `\uXXXX`, since an HTTP header must be ASCII and Dropbox says to escape that way. Konode's
 * own file names are ASCII, so this matters only if that ever changes.
 */
export function dropboxArg(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** A file in the App folder by name. Dropbox paths start with a slash; the folder is "". */
function filePath(name: string): string {
  return `/${name}`;
}

/** The `error_summary` of a Dropbox error body, or "" when it has none. */
async function errorSummary(res: Response): Promise<string> {
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text);
      return String(j.error_summary ?? j.error?.[".tag"] ?? "");
    } catch {
      return text.slice(0, 200);
    }
  } catch {
    return "";
  }
}

export class DropboxBackend implements IBackend {
  readonly type = "dropbox" as const;

  constructor(private config: BackendConfig) {}

  isConfigured(): boolean { return true; }

  /**
   * One authorised request. `build` gets the access token and returns the request, so it can
   * be built again after a refresh. Answers an ok or 409 response; throws an HttpError for
   * everything else, with what Dropbox said, so `withRetry` around it can judge it.
   */
  private async send(url: string, build: (token: string) => RequestInit): Promise<Response> {
    let token = await getDropboxAccessToken();
    let res = await fetch(url, { ...build(token), cache: "no-store" });
    if (res.status === 401) {
      const summary = await errorSummary(res);
      if (/missing_scope/.test(summary)) {
        throw new HttpError(401, `Konode's Dropbox app lacks a permission it needs (${summary}).`);
      }
      // Expired or revoked access token: one refresh, then the same request once more.
      token = await getDropboxAccessToken(true);
      res = await fetch(url, { ...build(token), cache: "no-store" });
      if (res.status === 401) throw new HttpError(401, DROPBOX_EXPIRED_MSG);
    }
    if (res.ok || res.status === 409) return res;
    if (res.status === 429) {
      throw new HttpError(429, rateLimitMessage("Dropbox"), retryAfterMs(res));
    }
    const summary = await errorSummary(res);
    throw new HttpError(res.status, `Dropbox request failed: ${res.status}${summary ? ` ${summary}` : ""}`);
  }

  /** An RPC endpoint: JSON in, JSON out. */
  private rpc(endpoint: string, args: unknown): Promise<Response> {
    return this.send(`${API}/${endpoint}`, (token) => ({
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
    }));
  }

  /** Throws for a 409 that is not one of the summaries the caller can live with. */
  private async check409(res: Response, what: string, tolerated?: RegExp): Promise<boolean> {
    if (res.status !== 409) return false;
    const summary = await errorSummary(res);
    if (tolerated?.test(summary)) return true;
    if (/insufficient_space/.test(summary)) {
      throw new HttpError(409, "Your Dropbox is full, so Konode can't save its files. Free up space in Dropbox.");
    }
    throw new HttpError(409, `Dropbox ${what} failed: ${summary || "409"}`);
  }

  /** Every file at the root of the App folder, all pages of it. */
  private async listAll(): Promise<DropboxEntry[]> {
    const out: DropboxEntry[] = [];
    let res = await this.rpc("files/list_folder", { path: "", recursive: false, include_deleted: false, limit: LIST_LIMIT });
    // A fresh App folder may not exist until the first write: that is an empty folder.
    if (await this.check409(res, "list", /path\/not_found/)) return out;
    for (;;) {
      const page = (await res.json()) as { entries?: DropboxEntry[]; cursor?: string; has_more?: boolean };
      for (const e of page.entries ?? []) if (e[".tag"] === "file") out.push(e);
      if (!page.has_more || !page.cursor) return out;
      res = await this.rpc("files/list_folder/continue", { cursor: page.cursor });
      await this.check409(res, "list");
    }
  }

  /** A file's text, or null when there is no such file. */
  private async download(path: string): Promise<string | null> {
    const res = await this.send(`${CONTENT}/files/download`, (token) => ({
      method: "POST",
      // A content-download endpoint: the argument rides in the header, the body is empty.
      headers: { Authorization: `Bearer ${token}`, "Dropbox-API-Arg": dropboxArg({ path }) },
    }));
    if (await this.check409(res, "download", /path\/not_found/)) return null;
    return res.text();
  }

  async connect(): Promise<void> {
    // The saved settings name the account this device syncs with (the destination tag is
    // built from it). A session for another account would write into a Dropbox the upload
    // checksums know nothing about, so it is refused until the settings are saved again.
    const want = this.config.dropbox?.account;
    if (!want) return;
    const have = (await getStoredDropboxUser())?.account_id;
    if (have && have !== want) {
      throw new Error("The Dropbox account signed in on this device is not the one in the saved settings. Open Konode's Settings and press Save.");
    }
  }

  async disconnect(): Promise<void> {}

  async upload(packet: SyncPacket): Promise<void> {
    const filename = `konode_${packet.data_type}_${packet.device_id}.json`;
    await this.putFile(filename, JSON.stringify(packet, null, 2));
    logger.info("Dropbox.upload", `${packet.data_type} → ${filename}`);
  }

  async downloadAll(data_type: DataType, excludeDeviceId?: string): Promise<SyncPacket[]> {
    return (await this.downloadChanged(data_type, excludeDeviceId ?? "", {})).fetched.map((f) => f.packet);
  }

  /**
   * Every peer file, minus those whose `content_hash` still equals the one in `known` (#96).
   * Dropbox names are unique in a folder (case-insensitively), so there is one file per
   * device and no duplicate to choose between, unlike Drive.
   */
  async downloadChanged(data_type: DataType, excludeDeviceId: string, known: Record<string, string>): Promise<PeerPull> {
    return withRetry(async () => {
      const entries = await this.listAll();
      const fetched: PeerPull["fetched"] = [];
      const unchanged: PeerFile[] = [];
      for (const e of entries) {
        const deviceId = peerDeviceId(e.name, data_type);
        if (!deviceId || deviceId === excludeDeviceId) continue;
        const file: PeerFile = { device_id: deviceId, marker: e.content_hash || e.rev || null, exact: true };
        if (file.marker && known[deviceId] === file.marker) {
          unchanged.push(file);
          continue;
        }
        const text = await this.download(e.path_lower ?? filePath(e.name));
        if (text === null) {
          // Listed a moment ago and gone now: that device removed it (Forget device).
          logger.warn("Dropbox.downloadAll", `${e.name} vanished before it could be read; that device is left out of this sync`);
          continue;
        }
        try {
          fetched.push({ packet: JSON.parse(text) as SyncPacket, file });
        } catch {
          logger.warn("Dropbox.downloadAll", `Skipping unreadable sync file: ${e.name}`);
        }
      }
      return { fetched, unchanged };
    });
  }

  async putFile(name: string, content: string): Promise<void> {
    await withRetry(async () => {
      const res = await this.send(`${CONTENT}/files/upload`, (token) => ({
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/octet-stream",
          // overwrite: one file per name, replaced in place. mute: no "file changed"
          // notification on the user's other Dropbox clients for every sync.
          "Dropbox-API-Arg": dropboxArg({ path: filePath(name), mode: "overwrite", autorename: false, mute: true }),
        },
        body: content,
      }));
      await this.check409(res, "upload");
    });
  }

  async getFile(name: string): Promise<string | null> {
    return withRetry(() => this.download(filePath(name)));
  }

  async listFiles(prefix: string): Promise<string[]> {
    return withRetry(async () => (await this.listAll()).map((e) => e.name).filter((n) => n.startsWith(prefix)));
  }

  async listFilesWithTimes(prefix: string): Promise<ListedFile[]> {
    return withRetry(async () =>
      (await this.listAll())
        .filter((e) => e.name.startsWith(prefix))
        .map((e) => {
          const t = e.server_modified ? Date.parse(e.server_modified) : NaN;
          return { name: e.name, modified: Number.isNaN(t) ? null : t };
        })
    );
  }

  async deleteFile(name: string): Promise<void> {
    await withRetry(async () => {
      const res = await this.rpc("files/delete_v2", { path: filePath(name) });
      await this.check409(res, "delete", /not_found/);
    });
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      const stored = await getStoredDropboxUser();
      if (!stored) return { ok: false, message: "Not signed in to Dropbox yet." };
      // Call Dropbox for real, the account and then the folder: a revoked grant or a
      // missing file permission has to fail here, not on the first sync.
      const res = await this.rpc("users/get_current_account", null);
      const d = await res.json().catch(() => ({}));
      await this.listAll();
      const name = d?.name?.display_name || stored.displayName;
      const email = d?.email || stored.email;
      return { ok: true, message: `Connected as ${name}${email ? ` (${email})` : ""}. Files go to Apps/Konode.` };
    } catch (err) {
      if (err instanceof HttpError && err.status === 429) return { ok: false, message: rateLimitMessage("Dropbox") };
      return { ok: false, message: err instanceof Error ? err.message : "Connection failed" };
    }
  }
}

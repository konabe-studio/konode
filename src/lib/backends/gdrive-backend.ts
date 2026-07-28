import type { IBackend, BackendConfig, DataType, SyncPacket } from "@/lib/types";
import { withRetry, HttpError } from "@/lib/utils/retry";
import { logger } from "@/lib/utils/logger";
import {
  getAccessToken,
  interactiveSignIn,
  getStoredGDriveUser,
  clearGDriveSession,
} from "./gdrive-oauth";
import { clearUploadChecksums, getLastDriveFolder, setLastDriveFolder } from "@/lib/utils/storage";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const KONODE_FOLDER = "Konode";

/** The subset of a Drive file we need in order to choose between duplicates. */
export interface DriveFileRef {
  id: string;
  createdTime?: string;
}

/**
 * Pick ONE match deterministically when Drive returns several.
 *
 * Drive has no atomic create-if-absent, so two devices connecting for the first time at
 * the same moment both see nothing and both create a "Konode" folder; a retried upload
 * whose create response was lost can likewise leave two files with the same name (Drive
 * permits duplicate names within a folder).
 *
 * Taking files[0] meant devices could settle on DIFFERENT duplicates and then sync into
 * separate folders forever, each convinced it was the only device. Duplicates can't always
 * be prevented, but agreeing on which one wins can — and that turns a permanent split into
 * something the group converges out of. Oldest first, id as the tie-break: stable across
 * devices and across calls. createdTime is RFC 3339, so a lexicographic compare is
 * chronological; without it the id alone is still deterministic.
 */
export function pickCanonical<T extends DriveFileRef>(files: T[]): T | undefined {
  return [...files].sort(
    (a, b) => (a.createdTime ?? "").localeCompare(b.createdTime ?? "") || a.id.localeCompare(b.id)
  )[0];
}

export interface GDriveUserInfo {
  email: string;
  displayName: string;
  photoUrl?: string;
}

export class GDriveBackend implements IBackend {
  readonly type = "gdrive" as const;
  private folderId: string | null = null;

  constructor(private config: BackendConfig) {}

  isConfigured(): boolean { return true; }

  /** Valid access token, refreshing via the stored refresh token when needed. */
  async getToken(interactive = false): Promise<string> {
    return getAccessToken(interactive);
  }

  async signIn(): Promise<GDriveUserInfo> {
    const s = await interactiveSignIn();
    return { email: s.email, displayName: s.displayName };
  }

  async signOut(): Promise<void> {
    this.folderId = null;
    await clearGDriveSession();
    logger.event("GDrive.signOut", "Signed out");
  }

  async getSignedInUser(): Promise<GDriveUserInfo | null> {
    return getStoredGDriveUser();
  }

  private async authHeaders(): Promise<HeadersInit> {
    const token = await this.getToken(false);
    return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  }

  async connect(): Promise<void> {
    this.folderId = await this.ensureFolder();
    logger.info("GDrive.connect", `Folder ID: ${this.folderId}`);
  }

  async disconnect(): Promise<void> { this.folderId = null; }

  /** Every non-trashed "Konode" folder this app can see. */
  private async findFolders(h: HeadersInit): Promise<DriveFileRef[]> {
    const q = encodeURIComponent(`name='${KONODE_FOLDER}' and mimeType='${FOLDER_MIME}' and trashed=false`);
    const res = await fetch(`${DRIVE_API}/files?q=${q}&fields=files(id,name,createdTime)`, { headers: h });
    if (!res.ok) throw new HttpError(res.status, `Drive folder lookup failed: ${res.status}`);
    return ((await res.json()).files ?? []) as DriveFileRef[];
  }

  private async ensureFolder(): Promise<string> {
    const id = await this.resolveFolder();
    await this.noteResolvedFolder(id);
    return id;
  }

  /**
   * Remember which folder we resolved, and if it MOVED, forget what we think we uploaded.
   *
   * `destinationTag()` in the sync engine is built from the CONFIG, and Drive's folder
   * isn't in the config — it's found by lookup. So the tag is blind to a change here, and
   * a device that started writing into a different folder kept its upload checksums and
   * left the new folder EMPTY while reporting a clean sync. That is precisely the failure
   * the destination tag exists to prevent, in the one case it cannot see.
   *
   * Reachable, and the duplicate-folder warning actively invites it: told that "the empty
   * duplicate can be deleted in Drive", a user who trashes the wrong one sends this device
   * to a brand-new folder it would then never populate.
   *
   * Only flushes when there WAS a previous folder and it differs — a first run has no
   * checksums to invalidate. The key is the engine's, which is a small reach from a
   * backend; the alternative was an IBackend method threaded through the tag, for one
   * backend that needs it.
   */
  private async noteResolvedFolder(id: string): Promise<void> {
    const previous = await getLastDriveFolder();
    if (previous === id) return;
    await setLastDriveFolder(id);
    if (previous) {
      logger.warn(
        "GDrive",
        "The Konode folder changed — re-uploading this device's files into the new one."
      );
      await clearUploadChecksums();
    }
  }

  private async resolveFolder(): Promise<string> {
    const h = await this.authHeaders();
    const configured = this.config.gdrive?.folderId;
    if (configured) return configured;

    const found = await this.findFolders(h);
    if (found.length > 1) {
      logger.warn(
        "GDrive.ensureFolder",
        `${found.length} Konode folders exist in this Drive; using the oldest. You can delete the extras.`
      );
    }
    const existing = pickCanonical(found);
    if (existing) return existing.id;

    const create = await fetch(`${DRIVE_API}/files`, {
      method: "POST", headers: h,
      body: JSON.stringify({ name: KONODE_FOLDER, mimeType: FOLDER_MIME }),
    });
    if (!create.ok) throw new HttpError(create.status, `Drive folder create failed: ${create.status}`);
    const created = await create.json();
    if (!created.id) throw new Error("Drive folder create returned no id");

    // Re-resolve. Another device setting up at the same moment saw an empty Drive too and
    // created its own folder; if we each kept the one we made, the group would be split
    // from the very first sync. Applying the same rule on both sides lands them together.
    // The losing folder is deliberately left alone: it is the user's Drive, and quietly
    // trashing something on a heuristic is not this code's call. The warning says so.
    const winner = pickCanonical(await this.findFolders(h));
    if (winner && winner.id !== created.id) {
      logger.warn(
        "GDrive.ensureFolder",
        "Another device created the Konode folder at the same time; using the older one. The empty duplicate can be deleted in Drive."
      );
      return winner.id;
    }
    return created.id as string;
  }

  async upload(packet: SyncPacket): Promise<void> {
    await withRetry(async () => {
      const folderId = this.folderId ?? (await this.ensureFolder());
      const h = await this.authHeaders();
      const token = await this.getToken(false);
      const filename = `konode_${packet.data_type}_${packet.device_id}.json`;
      const content = JSON.stringify(packet, null, 2);
      // Was an inline copy of findFileId; routed through it so the duplicate handling
      // lives in exactly one place.
      const existingId = await this.findFileId(filename, folderId, h);
      if (existingId) {
        const res = await fetch(`${UPLOAD_API}/files/${existingId}?uploadType=media`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: content,
        });
        if (!res.ok) throw new HttpError(res.status, `Drive update failed: ${res.status}`);
      } else {
        // Drive's multipart upload expects multipart/related (metadata part then
        // media part) — a FormData multipart/form-data body is silently ignored
        // for metadata, landing the file outside the folder / with no name.
        const boundary = `konode_${packet.checksum}_${packet.device_id.slice(0, 8)}`;
        const metadata = JSON.stringify({ name: filename, parents: [folderId], mimeType: "application/json" });
        const body =
          `--${boundary}\r\n` +
          `Content-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
          `--${boundary}\r\n` +
          `Content-Type: application/json\r\n\r\n${content}\r\n` +
          `--${boundary}--`;
        const res = await fetch(`${UPLOAD_API}/files?uploadType=multipart`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
          body,
        });
        if (!res.ok) throw new HttpError(res.status, `Drive create failed: ${res.status}`);
      }
      logger.info("GDrive.upload", `${packet.data_type} → ${filename}`);
    });
  }

  async downloadAll(data_type: DataType, excludeDeviceId?: string): Promise<SyncPacket[]> {
    return withRetry(async () => {
      const folderId = this.folderId ?? (await this.ensureFolder());
      const h = await this.authHeaders();
      const q = encodeURIComponent(`name contains 'konode_${data_type}_' and '${folderId}' in parents and trashed=false`);
      const listRes = await fetch(`${DRIVE_API}/files?q=${q}&fields=files(id,name,modifiedTime)&orderBy=modifiedTime desc`, { headers: h, cache: "no-store" });
      if (!listRes.ok) throw new HttpError(listRes.status, `Drive list failed: ${listRes.status}`);
      const { files } = await listRes.json();
      if (!files?.length) return [];
      // Every peer file (newest first), minus our own.
      const own = excludeDeviceId ? `konode_${data_type}_${excludeDeviceId}.json` : null;
      const peers = (files as Array<{ id: string; name: string }>).filter((f) => f.name !== own);
      const packets: SyncPacket[] = [];
      for (const f of peers) {
        const r = await fetch(`${DRIVE_API}/files/${f.id}?alt=media`, { headers: h, cache: "no-store" });
        if (!r.ok) {
          // See the note in webdav-backend: a peer we can't fetch silently vanished from
          // the sync while it still reported success.
          logger.warn(
            "GDrive.downloadAll",
            `Couldn't download ${f.name} (HTTP ${r.status}) — that device is left out of this sync`
          );
          continue;
        }
        try {
          packets.push(JSON.parse(await r.text()) as SyncPacket);
        } catch {
          logger.warn("GDrive.downloadAll", `Skipping unreadable sync file: ${f.name}`);
        }
      }
      return packets;
    });
  }

  private async findFileId(name: string, folderId: string, h: HeadersInit): Promise<string | null> {
    const q = encodeURIComponent(`name='${name}' and '${folderId}' in parents and trashed=false`);
    const res = await fetch(`${DRIVE_API}/files?q=${q}&fields=files(id,createdTime)`, { headers: h });
    if (!res.ok) throw new HttpError(res.status, `Drive lookup failed: ${res.status}`);
    const files = ((await res.json()).files ?? []) as DriveFileRef[];
    if (files.length > 1) {
      // A retried upload whose create response was lost can leave two files with the same
      // name. Always updating the same one keeps a single file authoritative, instead of
      // writing alternately into both and leaving peers to read whichever they pick.
      logger.warn("GDrive", `${files.length} copies of ${name} in the Konode folder; updating the oldest.`);
    }
    return pickCanonical(files)?.id ?? null;
  }

  async putFile(name: string, content: string): Promise<void> {
    await withRetry(async () => {
      const folderId = this.folderId ?? (await this.ensureFolder());
      const h = await this.authHeaders();
      const token = await this.getToken(false);
      const existingId = await this.findFileId(name, folderId, h);
      if (existingId) {
        const res = await fetch(`${UPLOAD_API}/files/${existingId}?uploadType=media`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: content,
        });
        if (!res.ok) throw new HttpError(res.status, `Drive update failed: ${res.status}`);
      } else {
        const boundary = `konode_snap_${name.length}_${content.length}`;
        const metadata = JSON.stringify({ name, parents: [folderId], mimeType: "application/json" });
        const body =
          `--${boundary}\r\n` +
          `Content-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
          `--${boundary}\r\n` +
          `Content-Type: application/json\r\n\r\n${content}\r\n` +
          `--${boundary}--`;
        const res = await fetch(`${UPLOAD_API}/files?uploadType=multipart`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
          body,
        });
        if (!res.ok) throw new HttpError(res.status, `Drive create failed: ${res.status}`);
      }
    });
  }

  async getFile(name: string): Promise<string | null> {
    return withRetry(async () => {
      const folderId = this.folderId ?? (await this.ensureFolder());
      const h = await this.authHeaders();
      const id = await this.findFileId(name, folderId, h);
      if (!id) return null;
      const r = await fetch(`${DRIVE_API}/files/${id}?alt=media`, { headers: h, cache: "no-store" });
      if (r.status === 404) return null;
      if (!r.ok) throw new HttpError(r.status, `Drive GET failed: ${r.status}`);
      return r.text();
    });
  }

  async listFiles(prefix: string): Promise<string[]> {
    return withRetry(async () => {
      const folderId = this.folderId ?? (await this.ensureFolder());
      const h = await this.authHeaders();
      // Drive's `contains` is a loose token match, so filter to a real startsWith below.
      const q = encodeURIComponent(`name contains '${prefix}' and '${folderId}' in parents and trashed=false`);
      const res = await fetch(`${DRIVE_API}/files?q=${q}&fields=files(name)`, { headers: h, cache: "no-store" });
      if (!res.ok) throw new HttpError(res.status, `Drive list failed: ${res.status}`);
      const { files } = await res.json();
      return ((files ?? []) as Array<{ name: string }>).map(f => f.name).filter(n => n.startsWith(prefix));
    });
  }

  async deleteFile(name: string): Promise<void> {
    await withRetry(async () => {
      const folderId = this.folderId ?? (await this.ensureFolder());
      const h = await this.authHeaders();
      const id = await this.findFileId(name, folderId, h);
      if (!id) return;
      const res = await fetch(`${DRIVE_API}/files/${id}`, { method: "DELETE", headers: h });
      if (!res.ok && res.status !== 404) throw new HttpError(res.status, `Drive DELETE failed: ${res.status}`);
    });
  }

  async listVersions(_data_type: DataType): Promise<string[]> { return []; }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      const stored = await this.getSignedInUser();
      if (!stored) return { ok: false, message: "Not signed in to Google Drive yet." };
      // Actually CALL Drive. This used to report success from stored session data alone,
      // so a revoked grant or a dead refresh token still answered "Connected as …" — a
      // connection test that never touched the connection. getToken() renews via the
      // refresh token first, and throws a clear message if that no longer works.
      const token = await this.getToken(false);
      const res = await fetch(`${DRIVE_API}/about?fields=user`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401 || res.status === 403) {
        return { ok: false, message: "Google rejected the saved access. Sign in again." };
      }
      if (!res.ok) return { ok: false, message: `Drive check failed (HTTP ${res.status})` };
      const d = await res.json();
      const name = d.user?.displayName ?? stored.displayName;
      const email = d.user?.emailAddress ?? stored.email;
      return { ok: true, message: `Connected as ${name}${email ? ` (${email})` : ""}` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "Connection failed" };
    }
  }
}

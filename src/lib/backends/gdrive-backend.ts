import type { IBackend, BackendConfig, DataType, SyncPacket } from "@/lib/types";
import { withRetry, HttpError } from "@/lib/utils/retry";
import { logger } from "@/lib/utils/logger";
import {
  getAccessToken,
  interactiveSignIn,
  getStoredGDriveUser,
  clearGDriveSession,
} from "./gdrive-oauth";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const KONODE_FOLDER = "Konode";

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

  private async ensureFolder(): Promise<string> {
    const h = await this.authHeaders();
    const folderId = this.config.gdrive?.folderId;
    if (folderId) return folderId;
    const q = encodeURIComponent(`name='${KONODE_FOLDER}' and mimeType='${FOLDER_MIME}' and trashed=false`);
    const res = await fetch(`${DRIVE_API}/files?q=${q}&fields=files(id,name)`, { headers: h });
    if (!res.ok) throw new HttpError(res.status, `Drive folder lookup failed: ${res.status}`);
    const data = await res.json();
    if (data.files?.length > 0) return data.files[0].id as string;
    const create = await fetch(`${DRIVE_API}/files`, {
      method: "POST", headers: h,
      body: JSON.stringify({ name: KONODE_FOLDER, mimeType: FOLDER_MIME }),
    });
    if (!create.ok) throw new HttpError(create.status, `Drive folder create failed: ${create.status}`);
    const created = await create.json();
    if (!created.id) throw new Error("Drive folder create returned no id");
    return created.id as string;
  }

  async upload(packet: SyncPacket): Promise<void> {
    await withRetry(async () => {
      const folderId = this.folderId ?? (await this.ensureFolder());
      const h = await this.authHeaders();
      const token = await this.getToken(false);
      const filename = `konode_${packet.data_type}_${packet.device_id}.json`;
      const content = JSON.stringify(packet, null, 2);
      const q = encodeURIComponent(`name='${filename}' and '${folderId}' in parents and trashed=false`);
      const lookup = await fetch(`${DRIVE_API}/files?q=${q}&fields=files(id)`, { headers: h });
      if (!lookup.ok) throw new HttpError(lookup.status, `Drive lookup failed: ${lookup.status}`);
      const existing = await lookup.json();
      if (existing.files?.length > 0) {
        const res = await fetch(`${UPLOAD_API}/files/${existing.files[0].id}?uploadType=media`, {
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
        if (!r.ok) continue;
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
    const res = await fetch(`${DRIVE_API}/files?q=${q}&fields=files(id)`, { headers: h });
    if (!res.ok) throw new HttpError(res.status, `Drive lookup failed: ${res.status}`);
    const data = await res.json();
    return data.files?.[0]?.id ?? null;
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

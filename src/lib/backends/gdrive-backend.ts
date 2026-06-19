import type { IBackend, BackendConfig, DataType, SyncPacket } from "@/lib/types";
import { withRetry, HttpError } from "@/lib/utils/retry";
import { logger } from "@/lib/utils/logger";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const SYNKRO_FOLDER = "Synkro";
const CLIENT_ID = "290320131573-2d68ltqjda1ucdfgi3k6pj3e2fb18lnq.apps.googleusercontent.com";
const STORAGE_KEY = "synkro_gdrive_session";

// ─── Session persistence ──────────────────────────────────────────────────

interface GDriveSession {
  token: string;
  email: string;
  displayName: string;
  savedAt: number;
}

async function saveSession(token: string, user: GDriveUserInfo): Promise<void> {
  await chrome.storage.local.set({
    [STORAGE_KEY]: { token, email: user.email, displayName: user.displayName, savedAt: Date.now() },
  });
}

async function loadSession(): Promise<GDriveSession | null> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const s = result[STORAGE_KEY] as GDriveSession | undefined;
  if (!s) return null;
  if (Date.now() - s.savedAt > 50 * 60 * 1000) return null;
  return s;
}

async function clearSession(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
}

function buildAuthUrl(prompt: "none" | "consent" = "consent"): string {
  const redirectUrl = chrome.identity.getRedirectURL("gdrive");
  return (
    `https://accounts.google.com/o/oauth2/auth` +
    `?client_id=${CLIENT_ID}` +
    `&response_type=token` +
    `&redirect_uri=${encodeURIComponent(redirectUrl)}` +
    `&scope=${encodeURIComponent("https://www.googleapis.com/auth/drive.file")}` +
    // prompt=none → silent renewal (no UI) when a Google session already exists.
    `&prompt=${prompt}`
  );
}

export interface GDriveUserInfo {
  email: string;
  displayName: string;
  photoUrl?: string;
}

export class GDriveBackend implements IBackend {
  readonly type = "gdrive" as const;
  private folderId: string | null = null;
  private cachedToken: string | null = null;

  constructor(private config: BackendConfig) {}

  isConfigured(): boolean { return true; }
  isConnected(): boolean { return !!this.cachedToken; }

  /** Runs the OAuth flow; resolves to a token, or null if it needs (denied) UI. */
  private tryAuth(interactive: boolean, prompt: "none" | "consent"): Promise<string | null> {
    const mode = `${prompt}/${interactive ? "interactive" : "silent"}`;
    return new Promise((resolve) => {
      chrome.identity.launchWebAuthFlow(
        { url: buildAuthUrl(prompt), interactive },
        (responseUrl) => {
          if (chrome.runtime.lastError || !responseUrl) {
            logger.warn("GDrive.auth", `${mode} → ${chrome.runtime.lastError?.message ?? "no response URL"}`);
            resolve(null);
            return;
          }
          const params = new URLSearchParams(new URL(responseUrl).hash.slice(1));
          const token = params.get("access_token");
          if (!token) {
            logger.warn("GDrive.auth", `${mode} → no token (error=${params.get("error") ?? "?"})`);
            resolve(null);
            return;
          }
          this.cachedToken = token;
          resolve(token);
        }
      );
    });
  }

  async getToken(interactive = false): Promise<string> {
    if (this.cachedToken) return this.cachedToken;
    const session = await loadSession();
    if (session) { this.cachedToken = session.token; return session.token; }

    // The 50-min session lapsed. Try a SILENT renewal first (no UI) — this is
    // what keeps background sync alive past the ~1h token lifetime without the
    // user re-consenting, on any Chromium browser (Brave/Helium included).
    let token = await this.tryAuth(false, "none");
    if (!token) {
      if (!interactive) throw new Error("Google session expired — open Synkro and sign in again.");
      token = await this.tryAuth(true, "consent");
      if (!token) throw new Error("Google sign-in was cancelled");
    }

    // Persist so the next ~50 min are covered (user info is best-effort).
    try {
      await saveSession(token, await this.fetchUserInfo(token));
    } catch { /* token is still usable even if the user-info call fails */ }
    return token;
  }

  async signIn(): Promise<GDriveUserInfo> {
    this.cachedToken = null;
    await clearSession();
    const token = await this.tryAuth(true, "consent");
    if (!token) throw new Error("Google sign-in was cancelled");
    const info = await this.fetchUserInfo(token);
    await saveSession(token, info);
    logger.info("GDrive.signIn", `Signed in as ${info.email}`);
    return info;
  }

  async signOut(): Promise<void> {
    this.cachedToken = null;
    this.folderId = null;
    await clearSession();
    chrome.identity.getAuthToken({ interactive: false }, (t) => {
      if (t) chrome.identity.removeCachedAuthToken({ token: t }, () => {});
    });
    logger.info("GDrive.signOut", "Signed out");
  }

  async getSignedInUser(): Promise<GDriveUserInfo | null> {
    try {
      const session = await loadSession();
      if (session) { this.cachedToken = session.token; return { email: session.email, displayName: session.displayName }; }
      if (this.cachedToken) return await this.fetchUserInfo(this.cachedToken);
      return null;
    } catch { return null; }
  }

  private async fetchUserInfo(token: string): Promise<GDriveUserInfo> {
    const res = await fetch("https://www.googleapis.com/drive/v3/about?fields=user", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Failed to fetch user info: ${res.status}`);
    const data = await res.json();
    return {
      email: data.user?.emailAddress ?? "",
      displayName: data.user?.displayName ?? "",
      photoUrl: data.user?.photoLink,
    };
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
    const q = encodeURIComponent(`name='${SYNKRO_FOLDER}' and mimeType='${FOLDER_MIME}' and trashed=false`);
    const res = await fetch(`${DRIVE_API}/files?q=${q}&fields=files(id,name)`, { headers: h });
    if (!res.ok) throw new HttpError(res.status, `Drive folder lookup failed: ${res.status}`);
    const data = await res.json();
    if (data.files?.length > 0) return data.files[0].id as string;
    const create = await fetch(`${DRIVE_API}/files`, {
      method: "POST", headers: h,
      body: JSON.stringify({ name: SYNKRO_FOLDER, mimeType: FOLDER_MIME }),
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
      const filename = `synkro_${packet.data_type}_${packet.device_id}.json`;
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
        const boundary = `synkro_${packet.checksum}_${packet.device_id.slice(0, 8)}`;
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

  async download(data_type: DataType, excludeDeviceId?: string): Promise<SyncPacket | null> {
    return withRetry(async () => {
      const folderId = this.folderId ?? (await this.ensureFolder());
      const h = await this.authHeaders();
      const q = encodeURIComponent(`name contains 'synkro_${data_type}_' and '${folderId}' in parents and trashed=false`);
      const listRes = await fetch(`${DRIVE_API}/files?q=${q}&fields=files(id,name,modifiedTime)&orderBy=modifiedTime desc`, { headers: h });
      if (!listRes.ok) throw new HttpError(listRes.status, `Drive list failed: ${listRes.status}`);
      const { files } = await listRes.json();
      if (!files?.length) return null;
      // Skip this device's own file so we always compare against a peer's data.
      const own = excludeDeviceId ? `synkro_${data_type}_${excludeDeviceId}.json` : null;
      const pick = (files as Array<{ id: string; name: string }>).find((f) => f.name !== own);
      if (!pick) return null;
      const fileRes = await fetch(`${DRIVE_API}/files/${pick.id}?alt=media`, { headers: h });
      if (!fileRes.ok) throw new HttpError(fileRes.status, `Drive download failed: ${fileRes.status}`);
      return fileRes.json() as Promise<SyncPacket>;
    });
  }

  async listVersions(_data_type: DataType): Promise<string[]> { return []; }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      const user = await this.getSignedInUser();
      if (!user) return { ok: false, message: "Not signed in" };
      return { ok: true, message: `Connected as ${user.displayName} (${user.email})` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "Connection failed" };
    }
  }
}

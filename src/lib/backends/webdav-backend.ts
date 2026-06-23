import type { IBackend, BackendConfig, DataType, SyncPacket } from "@/lib/types";
import { withRetry, HttpError } from "@/lib/utils/retry";
import { logger } from "@/lib/utils/logger";

export class WebDAVBackend implements IBackend {
  readonly type = "webdav" as const;

  constructor(private config: BackendConfig) {}

  isConfigured(): boolean {
    const w = this.config.webdav;
    return !!(w?.url && w?.username && w?.password);
  }

  private get w() {
    if (!this.config.webdav?.url) throw new Error("WebDAV not configured");
    return this.config.webdav;
  }

  private get baseUrl(): string {
    return this.w.url.replace(/\/$/, "") + "/" + (this.w.path ?? "synkro").replace(/^\//, "");
  }

  private headers(): HeadersInit {
    const creds = btoa(`${this.w.username}:${this.w.password}`);
    return {
      Authorization: `Basic ${creds}`,
      "Content-Type": "application/json",
    };
  }

  async connect(): Promise<void> {
    await this.ensureFolder();
    logger.info("WebDAV connected", this.baseUrl);
  }

  async disconnect(): Promise<void> {}

  private async ensureFolder(): Promise<void> {
    // MKCOL creates the folder if it doesn't exist
    // 405 = already exists, which is fine
    const res = await fetch(this.baseUrl, {
      method: "MKCOL",
      headers: this.headers(),
    });
    if (!res.ok && res.status !== 405 && res.status !== 301) {
      logger.warn("WebDAV.ensureFolder", `MKCOL returned ${res.status}`);
    }
  }

  async upload(packet: SyncPacket): Promise<void> {
    await withRetry(async () => {
      const filename = `${this.baseUrl}/synkro_${packet.data_type}_${packet.device_id}.json`;
      const res = await fetch(filename, {
        method: "PUT",
        headers: this.headers(),
        body: JSON.stringify(packet, null, 2),
      });
      if (!res.ok) throw new HttpError(res.status, `WebDAV PUT failed: ${res.status}`);
      logger.info("WebDAV.upload", `${packet.data_type} → ${filename}`);
    });
  }

  async downloadAll(data_type: DataType, excludeDeviceId?: string): Promise<SyncPacket[]> {
    return withRetry(async () => {
      // PROPFIND to list files in folder
      const res = await fetch(this.baseUrl + "/", {
        method: "PROPFIND",
        headers: { ...this.headers(), Depth: "1" },
        body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>`,
        cache: "no-store",
      });

      if (!res.ok) return [];

      const xml = await res.text();
      // Extract hrefs from PROPFIND response. Match any namespace prefix
      // (d:href, D:href, lp1:href, or bare href) — servers differ.
      const own = excludeDeviceId ? `synkro_${data_type}_${excludeDeviceId}.json` : null;
      const hrefs = [...xml.matchAll(/<(?:[a-z0-9]+:)?href>([^<]+)<\/(?:[a-z0-9]+:)?href>/gi)]
        .map(m => m[1])
        .filter(h => h.includes(`synkro_${data_type}_`) && h.endsWith(".json") && (!own || !h.endsWith(own)));

      const packets: SyncPacket[] = [];
      for (const href of hrefs) {
        const fullUrl = href.startsWith("http") ? href : new URL(href, this.w.url).href;
        const r = await fetch(fullUrl, {
          headers: { Authorization: `Basic ${btoa(`${this.w.username}:${this.w.password}`)}` },
          cache: "no-store", // avoid a stale peer file from the browser HTTP cache
        });
        if (!r.ok) continue;
        try {
          packets.push(JSON.parse(await r.text()) as SyncPacket);
        } catch {
          // A corrupt/partial file (e.g. trailing junk from a non-truncating write)
          // must not abort the whole sync — skip it; the owner rewrites it next sync.
          logger.warn("WebDAV.downloadAll", `Skipping unreadable sync file: ${href}`);
        }
      }
      return packets;
    });
  }

  async listVersions(_: DataType): Promise<string[]> { return []; }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      const res = await fetch(this.w.url, {
        method: "PROPFIND",
        headers: { ...this.headers(), Depth: "0" },
        body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>`,
      });
      if (res.ok || res.status === 207) {
        return { ok: true, message: `Connected to ${new URL(this.w.url).hostname}` };
      }
      if (res.status === 401) return { ok: false, message: "Authentication failed — check username/password" };
      return { ok: false, message: `Server returned HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "Connection failed" };
    }
  }
}

import { peerDeviceId } from "@/lib/types";
import type { IBackend, BackendConfig, DataType, ListedFile, PeerFile, PeerPull, SyncPacket } from "@/lib/types";
import { withRetry, HttpError, rateLimitMessage, timedFetch } from "@/lib/utils/retry";
import { logger } from "@/lib/utils/logger";
import { isSecureBackendUrl } from "@/lib/utils/url";
import { utf8ToBase64 } from "@/lib/utils/base64";

const INSECURE_URL_MSG =
  "WebDAV over plain http:// is not allowed. Your username and password would be sent unencrypted on every request. Use an https:// URL (http is permitted only for localhost).";

/**
 * Every WebDAV request goes through here, so none of them carries the browser's cookies.
 *
 * Konode authenticates with the Basic header alone, and a cookie can only get in its way.
 * When the user is also signed in to Nextcloud's web interface in the same browser, a
 * request that carries the session cookie is treated as a browser session, and Nextcloud
 * then wants the CSRF token that only its own pages hold. It refuses with a 401, and the
 * 401 still offers Basic, so the user is told to check a password that is correct (#90:
 * the same account worked in one browser and failed in another).
 *
 * One function on purpose, like authHeader: eleven call sites setting the option by hand
 * is how one of them would have been missed.
 */
function davFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return timedFetch(url, { ...init, credentials: "omit" });
}

/** The last path segment of a PROPFIND href, decoded when it can be. */
function hrefBasename(href: string): string {
  try { return decodeURIComponent(href).split("/").pop() ?? ""; }
  catch { return href.split("/").pop() ?? ""; }
}

/**
 * The files in a PROPFIND multistatus, each with its `getlastmodified` where the server sent
 * one. Servers disagree on the namespace prefix (`d:`, `D:`, `lp1:` on Apache, none at all),
 * so every element is matched with any prefix. The collection itself comes back as an href
 * ending in `/`, whose basename is empty, and callers filter it out by prefix.
 */
export function parsePropfindListing(xml: string): ListedFile[] {
  const out: ListedFile[] = [];
  for (const block of xml.matchAll(/<(?:[a-z0-9]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9]+:)?response>/gi)) {
    const href = /<(?:[a-z0-9]+:)?href>([^<]+)<\/(?:[a-z0-9]+:)?href>/i.exec(block[1]);
    if (!href) continue;
    const stamp = /<(?:[a-z0-9]+:)?getlastmodified[^>]*>([^<]+)<\/(?:[a-z0-9]+:)?getlastmodified>/i.exec(block[1]);
    const t = stamp ? Date.parse(stamp[1].trim()) : NaN;
    out.push({ name: hrefBasename(href[1].trim()), modified: Number.isNaN(t) ? null : t });
  }
  return out;
}

/**
 * The ETag a PROPFIND response block carries, as a change marker, or null.
 *
 * A weak ETag (`W/"…"`) counts as none: it promises only that two versions are equivalent
 * by the server's own judgement, not that the bytes match, and Apache hands out a weak one
 * for exactly the case that matters here, a file written within the last second. Kept
 * verbatim otherwise (quotes, entity-escaped or not) since it is only ever compared with
 * what the same server said before.
 */
function etagOf(block: string): string | null {
  const m = /<(?:[a-z0-9]+:)?getetag[^>]*>([^<]*)<\/(?:[a-z0-9]+:)?getetag>/i.exec(block);
  const etag = m?.[1].trim() ?? "";
  if (!etag || /^W\//i.test(etag)) return null;
  return etag;
}

/**
 * The files in a PROPFIND multistatus with each one's href and ETag (#96). Namespace
 * prefixes are matched loosely, as in parsePropfindListing.
 */
export function parsePropfindEtags(xml: string): Array<{ name: string; href: string; etag: string | null }> {
  const out: Array<{ name: string; href: string; etag: string | null }> = [];
  for (const block of xml.matchAll(/<(?:[a-z0-9]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9]+:)?response>/gi)) {
    const href = /<(?:[a-z0-9]+:)?href>([^<]+)<\/(?:[a-z0-9]+:)?href>/i.exec(block[1]);
    if (!href) continue;
    const h = href[1].trim();
    out.push({ name: hrefBasename(h), href: h, etag: etagOf(block[1]) });
  }
  return out;
}

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
    return this.w.url.replace(/\/$/, "") + "/" + (this.w.path ?? "konode").replace(/^\//, "");
  }

  /**
   * The Basic-auth header value. Credentials are UTF-8 encoded before base64: raw
   * `btoa` throws on any code point above U+00FF (`ő`, `ű`, `ł`, `€`, Cyrillic, emoji)
   * — and that DOMException is neither an HttpError nor a network TypeError, so
   * `defaultShouldRetry` won't retry it and every sync failed hard and permanently. For
   * U+0080–U+00FF (`á`, `ö`, `ü`) it didn't throw but emitted ISO-8859-1 bytes, while
   * Nextcloud/ownCloud/SabreDAV and Apache decode UTF-8 — so a CORRECT password was
   * rejected forever with "Authentication failed. Check username/password".
   * RFC 7617 recommends UTF-8 and every mainstream DAV server expects it.
   *
   * Single accessor on purpose: this used to be inlined twice (here and in
   * downloadAll), which is how the two copies could drift.
   */
  private authHeader(): string {
    return `Basic ${utf8ToBase64(`${this.w.username}:${this.w.password}`)}`;
  }

  private headers(): HeadersInit {
    return {
      Authorization: this.authHeader(),
      "Content-Type": "application/json",
    };
  }

  /**
   * What to say about a 401. "Check username/password" is the obvious reading and it is
   * wrong on a whole class of server: a 401 means "not authenticated", and
   * `WWW-Authenticate` says WHICH scheme the server is willing to accept. A server that
   * offers `Bearer` and not `Basic` will refuse a perfectly correct username and password
   * forever, so sending that user to re-check their credentials sends them to look at the
   * one thing that isn't broken.
   *
   * The case that prompted this, from a field report: ownCloud Infinite Scale ships with
   * `PROXY_ENABLE_BASIC_AUTH=false` and authenticates over OIDC, so every attempt got
   * "Authentication failed. Check username/password" and the reporter spent their time on
   * the password. The fix on their side is an app token (`PROXY_ENABLE_APP_AUTH`), which
   * travels in this same Basic header, so it is worth naming.
   *
   * Absent or unparseable header means we know nothing extra, so say the ordinary thing.
   * Reading response headers is fine here: the request runs under a host permission, so
   * it is not CORS-restricted and nothing is hidden from us.
   */
  private authFailureMessage(res: Response): string {
    const credentials = "Authentication failed. Check username/password";
    let challenge = "";
    try {
      challenge = res.headers?.get("WWW-Authenticate") ?? "";
    } catch {
      return credentials; // a stubbed or exotic Response without headers
    }
    if (!challenge.trim()) return credentials;

    // Scheme tokens only: a challenge is `Scheme param=..., param=...` and may list
    // several, so the parameters (which can contain the word "basic" inside a realm)
    // must not be mistaken for one. A scheme sits at the start or after a comma and is
    // followed by whitespace or the end.
    const schemes = [...challenge.matchAll(/(?:^|,)\s*([A-Za-z][\w!#$%&'*+.^`|~-]*)(?=\s|$)/g)]
      .map((m) => m[1]);
    if (!schemes.length || schemes.some((s) => s.toLowerCase() === "basic")) return credentials;

    return `This server won't take a username and password over WebDAV: it refused the login and asked for ${schemes.join(" or ")} instead. Some servers want an app token in the password field, and ownCloud Infinite Scale has HTTP Basic switched off by default (its admin can turn on app tokens with PROXY_ENABLE_APP_AUTH). Your password is probably fine.`;
  }

  async connect(): Promise<void> {
    // Refuse to send Basic-auth credentials over plaintext http:// (loopback aside).
    if (!isSecureBackendUrl(this.w.url)) throw new Error(INSECURE_URL_MSG);
    await this.ensureFolder();
    // Log the host only (not the full URL/path) — the audit log is device-local
    // but shouldn't persist more backend detail than needed (PR-L2).
    logger.info("WebDAV connected", new URL(this.w.url).hostname);
  }

  async disconnect(): Promise<void> {}

  private async ensureFolder(): Promise<void> {
    // MKCOL creates the folder if it doesn't exist
    // 405 = already exists, which is fine
    const res = await davFetch(this.baseUrl, {
      method: "MKCOL",
      headers: this.headers(),
    });

    // The configured URL is not the canonical one. fetch followed the redirect for us, so
    // this still worked — but it costs an extra round trip on every request, and plenty of
    // servers and reverse proxies DROP the Authorization header when redirecting, which
    // shows up later as a baffling 401 on a password that is perfectly correct. Say so
    // now, while the user is looking at the connection settings.
    if (res.redirected) {
      logger.warn(
        "WebDAV.ensureFolder",
        `The server redirects ${new URL(this.w.url).hostname} to a different address. Sync should still work, but use the final URL your server shows — some servers drop the login across a redirect and then reject a correct password.`
      );
    }

    // A 401 is answered here rather than below, because the folder question is moot: the
    // server refused the login at the door, so the PROPFIND check would 401 too and the
    // user would be told to look at the path and their write permissions for what is an
    // authentication problem. This is the message a FIRST-RUN user gets, since onboarding
    // saves and syncs instead of running Test connection, so it is the one that has to be
    // right.
    if (res.status === 401) throw new HttpError(401, this.authFailureMessage(res));

    // 405 means the collection is already there. A bare 301 used to be waved through as
    // well, which was wrong twice over: fetch follows redirects by default, so a 301 only
    // ever reaches this line when it could NOT be followed (no usable Location), and that
    // is a failure, not a success.
    if (res.ok || res.status === 405) return;

    // Anything else: this used to be a warning and nothing more, so connect() went on to
    // log "WebDAV connected" and Test connection reported success even when the folder had
    // not been created — every upload then failed against a folder that wasn't there.
    // Don't guess from the status code, though: WebDAV servers answer MKCOL with a wide
    // spread of codes, and a 403 can mean "you may not create it" on a collection that
    // already exists. Ask.
    const check = await davFetch(this.baseUrl + "/", {
      method: "PROPFIND",
      headers: { ...this.headers(), Depth: "0" },
      cache: "no-store",
    });
    if (check.ok) {
      logger.info("WebDAV.ensureFolder", `MKCOL returned ${res.status}, but the folder is there`);
      return;
    }
    throw new HttpError(
      res.status,
      `Couldn't create the sync folder on the WebDAV server (MKCOL ${res.status}, and it isn't there: ${check.status}). Check the path and that the account may write to it.`
    );
  }

  async upload(packet: SyncPacket): Promise<void> {
    await withRetry(async () => {
      const name = `konode_${packet.data_type}_${packet.device_id}.json`;
      const res = await davFetch(`${this.baseUrl}/${name}`, {
        method: "PUT",
        headers: this.headers(),
        body: JSON.stringify(packet, null, 2),
      });
      if (!res.ok) throw new HttpError(res.status, `WebDAV PUT failed: ${res.status}`);
      // Log the FILE NAME, never the URL. `baseUrl` carries the account username on
      // Nextcloud/ownCloud (…/remote.php/dav/files/<user>/…) and the audit log is
      // persisted to disk — connect() already logs the hostname only for exactly this
      // reason (PR-L2). The name is what's actually useful when troubleshooting.
      logger.info("WebDAV.upload", `${packet.data_type} → ${name}`);
    });
  }

  async downloadAll(data_type: DataType, excludeDeviceId?: string): Promise<SyncPacket[]> {
    return (await this.downloadChanged(data_type, excludeDeviceId ?? "", {})).fetched.map((f) => f.packet);
  }

  /**
   * Every peer file, minus the ones whose ETag still equals the one in `known` (#96).
   *
   * The ETag is asked for in the same PROPFIND that lists the folder, so the check costs no
   * extra request. It is never exact (see PeerFile): the engine decides when to trust one.
   * A server that sends no ETag, or a weak one, has every file downloaded as before.
   */
  async downloadChanged(data_type: DataType, excludeDeviceId: string, known: Record<string, string>): Promise<PeerPull> {
    return withRetry(async () => {
      // PROPFIND to list files in folder
      const res = await davFetch(this.baseUrl + "/", {
        method: "PROPFIND",
        headers: { ...this.headers(), Depth: "1" },
        body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:getetag/></d:prop></d:propfind>`,
        cache: "no-store",
      });

      // 404 = the sync folder doesn't exist yet (no peers). A successful PROPFIND is
      // 207 Multi-Status (res.ok covers it). Any other non-OK is transient/real —
      // throw so withRetry retries and a persistent failure surfaces, instead of
      // silently masquerading as "no peers" (which would hide the peers' data).
      if (res.status === 404) return { fetched: [], unchanged: [] };
      if (!res.ok) throw new HttpError(res.status, `WebDAV list failed: ${res.status}`);

      // Compare the DECODED basename exactly — hrefs can be percent-encoded and an
      // `endsWith(own)` substring check could both miss our own file and wrongly
      // exclude a peer whose name ends with the same suffix.
      const listed = parsePropfindEtags(await res.text())
        .map((f) => ({ ...f, device_id: peerDeviceId(f.name, data_type) }))
        .filter((f): f is typeof f & { device_id: string } => !!f.device_id && f.device_id !== excludeDeviceId);

      const fetched: PeerPull["fetched"] = [];
      const unchanged: PeerFile[] = [];
      for (const f of listed) {
        const file: PeerFile = { device_id: f.device_id, marker: f.etag, exact: false };
        if (file.marker && known[f.device_id] === file.marker) {
          unchanged.push(file);
          continue;
        }
        const fullUrl = f.href.startsWith("http") ? f.href : new URL(f.href, this.w.url).href;
        const r = await davFetch(fullUrl, {
          headers: { Authorization: this.authHeader() },
          cache: "no-store", // avoid a stale peer file from the browser HTTP cache
        });
        if (!r.ok) {
          // NOT silent. A peer whose file we can't fetch drops out of this sync entirely —
          // its bookmarks aren't merged, its extensions aren't listed — and with no log
          // line the sync just reported success with fewer devices than the folder holds.
          // A field report showed exactly that: three extensions files on the server, one
          // peer folded in, nothing anywhere saying why. Degraded, not fatal: we keep the
          // other peers, because one unreadable file must not stop syncing altogether.
          logger.warn(
            "WebDAV.downloadAll",
            `Couldn't download ${f.name} (HTTP ${r.status}) — that device is left out of this sync`
          );
          continue;
        }
        try {
          fetched.push({ packet: JSON.parse(await r.text()) as SyncPacket, file });
        } catch {
          // A corrupt/partial file (e.g. trailing junk from a non-truncating write)
          // must not abort the whole sync — skip it; the owner rewrites it next sync.
          // Name only: an href is a full DAV path, which on Nextcloud/ownCloud embeds
          // the account username (see the note in upload()).
          logger.warn("WebDAV.downloadAll", `Skipping unreadable sync file: ${f.name}`);
        }
      }
      return { fetched, unchanged };
    });
  }

  async putFile(name: string, content: string): Promise<void> {
    await withRetry(async () => {
      const res = await davFetch(`${this.baseUrl}/${name}`, { method: "PUT", headers: this.headers(), body: content });
      if (!res.ok) throw new HttpError(res.status, `WebDAV PUT failed: ${res.status}`);
    });
  }

  async getFile(name: string): Promise<string | null> {
    return withRetry(async () => {
      const res = await davFetch(`${this.baseUrl}/${name}`, { headers: this.headers(), cache: "no-store" });
      if (res.status === 404) return null;
      if (!res.ok) throw new HttpError(res.status, `WebDAV GET failed: ${res.status}`);
      return res.text();
    });
  }

  async listFiles(prefix: string): Promise<string[]> {
    return withRetry(async () => {
      const res = await davFetch(this.baseUrl + "/", {
        method: "PROPFIND",
        headers: { ...this.headers(), Depth: "1" },
        body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>`,
        cache: "no-store",
      });
      if (res.status === 404) return [];
      if (!res.ok) throw new HttpError(res.status, `WebDAV list failed: ${res.status}`);
      const xml = await res.text();
      return [...xml.matchAll(/<(?:[a-z0-9]+:)?href>([^<]+)<\/(?:[a-z0-9]+:)?href>/gi)]
        .map(m => hrefBasename(m[1]))
        .filter(name => name.startsWith(prefix));
    });
  }

  async listFilesWithTimes(prefix: string): Promise<ListedFile[]> {
    return withRetry(async () => {
      const res = await davFetch(this.baseUrl + "/", {
        method: "PROPFIND",
        headers: { ...this.headers(), Depth: "1" },
        body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:getlastmodified/></d:prop></d:propfind>`,
        cache: "no-store",
      });
      if (res.status === 404) return [];
      if (!res.ok) throw new HttpError(res.status, `WebDAV list failed: ${res.status}`);
      return parsePropfindListing(await res.text()).filter(f => f.name.startsWith(prefix));
    });
  }

  async deleteFile(name: string): Promise<void> {
    await withRetry(async () => {
      const res = await davFetch(`${this.baseUrl}/${name}`, { method: "DELETE", headers: this.headers() });
      if (!res.ok && res.status !== 404) throw new HttpError(res.status, `WebDAV DELETE failed: ${res.status}`);
    });
  }


  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      if (!isSecureBackendUrl(this.w.url)) return { ok: false, message: INSECURE_URL_MSG };
      const res = await davFetch(this.w.url, {
        method: "PROPFIND",
        headers: { ...this.headers(), Depth: "0" },
        body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>`,
      });
      if (res.ok || res.status === 207) {
        return { ok: true, message: `Connected to ${new URL(this.w.url).hostname}` };
      }
      if (res.status === 401) return { ok: false, message: this.authFailureMessage(res) };
      if (res.status === 429) return { ok: false, message: rateLimitMessage(new URL(this.w.url).host) };
      return { ok: false, message: `Server returned HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "Connection failed" };
    }
  }
}

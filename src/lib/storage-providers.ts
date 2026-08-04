// Shared storage-provider (card) model for the storage picker — consumed by BOTH
// the options page and the onboarding wizard so the two never drift. A "provider"
// is a card in the picker; several providers map to the same underlying WebDAV
// backend (the sync engine only knows gdrive/webdav/github). Selecting a card sets
// `active_backend` and, for WebDAV presets, the server URL — nothing about the sync
// format changes, so switching a card is not a breaking change.

import type { BackendType } from "@/lib/types";

export type ProviderId =
  | "gdrive" | "koofr" | "pcloud" | "nextcloud" | "fastmail" | "webdav" | "github";

export interface ProviderDef {
  id: ProviderId;
  backend: BackendType;
  label: string;
  /** Message key, not text — resolve with `t()` at the render site. */
  descKey: string;
  fixedUrl?: string;                                        // koofr, fastmail
  regions?: { id: string; label: string; url: string }[];  // pcloud (EU/US)
  needsHost?: boolean;                                      // nextcloud/ownCloud
  custom?: boolean;                                         // generic WebDAV (Synology, kDrive, …)
  /** Message key, not text. Extra hint shown once the card is selected. */
  noteKey?: string;
}

// Endpoints verified against each provider's own docs (2026-07): Koofr, pCloud EU/US,
// Fastmail (myfiles.* roots straight into the user's files — no domain path). Box was
// dropped (discontinued WebDAV in 2023). Nextcloud/ownCloud/Synology need a per-user
// host, so they take a host field (Nextcloud) or a full custom URL (WebDAV) instead.
// Card order (2026-07): Google Drive leads (most familiar entry point), then the
// privacy-friendly own-storage options, GitHub, and the generic WebDAV catch-all last.
export const PROVIDERS: ProviderDef[] = [
  {
    id: "gdrive", backend: "gdrive", label: "Google Drive",
    descKey: "provider_gdrive_desc",
  },
  {
    id: "nextcloud", backend: "webdav", label: "Nextcloud / ownCloud", needsHost: true,
    descKey: "provider_nextcloud_desc",
    noteKey: "provider_nextcloud_note",
  },
  {
    id: "pcloud", backend: "webdav", label: "pCloud",
    descKey: "provider_pcloud_desc",
    regions: [
      { id: "eu", label: "EU", url: "https://ewebdav.pcloud.com" },
      { id: "us", label: "US", url: "https://webdav.pcloud.com" },
    ],
    noteKey: "provider_pcloud_note",
  },
  {
    id: "koofr", backend: "webdav", label: "Koofr", fixedUrl: "https://app.koofr.net/dav/Koofr",
    descKey: "provider_koofr_desc",
    noteKey: "provider_koofr_note",
  },
  {
    id: "fastmail", backend: "webdav", label: "Fastmail", fixedUrl: "https://myfiles.fastmail.com",
    descKey: "provider_fastmail_desc",
    noteKey: "provider_fastmail_note",
  },
  {
    // GitHub ONLY. The backend hardcodes api.github.com and BackendConfig.github has
    // no base-URL field, so this card must not name a host it can't reach: a user who
    // believed the old "GitHub / Gitea / GitLab" label pasted a self-hosted instance's
    // token and sent it straight to GitHub, then got a misleading "invalid token".
    // Gitea would need an API base URL (its contents API is GitHub-shaped); GitLab's
    // API differs entirely and needs its own backend. Until either ships, don't
    // advertise them.
    id: "github", backend: "github", label: "GitHub",
    descKey: "provider_github_desc",
  },
  {
    id: "webdav", backend: "webdav", label: "WebDAV (other)", custom: true,
    descKey: "provider_webdav_desc",
  },
];

export function providerById(id: ProviderId): ProviderDef {
  const p = PROVIDERS.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown provider id: ${id}`);
  return p;
}

/** Trailing-slash- and case-insensitive URL compare. */
export const sameUrl = (a: string, b: string): boolean =>
  (a ?? "").replace(/\/+$/, "").toLowerCase() === (b ?? "").replace(/\/+$/, "").toLowerCase();

/** Build a Nextcloud/ownCloud files-DAV URL from a base (host + optional subpath) +
 *  username. The base may include a subdirectory install (e.g. `host/nextcloud`). */
export function nextcloudUrl(base: string, username: string): string {
  const b = base.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  if (!b) return "";
  return `https://${b}/remote.php/dav/files/${encodeURIComponent(username.trim())}/`;
}

/** Recover the base (host + optional subpath) from a stored Nextcloud URL, so the
 *  host field round-trips a subdirectory install instead of truncating at the first
 *  slash (e.g. `cloud.example.com/nextcloud`, not just `cloud.example.com`). */
export function nextcloudBaseFromUrl(url: string | undefined): string {
  return (url ?? "")
    .replace(/^https?:\/\//i, "")
    .replace(/\/remote\.php\/dav\/.*$/i, "")
    .replace(/\/+$/, "");
}

/** pCloud region id ("eu"/"us") for a stored URL, defaulting to EU. */
export function pcloudRegionOf(url: string | undefined): string {
  const r = providerById("pcloud").regions?.find((x) => sameUrl(x.url, url ?? ""));
  return r?.id ?? "eu";
}

/** Server URL a WebDAV card should show when the user switches onto it.
 *
 *  `keptUrl` is whatever that same card held last time it was open (empty on a
 *  first visit) — NOT the card being switched away from, whose URL belongs to a
 *  different account. Presets pin their own endpoint; the custom card keeps what
 *  the user typed; Nextcloud keeps a URL only if it still looks like a files-DAV
 *  path, so a leftover preset endpoint can't masquerade as a server host.
 *
 *  Shared by the options page and the onboarding wizard so the two can't drift. */
export function webdavUrlForCard(id: ProviderId, keptUrl: string): string {
  const p = providerById(id);
  if (p.fixedUrl) return p.fixedUrl;
  if (p.regions) return p.regions.some((r) => sameUrl(r.url, keptUrl)) ? keptUrl : p.regions[0].url;
  if (p.needsHost) return /\/remote\.php\/dav\//i.test(keptUrl) ? keptUrl : "";
  return keptUrl; // custom WebDAV — the user's own URL, restored as typed
}

/** Which provider card matches a saved config (for seeding the selected card). */
export function providerFromConfig(
  backend: BackendType | null | undefined,
  webdavUrl: string | undefined
): ProviderId | null {
  if (backend === "gdrive") return "gdrive";
  if (backend === "github") return "github";
  if (backend === "webdav") {
    const url = webdavUrl ?? "";
    if (!url) return "webdav";
    for (const p of PROVIDERS) {
      if (p.fixedUrl && sameUrl(p.fixedUrl, url)) return p.id;
      if (p.regions?.some((r) => sameUrl(r.url, url))) return p.id;
    }
    if (/\/remote\.php\/dav\//i.test(url)) return "nextcloud";
    return "webdav";
  }
  return null;
}

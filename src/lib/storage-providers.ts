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
  desc: string;
  fixedUrl?: string;                                        // koofr, fastmail
  regions?: { id: string; label: string; url: string }[];  // pcloud (EU/US)
  needsHost?: boolean;                                      // nextcloud/ownCloud
  custom?: boolean;                                         // generic WebDAV (Synology, kDrive, …)
  note?: string;
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
    desc: "Sync via your Google Drive. OAuth, with a short-lived access token cached on this device only.",
  },
  {
    id: "nextcloud", backend: "webdav", label: "Nextcloud / ownCloud", needsHost: true,
    desc: "Your own Nextcloud or ownCloud server.",
    note: "Enter just your server host; use an App Password (Settings → Security).",
  },
  {
    id: "pcloud", backend: "webdav", label: "pCloud",
    desc: "pCloud storage. Needs a paid pCloud plan.",
    regions: [
      { id: "eu", label: "EU", url: "https://ewebdav.pcloud.com" },
      { id: "us", label: "US", url: "https://webdav.pcloud.com" },
    ],
    note: "Pick the region your pCloud account lives in.",
  },
  {
    id: "koofr", backend: "webdav", label: "Koofr", fixedUrl: "https://app.koofr.net/dav/Koofr",
    desc: "Koofr cloud storage.",
    note: "Username is your Koofr email; use a Koofr app password.",
  },
  {
    id: "fastmail", backend: "webdav", label: "Fastmail", fixedUrl: "https://myfiles.fastmail.com",
    desc: "Fastmail file storage.",
    note: "Username is your full Fastmail address; use an app password with Files (WebDAV) access.",
  },
  {
    id: "github", backend: "github", label: "GitHub / Gitea / GitLab",
    desc: "Store sync data in a private repository using a Personal Access Token.",
  },
  {
    id: "webdav", backend: "webdav", label: "WebDAV (other)", custom: true,
    desc: "Synology, kDrive, or any other WebDAV server.",
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

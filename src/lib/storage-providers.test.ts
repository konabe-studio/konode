import { describe, it, expect } from "vitest";
import {
  PROVIDERS,
  webdavUrlForCard, providerFromConfig, providerById, nextcloudUrl, nextcloudBaseFromUrl,
  pcloudRegionOf, sameUrl,
} from "./storage-providers";
import { t } from "@/lib/utils/i18n";

/**
 * The English text a user actually reads for a message key.
 *
 * The card copy moved into the locale catalogues, so checking `p.descKey` would only
 * check a key name — and this test exists because the GitHub card once advertised Gitea
 * and GitLab, which is a claim in the TEXT. `t()` resolves through the same catalogue the
 * extension ships (test/setup.ts serves the real en/messages.json), and an unresolved key
 * comes back as itself, which would make every assertion below vacuously true.
 */
function en(key: string): string {
  const msg = t(key);
  expect(msg).not.toBe(key);
  return msg;
}

const KOOFR = "https://app.koofr.net/dav/Koofr";
const FASTMAIL = "https://myfiles.fastmail.com";
const PCLOUD_EU = "https://ewebdav.pcloud.com";
const PCLOUD_US = "https://webdav.pcloud.com";

describe("webdavUrlForCard", () => {
  it("pins a fixed-endpoint preset regardless of what the card held before", () => {
    expect(webdavUrlForCard("koofr", "")).toBe(KOOFR);
    expect(webdavUrlForCard("koofr", "https://stale.example.com")).toBe(KOOFR);
    expect(webdavUrlForCard("fastmail", "")).toBe(FASTMAIL);
  });

  it("keeps a region the card was already on, else defaults to EU", () => {
    expect(webdavUrlForCard("pcloud", PCLOUD_US)).toBe(PCLOUD_US);
    expect(webdavUrlForCard("pcloud", `${PCLOUD_US}/`)).toBe(`${PCLOUD_US}/`); // trailing slash still matches
    expect(webdavUrlForCard("pcloud", "")).toBe(PCLOUD_EU);
    expect(webdavUrlForCard("pcloud", KOOFR)).toBe(PCLOUD_EU); // another card's URL is not a region
  });

  it("keeps a files-DAV URL for Nextcloud but rejects a foreign endpoint", () => {
    const nc = nextcloudUrl("cloud.example.com", "ben");
    expect(webdavUrlForCard("nextcloud", nc)).toBe(nc);
    expect(webdavUrlForCard("nextcloud", KOOFR)).toBe("");
    expect(webdavUrlForCard("nextcloud", "")).toBe("");
  });

  it("restores the custom card's own URL as typed", () => {
    expect(webdavUrlForCard("webdav", "https://nas.example.com/dav/")).toBe("https://nas.example.com/dav/");
    expect(webdavUrlForCard("webdav", "")).toBe("");
  });

  // The bug this guards: every WebDAV card shares one config slot, so switching
  // cards used to blank the shared fields. Leaving a card and coming back must
  // return that card's own endpoint, never the one in between.
  it("round-trips a preset across a detour through another card", () => {
    const parked = webdavUrlForCard("koofr", "");
    const detour = webdavUrlForCard("fastmail", "");
    expect(detour).not.toBe(parked);
    expect(webdavUrlForCard("koofr", parked)).toBe(KOOFR);
  });
});

describe("providerFromConfig", () => {
  it("maps the non-WebDAV backends straight through", () => {
    expect(providerFromConfig("gdrive", undefined)).toBe("gdrive");
    expect(providerFromConfig("github", undefined)).toBe("github");
    expect(providerFromConfig(null, undefined)).toBeNull();
  });

  it("recognizes each WebDAV preset from its saved URL", () => {
    expect(providerFromConfig("webdav", KOOFR)).toBe("koofr");
    expect(providerFromConfig("webdav", `${KOOFR}/`)).toBe("koofr");
    expect(providerFromConfig("webdav", FASTMAIL)).toBe("fastmail");
    expect(providerFromConfig("webdav", PCLOUD_EU)).toBe("pcloud");
    expect(providerFromConfig("webdav", PCLOUD_US)).toBe("pcloud");
    expect(providerFromConfig("webdav", nextcloudUrl("cloud.example.com", "ben"))).toBe("nextcloud");
  });

  it("falls back to the generic card for an unknown or empty URL", () => {
    expect(providerFromConfig("webdav", "https://nas.example.com/dav/")).toBe("webdav");
    expect(providerFromConfig("webdav", "")).toBe("webdav");
    expect(providerFromConfig("webdav", undefined)).toBe("webdav");
  });

  // The "active" badge reads this off the SAVED config, so a saved Koofr setup has
  // to keep resolving to Koofr while another card is merely selected.
  it("is stable for a saved preset — the selection can't move it", () => {
    expect(providerFromConfig("webdav", KOOFR)).toBe("koofr");
    expect(providerFromConfig("webdav", KOOFR)).toBe("koofr");
  });
});

describe("nextcloud URL round-trip", () => {
  it("preserves a subdirectory install", () => {
    const url = nextcloudUrl("cloud.example.com/nextcloud", "ben");
    expect(nextcloudBaseFromUrl(url)).toBe("cloud.example.com/nextcloud");
  });

  it("strips the scheme and trailing slashes from the base", () => {
    expect(nextcloudUrl("https://cloud.example.com/", "ben"))
      .toBe("https://cloud.example.com/remote.php/dav/files/ben/");
  });

  it("encodes a username with an @ (email logins)", () => {
    expect(nextcloudUrl("cloud.example.com", "ben@example.com"))
      .toContain("files/ben%40example.com/");
  });

  it("returns empty for a blank base rather than a bare https:// URL", () => {
    expect(nextcloudUrl("", "ben")).toBe("");
    expect(nextcloudUrl("   ", "ben")).toBe("");
  });
});

describe("sameUrl / pcloudRegionOf", () => {
  it("compares case- and trailing-slash-insensitively", () => {
    expect(sameUrl("https://A.example.com/", "https://a.example.com")).toBe(true);
    expect(sameUrl("https://a.example.com", "https://b.example.com")).toBe(false);
  });

  it("reads the pCloud region back, defaulting to EU", () => {
    expect(pcloudRegionOf(PCLOUD_US)).toBe("us");
    expect(pcloudRegionOf(PCLOUD_EU)).toBe("eu");
    expect(pcloudRegionOf(undefined)).toBe("eu");
    expect(pcloudRegionOf(KOOFR)).toBe("eu");
  });
});

describe("providerById", () => {
  it("throws on an unknown id instead of returning undefined", () => {
    expect(() => providerById("nope" as never)).toThrow(/Unknown provider id/);
  });
});

describe("provider cards only name hosts the backend can actually reach", () => {
  // The GitHub card used to read "GitHub / Gitea / GitLab" while the backend hardcodes
  // api.github.com and BackendConfig.github has no base-URL field. A user who believed
  // the label pasted a self-hosted instance's token, which was then sent to GitHub, and
  // got back a misleading "Invalid token. Check it hasn't expired".
  it("does not advertise Gitea or GitLab on the GitHub card", () => {
    const github = providerById("github");
    expect(github.label).toBe("GitHub");
    expect(`${github.label} ${en(github.descKey)}`).not.toMatch(/gitea|gitlab/i);
  });

  it("names no Git host other than GitHub anywhere in the card copy", () => {
    for (const p of PROVIDERS) {
      expect(`${p.label} ${en(p.descKey)} ${p.noteKey ? en(p.noteKey) : ""}`)
        .not.toMatch(/gitea|gitlab|bitbucket|codeberg|forgejo/i);
    }
  });
});

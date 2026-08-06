import { describe, it, expect } from "vitest";
import {
  normalizeExtName, inferStore, isInstalledLocally, missingLocally, storeUrlFor, installOrSearchUrl,
} from "@/lib/utils/extensions-match";
import type { SyncExtension } from "@/lib/types";

function ext(p: Partial<SyncExtension>): SyncExtension {
  return { id: "x", name: "X", version: "1", enabled: true, storeUrl: "", type: "extension", ...p };
}

const CHROME_ID = "cjpalhdlnbpafiamejdnhcphjbkeiagm"; // 32 chars a–p (uBlock Origin on CWS)
const FF_ID = "uBlock0@raymondhill.net";

describe("inferStore", () => {
  it("uses the explicit store when present", () => {
    expect(inferStore(ext({ id: FF_ID, store: "chrome" }))).toBe("chrome");
  });
  it("infers chrome from a 32-char a–p id, firefox otherwise", () => {
    expect(inferStore(ext({ id: CHROME_ID }))).toBe("chrome");
    expect(inferStore(ext({ id: FF_ID }))).toBe("firefox");
    expect(inferStore(ext({ id: "{9e8f-uuid}" }))).toBe("firefox");
  });
});

describe("isInstalledLocally", () => {
  const remote = ext({ id: CHROME_ID, name: "uBlock Origin", homepageUrl: "https://github.com/gorhill/uBlock", store: "chrome" });

  it("matches a same-store peer by exact id", () => {
    expect(isInstalledLocally(remote, [{ id: CHROME_ID, name: "whatever" }], "chrome")).toBe(true);
  });
  it("matches a cross-store peer by normalized name (Chrome ext already on Firefox)", () => {
    // Firefox local copy: different id, same name.
    expect(isInstalledLocally(remote, [{ id: FF_ID, name: "uBlock Origin" }], "firefox")).toBe(true);
    expect(isInstalledLocally(remote, [{ id: FF_ID, name: "UBLOCK   origin" }], "firefox")).toBe(true); // normalized
  });
  it("matches cross-store by homepage host when names differ", () => {
    expect(isInstalledLocally(remote, [{ id: FF_ID, name: "uBlock", homepageUrl: "https://www.github.com/gorhill/uBlock/wiki" }], "firefox")).toBe(true);
  });
  it("reports missing when nothing matches", () => {
    expect(isInstalledLocally(remote, [{ id: "other@x", name: "Dark Reader" }], "firefox")).toBe(false);
  });
  it("does NOT id-match across stores (ids never cross)", () => {
    // Same id string but the local store differs — id match is gated on same store.
    expect(isInstalledLocally(ext({ id: FF_ID, name: "A", store: "firefox" }), [{ id: FF_ID, name: "B" }], "chrome")).toBe(false);
  });

  // A homepage host identifies a DEVELOPER, not an extension. Within one store the id is
  // exact, so the host rule can only ever produce a false "already installed" there.
  it("does NOT host-match within one store — a shared repo host is not an identity", () => {
    const local = [{ id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", name: "KeePassXC-Browser", homepageUrl: "https://github.com/keepassxreboot/keepassxc-browser" }];
    expect(isInstalledLocally(remote, local, "chrome")).toBe(false);
  });
  it("suppresses a whole github.com-homepaged set from ONE local extension — the field report", () => {
    // 20 extensions on the peer, one extension installed here. Before the cross-store gate
    // every peer entry sharing that host vanished from the missing list.
    const peer = [
      ext({ id: CHROME_ID, name: "uBlock Origin", homepageUrl: "https://github.com/gorhill/uBlock" }),
      ext({ id: "bjpalhdlnbpafiamejdnhcphjbkeiagm", name: "Dark Reader", homepageUrl: "https://github.com/darkreader/darkreader" }),
      ext({ id: "cjpalhdlnbpafiamejdnhcphjbkeiagn", name: "Stylus", homepageUrl: "https://github.com/openstyles/stylus" }),
      ext({ id: "djpalhdlnbpafiamejdnhcphjbkeiago", name: "Grammarly", homepageUrl: "https://www.grammarly.com" }),
    ];
    const local = [{ id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", name: "SponsorBlock", homepageUrl: "https://github.com/ajayyy/SponsorBlock" }];
    const missing = peer.filter((e) => !isInstalledLocally(e, local, "chrome"));
    expect(missing.map((e) => e.name)).toEqual(["uBlock Origin", "Dark Reader", "Stylus", "Grammarly"]);
  });
  it("still host-matches ACROSS stores, which is what the rule is for", () => {
    const local = [{ id: FF_ID, name: "uBlock", homepageUrl: "https://www.github.com/gorhill/uBlock/wiki" }];
    expect(isInstalledLocally(remote, local, "firefox")).toBe(true);
  });
});

describe("missingLocally", () => {
  // The old spelling was `e.type === "extension"`, an allow-list against a field that
  // carries the browser's own ExtensionType. Chrome never emits "app".
  it("keeps an app-typed entry, which the browser really does report", () => {
    const remote = [ext({ id: CHROME_ID, name: "Some Web App", type: "hosted_app" })];
    expect(missingLocally(remote, [], "chrome").map((e) => e.name)).toEqual(["Some Web App"]);
  });
  it("keeps an entry with no type at all rather than swallowing it", () => {
    const remote = [{ ...ext({ id: CHROME_ID, name: "Typeless" }), type: undefined as unknown as string }];
    expect(missingLocally(remote, [], "chrome")).toHaveLength(1);
  });
  it("still drops a theme", () => {
    const remote = [ext({ id: CHROME_ID, name: "Midnight", type: "theme" })];
    expect(missingLocally(remote, [], "chrome")).toEqual([]);
  });
  it("still drops what is installed here", () => {
    const remote = [ext({ id: CHROME_ID, name: "uBlock Origin" })];
    expect(missingLocally(remote, [{ id: CHROME_ID }], "chrome")).toEqual([]);
  });
});

describe("storeUrlFor / installOrSearchUrl", () => {
  it("builds a CWS detail link for a chrome extension", () => {
    expect(storeUrlFor({ id: CHROME_ID, name: "uBlock", store: "chrome" })).toContain(`/detail/${CHROME_ID}`);
  });
  it("builds an AMO name search for a firefox extension (no id→listing map)", () => {
    expect(storeUrlFor({ id: FF_ID, name: "uBlock Origin", store: "firefox" })).toContain("addons.mozilla.org");
    expect(storeUrlFor({ id: FF_ID, name: "uBlock Origin", store: "firefox" })).toContain("uBlock%20Origin");
  });
  it("same store → the direct storeUrl; cross store → a search in the CURRENT store", () => {
    const chromeExt = ext({ id: CHROME_ID, name: "uBlock Origin", store: "chrome", storeUrl: "https://chrome.google.com/webstore/detail/" + CHROME_ID });
    expect(installOrSearchUrl(chromeExt, "chrome")).toBe(chromeExt.storeUrl);
    // Viewing a Chrome peer's extension on Firefox → AMO search, never the dead CWS id.
    const onFirefox = installOrSearchUrl(chromeExt, "firefox");
    expect(onFirefox).toContain("addons.mozilla.org");
    expect(onFirefox).not.toContain(CHROME_ID);
  });
});

describe("normalizeExtName", () => {
  it("lowercases, trims, collapses whitespace", () => {
    expect(normalizeExtName("  uBlock   Origin ")).toBe("ublock origin");
    expect(normalizeExtName(undefined)).toBe("");
  });
});

describe("isInstalledLocally — a store-listing homepage is not a match", () => {
  // Reported from the field (1.0.2): two Helium machines, each with a password manager
  // the other lacked, and neither ever appeared under "missing on this device". Chrome
  // fills homepageUrl with the Web Store detail URL for any extension whose manifest has
  // no homepage_url — most of them — so that one host was shared by a large share of
  // extensions on both sides and the host rule matched almost anything against anything.
  const CWS = (id: string) => `https://chrome.google.com/webstore/detail/${id}`;

  const icloud = ext({
    id: "pejdijmoenmkgeppbflobdenhhabjlaj",
    name: "iCloud Passwords",
    homepageUrl: CWS("pejdijmoenmkgeppbflobdenhhabjlaj"), // Chrome's synthesized default
    store: "chrome",
  });
  // What the OTHER machine has installed — different extensions, same synthesized host.
  const localsWithStoreHomepages: Array<{ id: string; name?: string; homepageUrl?: string }> = [
    { id: "oboonakemofpalcgghocfoadofidjkkk", name: "KeePassXC-Browser", homepageUrl: CWS("oboonakemofpalcgghocfoadofidjkkk") },
    { id: "cjpalhdlnbpafiamejdnhcphjbkeiagm", name: "uBlock Origin", homepageUrl: CWS("cjpalhdlnbpafiamejdnhcphjbkeiagm") },
  ];

  it("reports a genuinely absent extension as missing", () => {
    // This returned TRUE — chrome.google.com === chrome.google.com — so the list was empty.
    expect(isInstalledLocally(icloud, localsWithStoreHomepages, "chrome")).toBe(false);
  });

  it("is not fooled by any store's listing host", () => {
    for (const host of [
      "https://chrome.google.com/webstore/detail/abc",
      "https://chromewebstore.google.com/detail/x/abc",
      "https://addons.mozilla.org/firefox/addon/abc/",
      "https://microsoftedge.microsoft.com/addons/detail/abc",
    ]) {
      expect(
        isInstalledLocally(
          ext({ id: "a".repeat(32), name: "Something", homepageUrl: host, store: "chrome" }),
          [{ id: "b".repeat(32), name: "Different", homepageUrl: host }],
          "chrome"
        )
      ).toBe(false);
    }
  });

  it("still matches on a real DEVELOPER homepage across stores", () => {
    // The signal the host rule exists for — keepassxc.org is not a store listing.
    const remote = ext({ id: "oboonakemofpalcgghocfoadofidjkkk", name: "KeePassXC-Browser", homepageUrl: "https://keepassxc.org/", store: "chrome" });
    expect(isInstalledLocally(remote, [{ id: "keepassxc-browser@keepassxc.org", name: "KeePassXC", homepageUrl: "https://www.keepassxc.org/docs/" }], "firefox")).toBe(true);
  });

  it("still matches the same extension by id, store homepage or not", () => {
    expect(isInstalledLocally(icloud, [...localsWithStoreHomepages, { id: icloud.id, name: "iCloud Passwords" }], "chrome")).toBe(true);
  });

  it("still matches a differently-ided local copy by name (dev-loaded / sideloaded)", () => {
    expect(isInstalledLocally(icloud, [{ id: "temp-dev-id", name: "iCloud  Passwords" }], "chrome")).toBe(true);
  });

  it("treats a missing homepage as no signal, not as a match", () => {
    expect(isInstalledLocally(ext({ id: "a".repeat(32), name: "A", store: "chrome" }), [{ id: "b".repeat(32), name: "B" }], "chrome")).toBe(false);
  });
});

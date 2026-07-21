import { describe, it, expect } from "vitest";
import {
  normalizeExtName, inferStore, isInstalledLocally, storeUrlFor, installOrSearchUrl,
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

import { describe, it, expect, afterEach, vi } from "vitest";
import { detectBrowser, readDeviceBrowser } from "@/lib/utils/browser-identity";
import { browser } from "@/lib/utils/ext";

// What a device tells its peers it runs (#10). Every user agent below is a real one; the
// brand lists are the shape Chromium's navigator.userAgentData reports.

type Runtime = { getBrowserInfo?: () => Promise<{ name?: string; version?: string }> };

function as(nav: Record<string, unknown>) {
  vi.stubGlobal("navigator", nav);
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (browser.runtime as Runtime).getBrowserInfo;
});

const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const brands = (...names: string[]) => ({ brands: names.map((brand) => ({ brand, version: "130" })) });

describe("detectBrowser on Chromium", () => {
  it("names the browser from its brand, never the Chromium base or the GREASE entry", async () => {
    as({ userAgent: CHROME_UA, userAgentData: brands("Chromium", "Google Chrome", "Not?A_Brand") });
    expect(await detectBrowser()).toEqual({ engine: "chromium", name: "Chrome" });

    as({ userAgent: `${CHROME_UA} Edg/130.0.0.0`, userAgentData: brands("Not)A;Brand", "Microsoft Edge", "Chromium") });
    expect(await detectBrowser()).toEqual({ engine: "chromium", name: "Edge" });

    as({ userAgent: CHROME_UA, userAgentData: brands("Brave", "Chromium", "Not_A Brand") });
    expect(await detectBrowser()).toEqual({ engine: "chromium", name: "Brave" });
  });

  it("falls back to what Brave, Edge and Opera say elsewhere when no brand names them", async () => {
    as({ userAgent: CHROME_UA, userAgentData: brands("Chromium"), brave: {} });
    expect((await detectBrowser())?.name).toBe("Brave");

    as({ userAgent: `${CHROME_UA} OPR/114.0.0.0` });
    expect(await detectBrowser()).toEqual({ engine: "chromium", name: "Opera" });
  });

  it("shows a build that names nothing but Chromium by its engine alone", async () => {
    // Helium and ungoogled-chromium: anything more would be a guess shown to a peer as fact.
    as({ userAgent: CHROME_UA, userAgentData: brands("Not.A/Brand", "Chromium") });
    expect(await detectBrowser()).toEqual({ engine: "chromium" });
  });

  it("drops every version, so no packet carries more than a name and an engine", async () => {
    as({ userAgent: CHROME_UA, userAgentData: brands("Google Chrome") });
    expect(JSON.stringify(await detectBrowser())).not.toMatch(/\d/);
  });
});

describe("detectBrowser on Gecko", () => {
  const FIREFOX_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0";

  it("asks the browser for its own name, so a fork can say what it is", async () => {
    as({ userAgent: FIREFOX_UA });
    (browser.runtime as Runtime).getBrowserInfo = async () => ({ name: "Zen", version: "1.24b" });
    expect(await detectBrowser()).toEqual({ engine: "gecko", name: "Zen" });
  });

  it("says Firefox when the browser has nothing better to say", async () => {
    as({ userAgent: FIREFOX_UA });
    expect(await detectBrowser()).toEqual({ engine: "gecko", name: "Firefox" });

    (browser.runtime as Runtime).getBrowserInfo = async () => ({ name: "Fennec" });
    expect(await detectBrowser()).toEqual({ engine: "gecko", name: "Firefox" });
  });
});

describe("detectBrowser elsewhere", () => {
  it("gives a WebKit browser its engine and no invented name", async () => {
    as({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15" });
    expect(await detectBrowser()).toEqual({ engine: "webkit" });
  });

  it("gives nothing rather than a guess when it cannot tell", async () => {
    as({ userAgent: "Node.js/24" });
    expect(await detectBrowser()).toBeNull();

    as({ userAgent: "Mozilla/5.0 (rv:132.0) Gecko/20100101 Firefox/132.0" });
    (browser.runtime as Runtime).getBrowserInfo = async () => { throw new Error("nope"); };
    expect(await detectBrowser()).toBeNull();
  });
});

describe("readDeviceBrowser", () => {
  it("reads what a current peer wrote", () => {
    expect(readDeviceBrowser({ engine: "gecko", name: "Firefox" })).toEqual({ engine: "gecko", name: "Firefox" });
    expect(readDeviceBrowser({ engine: "webkit" })).toEqual({ engine: "webkit" });
  });

  it("shows nothing for an older peer, which simply has no field", () => {
    expect(readDeviceBrowser(undefined)).toBeNull();
  });

  it("drops what a shared folder should never have handed it", () => {
    // A file in the folder is untrusted input, like every other field in it.
    expect(readDeviceBrowser({ engine: "trident", name: "IE" })).toBeNull();
    expect(readDeviceBrowser("Brave")).toBeNull();
    expect(readDeviceBrowser({ engine: "chromium", name: 42 })).toEqual({ engine: "chromium" });
    expect(readDeviceBrowser({ engine: "chromium", name: "\u202EevarB" })).toEqual({ engine: "chromium", name: "evarB" });
    expect(readDeviceBrowser({ engine: "chromium", name: "x".repeat(200) })?.name).toHaveLength(32);
  });
});

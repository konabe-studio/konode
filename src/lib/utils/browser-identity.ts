import type { BrowserEngine, DeviceBrowser } from "@/lib/types";
import { browser } from "@/lib/utils/ext";

/**
 * What this device runs, for the device list on the OTHER devices (#10): the browser's name
 * and its engine, and nothing else.
 *
 * The limit is the point. The device list needs something that tells the Chrome build and
 * the Firefox build on one Mac apart, and "Brave (Chromium)" next to "Firefox (Gecko)" does
 * that. Anything finer, a version, the OS, a hardware or install id, would start to single a
 * machine out, and Konode does not fingerprint. Two identical machines stay identical here,
 * which is accepted: the last-upload time is what separates those.
 *
 * Every source is one the browser hands to any extension without a permission:
 *
 *  - Gecko: `runtime.getBrowserInfo()`, which names the browser itself, so a fork can answer
 *    with its own name. Its version is dropped.
 *  - Chromium: `navigator.userAgentData.brands`, the first brand that is neither the
 *    "Chromium" base nor the deliberately meaningless GREASE entry. Versions dropped. Brave
 *    also has `navigator.brave`, and Edge and Opera keep a token in the user agent, for the
 *    builds that send no brand.
 *  - WebKit: the engine only. A WebKit browser that runs extensions presents Safari's user
 *    agent, so there is no honest name to read.
 *
 * Any failure gives null, and the packet simply goes without the field. A wrong answer is
 * worse than none: a peer would display it as fact.
 */
export async function detectBrowser(): Promise<DeviceBrowser | null> {
  try {
    const nav = (globalThis as { navigator?: NavigatorLike }).navigator;
    const ua = nav?.userAgent ?? "";
    const engine = engineFrom(ua, nav);
    if (!engine) return null;
    const name = engine === "gecko" ? await geckoName()
      : engine === "chromium" ? chromiumName(ua, nav)
      : undefined;
    return name ? { engine, name } : { engine };
  } catch {
    return null;
  }
}

interface NavigatorLike {
  userAgent?: string;
  userAgentData?: { brands?: { brand: string }[] };
  brave?: unknown;
}

function engineFrom(ua: string, nav: NavigatorLike | undefined): BrowserEngine | null {
  // Chromium and WebKit user agents both say "like Gecko", so the word proves nothing. The
  // "Firefox/" token is the test, and it goes first.
  if (/\bFirefox\//.test(ua)) return "gecko";
  if (nav?.userAgentData || /\b(Chrome|Chromium)\//.test(ua)) return "chromium";
  if (/\bAppleWebKit\//.test(ua)) return "webkit";
  return null;
}

async function geckoName(): Promise<string | undefined> {
  const getInfo = (browser.runtime as { getBrowserInfo?: () => Promise<{ name?: string }> }).getBrowserInfo;
  if (typeof getInfo !== "function") return "Firefox";
  const { name } = await getInfo();
  // Defensive: should a mobile build answer with an internal code name, the row still says
  // what the user installed.
  if (!name || /^(Fennec|Fenix)$/i.test(name)) return "Firefox";
  return name;
}

// "Not A(Brand", "Not)A;Brand", "Not_A Brand"... GREASE changes shape on purpose, so match
// the pattern rather than a list.
const GREASE = /not.?a.?brand/i;
const BRAND_NAMES: Record<string, string> = {
  "Google Chrome": "Chrome",
  "Microsoft Edge": "Edge",
};

function chromiumName(ua: string, nav: NavigatorLike | undefined): string | undefined {
  const brand = nav?.userAgentData?.brands
    ?.map((b) => b.brand)
    .find((b) => b && b !== "Chromium" && !GREASE.test(b));
  if (brand) return BRAND_NAMES[brand] ?? brand;
  if (nav?.brave) return "Brave";
  if (/\bEdg\//.test(ua)) return "Edge";
  if (/\bOPR\//.test(ua)) return "Opera";
  // A Chromium build that names nothing else (Helium, ungoogled-chromium, Vivaldi) is shown
  // by its engine alone, which is the truth about it as far as an extension can tell.
  return undefined;
}

const ENGINES: readonly BrowserEngine[] = ["chromium", "gecko", "webkit"];
const MAX_NAME = 32;

/**
 * A peer's `device_browser`, checked before it reaches the screen.
 *
 * It comes out of a file in a shared folder, so it is untrusted input like every other
 * field there: an unknown engine or a malformed value is dropped rather than drawn, and a
 * name is cut to something that fits a row. Control characters go too, so a crafted name
 * cannot carry its own bidi overrides into the label around it.
 */
export function readDeviceBrowser(raw: unknown): DeviceBrowser | null {
  if (!raw || typeof raw !== "object") return null;
  const { engine, name } = raw as { engine?: unknown; name?: unknown };
  if (typeof engine !== "string" || !ENGINES.includes(engine as BrowserEngine)) return null;
  const clean = typeof name === "string"
    // eslint-disable-next-line no-control-regex
    ? name.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, "").trim().slice(0, MAX_NAME)
    : "";
  return clean ? { engine: engine as BrowserEngine, name: clean } : { engine: engine as BrowserEngine };
}

/** The engine as people know it. Proper names, so never translated. */
export const ENGINE_LABEL: Record<BrowserEngine, string> = {
  chromium: "Chromium",
  gecko: "Gecko",
  webkit: "WebKit",
};

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { PROVIDERS } from "@/lib/storage-providers";

// The Chrome Web Store listing copy, held to the two rules that have cost a release.
//
// Store metadata is reviewed harder than it used to be, and a run of brand names in a
// description reads as keyword stuffing however true each name is. The provider cards are
// the honest place for "we have one ready for Koofr": the store page says what Konode
// connects to, which is three backends, and the wizard says which servers have a card.
//
// The copy itself is NOT in the repo (`store-listing/` is gitignored along with the other
// submission material, which carries an OAuth secret placeholder). So this suite skips
// where the directory is absent, on CI and on a fresh clone, and runs on the machine the
// submission is actually made from, which is the only one where the mistake can be made.
const DIR = resolve(__dirname, "../../store-listing");
const SHIPPED = JSON.parse(
  readFileSync(resolve(__dirname, "../../shipped-languages.json"), "utf8")
) as string[];

/** English plus every language the extension is held to a complete translation for. */
const LOCALES = ["en", ...SHIPPED];

/** The store's own limit on the short description field. */
const SUMMARY_MAX = 132;

/**
 * The three words the copy is allowed to name, because they are what the product connects
 * to rather than a list of brands: a backend each.
 */
const BACKENDS = ["Google Drive", "GitHub", "WebDAV"];

/**
 * Every other storage brand Konode knows about, derived from the provider cards so a new
 * card is covered the day it is added. "Nextcloud / ownCloud" is two of them, and the
 * generic WebDAV card's description names Synology and kDrive, which the old copy repeated.
 */
const FORBIDDEN = [
  ...new Set([
    ...PROVIDERS.flatMap((p) => p.label.split("/").map((part) => part.trim()))
      .filter((word) => word && !BACKENDS.some((b) => word.includes(b))),
    "Synology",
    "kDrive",
  ]),
];

const read = (name: string): string => readFileSync(join(DIR, name), "utf8").trim();
const summaryFile = (loc: string): string => `cws-${loc}-summary.txt`;
const descriptionFile = (loc: string): string => `cws-${loc}-description.txt`;

describe.skipIf(!existsSync(DIR))("Chrome Web Store listing copy", () => {
  it("has a summary and a description for every listing language", () => {
    // The store keeps them per language, so a copy change is five edits. A language left
    // behind goes on serving the old text to everyone whose browser is set to it, which is
    // invisible from the dashboard's default view.
    for (const loc of LOCALES) {
      expect(existsSync(join(DIR, summaryFile(loc))), summaryFile(loc)).toBe(true);
      expect(existsSync(join(DIR, descriptionFile(loc))), descriptionFile(loc)).toBe(true);
    }
  });

  it("keeps every summary inside the store's 132-character limit", () => {
    for (const loc of LOCALES) {
      const summary = read(summaryFile(loc));
      expect(summary.length, `${loc} summary is ${summary.length} characters`).toBeLessThanOrEqual(SUMMARY_MAX);
      expect(summary.length, `${loc} summary is empty`).toBeGreaterThan(0);
    }
  });

  it("names no storage provider beyond the three backends", () => {
    // This is the one that stopped a release. The refused sentence listed seven brands in a
    // row; the fix was to describe the backends and leave the providers to the wizard.
    for (const loc of LOCALES) {
      const copy = `${read(summaryFile(loc))}\n${read(descriptionFile(loc))}`.toLowerCase();
      for (const brand of FORBIDDEN) {
        expect(copy.includes(brand.toLowerCase()), `${loc} copy names ${brand}`).toBe(false);
      }
    }
  });

  it("still says which three backends there are", () => {
    // The other direction, and the reason this is a pair: trimming the provider list must
    // not take the actual answer with it. The backend names stay in Latin script in every
    // language, Chinese included.
    for (const loc of LOCALES) {
      const description = read(descriptionFile(loc));
      for (const backend of BACKENDS) {
        expect(description.includes(backend), `${loc} description does not name ${backend}`).toBe(true);
      }
    }
  });
});

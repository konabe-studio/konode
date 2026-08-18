// Keep only the languages Konode ships as finished in a built package.
//
// Translations are open to volunteers on Weblate, which puts a language in the repository
// the moment somebody translates its first string. That is the healthy state of work in
// progress, and `public/_locales` is right to carry it — but a package is a different
// promise. A 22-of-308 Estonian in the zip is not "Konode in Estonian", it is Konode in
// English wearing an Estonian label, because `chrome.i18n` falls back to `default_locale`
// message by message.
//
// The Chrome Web Store also refuses such a package outright. It validates every bundled
// locale against the manifest's `__MSG_*__` references and rejects the upload when one has
// no message: "Missing name translation for language it". That error is what sent us
// looking, but it is only the symptom — Firefox accepts the same package without a word,
// and shipping it there would be just as wrong.
//
// The list of shipped languages lives in shipped-languages.json, read by this script and
// by i18n.test.ts, so the languages we package and the languages we hold to a completeness
// check cannot drift apart. Adding a language there is the last step of shipping it.

import { readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The languages Konode ships as finished, not counting the default locale. */
export function shippedLanguages() {
  return JSON.parse(readFileSync(resolve(repoRoot, "shipped-languages.json"), "utf8"));
}

/**
 * Delete every locale directory under `localesDir` that Konode does not ship, keeping
 * `defaultLocale` whatever happens: it is what every other language falls back to, and a
 * package without it has no strings at all.
 *
 * Operates on a BUILT directory (a staging copy, or dist-firefox/), never on
 * `public/_locales` — the repository keeps every language, including the unfinished ones,
 * because that is where translators work.
 */
export function pruneUnshippedLocales(localesDir, defaultLocale) {
  if (!existsSync(localesDir)) return [];

  const keep = new Set([defaultLocale, ...shippedLanguages()]);
  const dropped = [];

  for (const entry of readdirSync(localesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || keep.has(entry.name)) continue;
    rmSync(join(localesDir, entry.name), { recursive: true, force: true });
    dropped.push(entry.name);
  }

  if (dropped.length) {
    console.log(
      `Left out ${dropped.join(", ")}: started, not finished, so not shipped. ` +
        `They stay in public/_locales for translators.`
    );
  }
  return dropped;
}

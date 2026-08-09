import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { t, plural } from "@/lib/utils/i18n";

// The catalogues are data, and nothing type-checks them. `chrome.i18n.getMessage` answers
// an unknown key with an EMPTY STRING, so the native failure is a label that silently
// vanishes — invisible in a screenshot, invisible in review, and it only shows up in the
// one language nobody on the project reads. These tests are the actual safety net; the
// `t()` wrapper falling back to the key name is only the second line of defence.

const LOCALES_DIR = resolve(__dirname, "../../../public/_locales");
const SRC_DIR = resolve(__dirname, "../../");

type Entry = { message: string; placeholders?: Record<string, { content: string }> };
type Catalogue = Record<string, Entry>;

function catalogue(lang: string): Catalogue {
  return JSON.parse(readFileSync(join(LOCALES_DIR, lang, "messages.json"), "utf8")) as Catalogue;
}

const languages = readdirSync(LOCALES_DIR).sort();
const en = catalogue("en");

/**
 * Languages Konode SHIPS as finished, as opposed to languages that merely exist.
 *
 * Completeness is a promise about the release, not about the folder. Translations are open
 * to volunteers through Weblate, which puts a language in the repository the moment
 * somebody starts it — so a half-finished `fr` is the normal, healthy state of work in
 * progress, and failing the build over it would only teach us to reject the contribution.
 *
 * Every OTHER rule below still applies to every language: no invented keys, no dropped
 * placeholders. Those are correctness. Only the "finish it" rule is a policy, and it binds
 * the languages the maintainer can actually read and vouch for.
 *
 * Adding a language here is the last step of shipping it, after review.
 */
const SHIPPED = ["hu", "de"];

/**
 * Every `.ts`/`.tsx` file under src/ that could ASK for a message — tests excluded, and
 * i18n.ts itself excluded because it is the implementation, not a call site: `plural()`
 * builds its key with `t(`${base}_${count === 1 ? "one" : "other"}`)`, and reading that as
 * a call site made the scan believe the source wanted messages named "one" and "other".
 */
function sourceFiles(dir = SRC_DIR): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.tsx?$/.test(e.name) && !e.name.includes(".test.") && e.name !== "i18n.ts") out.push(p);
  }
  return out;
}

/**
 * The argument text of every `fn(` call in one file, up to the first `)`.
 *
 * Matching `t("literal")` alone was not enough: a conditional message is written
 * `t(cond ? "a" : "b")`, and the first version of this scan reported all sixteen of those
 * keys as dead. Reading the whole argument span finds both branches. A span that stops
 * early on a nested call — `t(String(n))` — simply contains no key literal, which is the
 * right answer for it anyway.
 */
function callSpans(src: string, fn: string): string[] {
  const spans: string[] = [];
  for (const m of src.matchAll(new RegExp(`\\b${fn}\\(`, "g"))) {
    const from = m.index + m[0].length;
    const end = src.indexOf(")", from);
    if (end > from) spans.push(src.slice(from, end));
  }
  return spans;
}

/** Keys the source ASKS FOR: literals inside a `t()` or `plural()` call. */
function keysUsedInSource(): Map<string, string> {
  const found = new Map<string, string>(); // key → the file that wants it
  const literal = /"([A-Za-z0-9_@]+)"/g;
  for (const file of sourceFiles()) {
    const src = readFileSync(file, "utf8");
    for (const span of callSpans(src, "t"))
      for (const m of span.matchAll(literal)) found.set(m[1], file);
    for (const span of callSpans(src, "plural"))
      for (const m of span.matchAll(literal)) {
        found.set(`${m[1]}_one`, file);
        found.set(`${m[1]}_other`, file);
      }
  }
  return found;
}

/** Whether a key appears anywhere in the source as a bare string literal. */
function appearsInSource(key: string): boolean {
  const needle = `"${key}"`;
  return sourceFiles().some((f) => readFileSync(f, "utf8").includes(needle));
}

describe("the English catalogue is the contract", () => {
  it("has a message for every key the source asks for by name", () => {
    const missing = [...keysUsedInSource()]
      .filter(([key]) => !en[key])
      .map(([key, file]) => `${key} (wanted by ${file.replace(SRC_DIR, "src")})`);

    expect(missing).toEqual([]);
  });

  it("has no message the source never asks for", () => {
    // Keys built at runtime (`status_${status}`, `datatype_${type}`) can't be seen by the
    // scan above, so they are listed here on purpose: naming them is what makes a genuinely
    // dead string stand out instead of hiding behind a template literal.
    const builtAtRuntime = [
      "extension_name",        // used by the manifest (and IS the store listing title)
      "extension_description", // used by the manifest, not by any .ts file
      "status_idle", "status_syncing", "status_success", "status_error", "status_conflict",
      "datatype_bookmarks", "datatype_history", "datatype_sessions", "datatype_extensions",
      "stream_off", "stream_syncing", "stream_pending", "stream_never", "stream_stale", "stream_synced",
      // `t(p.descKey)` / `t(p.noteKey)` — the key comes from the provider table, so the
      // scan sees a variable. storage-providers.test.ts is what proves each one resolves.
      "provider_gdrive_desc", "provider_nextcloud_desc", "provider_nextcloud_note",
      "provider_pcloud_desc", "provider_pcloud_note", "provider_koofr_desc", "provider_koofr_note",
      "provider_fastmail_desc", "provider_fastmail_note", "provider_github_desc", "provider_webdav_desc",
      // `t(`datatype_${key}_desc`)` — the setup wizard and Settings share these.
      "datatype_bookmarks_desc", "datatype_sessions_desc", "datatype_history_desc", "datatype_extensions_desc",
      // Read through tParts(), which takes the key as an argument rather than a literal.
      "provider_syncing_to", "onb_plaintext_note", "onb_done_subtitle",
    ];
    // Looser than the check above on purpose: this one hunts DEAD strings, so a key counts
    // as alive if it is named in a t()/plural() call (which expands `_one`/`_other`, since
    // neither ever appears as a whole literal), OR written as a bare literal anywhere at
    // all, OR listed above. Being strict here would only teach us to pad that list.
    const known = new Set([...builtAtRuntime, ...keysUsedInSource().keys()]);
    expect(Object.keys(en).filter((k) => !known.has(k) && !appearsInSource(k))).toEqual([]);
  });

  it("declares a placeholder for every $NAME$ it interpolates", () => {
    const broken: string[] = [];
    for (const [key, entry] of Object.entries(en)) {
      const named = [...entry.message.matchAll(/\$([A-Z_]+)\$/g)].map((m) => m[1].toLowerCase());
      const declared = Object.keys(entry.placeholders ?? {}).map((n) => n.toLowerCase());
      for (const n of named) if (!declared.includes(n)) broken.push(`${key}: $${n.toUpperCase()}$`);
    }
    expect(broken).toEqual([]);
  });
});

describe.each(languages.filter((l) => l !== "en"))("the %s catalogue", (lang) => {
  const other = catalogue(lang);

  it.runIf(SHIPPED.includes(lang))("translates every English key", () => {
    // chrome.i18n falls back to English per message, so a gap is not a crash. This is the
    // one rule that only binds SHIPPED languages: for those it is how a translator learns
    // that a release added strings, and how the maintainer knows the screen is not half
    // English. For a language still being worked on, a gap is just work in progress.
    expect(Object.keys(en).filter((k) => !other[k])).toEqual([]);
  });

  it("invents no key English doesn't have", () => {
    // A key here that English lacks is unreachable: the source only ever asks by name.
    expect(Object.keys(other).filter((k) => !en[k])).toEqual([]);
  });

  it("keeps every placeholder, so no interpolated value goes missing", () => {
    // The classic translation loss: the sentence survives, `$COUNT$` doesn't, and the
    // count silently disappears from the screen. The mirror case is just as bad and reads
    // worse: a `$NAME$` English never had is declared nowhere, so nothing substitutes it
    // and the raw `$NAME$` ships to the screen. Both are what this hunts.
    //
    // Two things deliberately DON'T count as broken, because neither loses a value and
    // failing over them cost us more than it ever caught:
    //
    // A key this language hasn't translated yet. chrome.i18n falls back per message, so an
    // absent key renders the whole English string, `$COUNT$` included — nothing is lost.
    // Counting those failed the build over every unfinished language, which is the state
    // the SHIPPED note above calls normal and healthy, and buried any real break under a
    // wall of them: of 22 reported on the first Weblate contribution, 21 were this.
    //
    // The same placeholder used more than once. getMessage substitutes EVERY occurrence,
    // so repeating one is a normal thing to need — zh_Hans names the region twice because
    // that is how the sentence works in Chinese — and it interpolates correctly both
    // times. What matters is WHICH placeholders appear, not how often, so compare sets.
    const names = (s: string) => new Set([...s.matchAll(/\$([A-Z_]+)\$/g)].map((m) => m[1]));
    const broken: string[] = [];
    for (const [key, entry] of Object.entries(en)) {
      const translated = other[key]?.message;
      if (translated === undefined) continue;
      const want = names(entry.message);
      const got = names(translated);
      const lost = [...want].filter((n) => !got.has(n));
      const invented = [...got].filter((n) => !want.has(n));
      if (lost.length) broken.push(`${key}: dropped $${lost.join("$, $")}$`);
      if (invented.length) broken.push(`${key}: invented $${invented.join("$, $")}$`);
    }
    expect(broken).toEqual([]);
  });
});

describe("t() and plural()", () => {
  it("returns the message, with substitutions applied", () => {
    expect(t("popup_sync_now")).toBe("Sync now");
    expect(t("popup_recovery_notice", "412")).toContain("(412 bookmarks)");
  });

  it("shows the key rather than nothing when a message is missing", () => {
    // A blank label is the failure that reaches users; an ugly key is the one that gets
    // reported. This is deliberately not an empty string.
    expect(t("no_such_key_anywhere")).toBe("no_such_key_anywhere");
  });

  it("picks the singular form only for exactly one", () => {
    expect(plural("popup_tabs", 1)).toBe("1 tab");
    expect(plural("popup_tabs", 2)).toBe("2 tabs");
    expect(plural("popup_tabs", 0)).toBe("0 tabs");
  });
});

import { browser } from "@/lib/utils/ext";

/**
 * One user-visible string, by key, from `public/_locales/<lang>/messages.json`.
 *
 * The browser picks the language from its own UI language and falls back to
 * `default_locale` (English) **per message**, so a half-finished translation degrades to
 * a mixed screen rather than an empty one — which is what makes it worth accepting a
 * translation that isn't complete yet.
 *
 * Two deliberate choices:
 *
 *  - **A missing key renders as the key, not as nothing.** `i18n.getMessage` returns `""`
 *    for a key it doesn't know, so the native behaviour is a label that silently
 *    disappears — the single most common i18n regression, and invisible in review. A
 *    visible `popup_sync_now` is ugly on purpose. `i18n.test.ts` is what actually keeps
 *    it from shipping; this is the second line of defence.
 *  - **No ICU plurals**, because `chrome.i18n` has none. Where a count is part of the
 *    sentence, there are two keys (`…_one` / `…_other`) and `plural()` below picks one.
 *    Languages that use the singular after a numeral (Hungarian: "3 lap") simply give
 *    both keys the same wording.
 */
export function t(key: string, subs?: string | string[]): string {
  const msg = browser.i18n.getMessage(key, subs);
  if (!msg) {
    console.warn(`[Konode] missing translation: ${key}`);
    return key;
  }
  return msg;
}

/**
 * `t()` for a string that contains a count. Pass the base key without the suffix.
 *
 * English needs two forms, Hungarian needs one, and other languages need more than two —
 * this covers the two-form case and the one-form case (same wording in both keys). A
 * language with three or more forms would need its own rule here; none of the languages
 * Konode ships is such a case yet, and pretending otherwise would be dead code.
 */
export function plural(baseKey: string, count: number, subs?: string | string[]): string {
  return t(`${baseKey}_${count === 1 ? "one" : "other"}`, subs ?? String(count));
}

/**
 * A one-placeholder message split into the text before and after the placeholder, so the
 * value can be rendered as its own element — `<code>` for a URL, `<b>` for an emphasised
 * word — instead of being flattened into the sentence.
 *
 * The alternative was two keys ("Syncing to" + ""), which quietly assumes every language
 * puts the value in the same place. It does not: Hungarian says "Szinkronizálás ide: URL",
 * and a language that ends with the verb would need the value first. Splitting the
 * translated string keeps word order the translator's business.
 *
 * The sentinel is a NUL, which cannot occur in a message.
 */
export function tParts(key: string): [string, string] {
  // Written as an escape on purpose: a raw NUL byte in a source file is invisible in
  // every editor and every diff, and a tool that rewrites the file can silently eat it.
  const SENTINEL = "\u0000";
  const [before, after = ""] = t(key, SENTINEL).split(SENTINEL);
  return [before, after];
}

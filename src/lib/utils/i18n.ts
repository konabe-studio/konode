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

/**
 * Label `<html lang>` with the language the page is ACTUALLY rendered in.
 *
 * The three HTML entry points ship `lang="en"`, because that is what they are before React
 * runs. Once it has, the page is whatever language the catalogues answered in, and a page
 * that says English while showing Chinese is not a cosmetic inaccuracy. Chrome reads that
 * mismatch as a page worth translating, and a user with "always translate English" set
 * gets it done silently, with no bar and no click.
 *
 * Machine translation replaces React's own text nodes with `<font>` wrappers. The next
 * render then tries to remove a node whose parent is no longer the one React recorded, and
 * the whole surface dies with "Failed to execute 'removeChild' on 'Node'" (#36: the
 * wizard, on the click that swaps the Google button's icon for a spinner). `translate="no"`
 * on `<html>` is the guarantee that stops it; this function removes the reason Chrome
 * wanted to translate in the first place, and is the part screen readers care about, since
 * they otherwise pronounce every language with English phonetics.
 *
 * **The tag comes from the catalogue, not from `i18n.getUILanguage()`.** That API reports
 * the BROWSER's language, which is only the same thing when we ship that language: set to
 * French, it says `fr` while `chrome.i18n` falls back to English per message and the user
 * reads English. Labelling that page `fr` would invite exactly the translation this is
 * here to prevent, from the other direction. `locale_bcp47` is a message like any other,
 * so it rides the same per-message fallback as the text beside it and can only name the
 * catalogue that actually answered.
 */
export function applyDocumentLanguage(): void {
  const tag = t("locale_bcp47");
  // `t()` answers an unknown key with the key itself, which is a deliberate choice for a
  // visible label and a bad one for an attribute. Only a plausible tag gets written; the
  // markup's `lang="en"` is the right thing to leave alone otherwise.
  if (/^[a-z]{2,3}(-[A-Za-z]{2,8})*$/.test(tag)) document.documentElement.lang = tag;
}

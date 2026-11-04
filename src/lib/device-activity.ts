/**
 * How long ago a device last uploaded, said the way people say it, and when that is long
 * enough to point out (#10).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Days without an upload after which the device list marks a device as inactive.
 *
 * Why 30, and why the sync interval does not set it: `lastSeen` is a device's last UPLOAD,
 * and a device uploads only when something it syncs has changed (`uploadIfChanged`). The
 * interval, 30 seconds to 10 minutes, decides how soon a change goes out, not whether an
 * idle browser writes at all, so it is minutes against a threshold measured in weeks. What
 * the threshold has to clear is a browser that is in use and simply has nothing new: with
 * open tabs or history synced, any browsing day uploads something, but a device that syncs
 * bookmarks only can be used daily and upload nothing for weeks. Thirty days is past any
 * ordinary gap of that kind, short enough to catch the reinstall the issue is about, and
 * the same order as the "over a month" ghost row in Brave's own device list.
 *
 * It only ever marks. Nothing is forgotten or deleted on its strength: the files are in the
 * user's own storage, and removing them is the user's call (#10, open question 3).
 */
export const DORMANT_DEVICE_DAYS = 30;

/**
 * Whether a device has gone `DORMANT_DEVICE_DAYS` without an upload.
 *
 * An unknown time is not old, and this device never is: it is running the page asking. Its
 * own last upload can be old for the reason above, and calling the device you are holding
 * inactive would only teach people to ignore the mark.
 */
export function isDormant(lastSeen: string | null, isSelf: boolean, now: number): boolean {
  if (isSelf || !lastSeen) return false;
  const at = Date.parse(lastSeen);
  if (Number.isNaN(at)) return false;
  return now - at > DORMANT_DEVICE_DAYS * DAY_MS;
}

/**
 * "39 days ago", "3 hours ago", "2 years ago", in `locale`, through the browser's own
 * `Intl.RelativeTimeFormat`, so no unit word ever needs a catalogue entry.
 *
 * Days run to 60 before months take over, because a day count is what the inactive mark is
 * measured in, and "39 days ago" next to it says more than "1 month ago". A time in the
 * future, which only a skewed clock produces, reads as now rather than "in 3 minutes".
 *
 * `locale` should be the language the page is rendered in (`catalogueLocale()`), not the
 * browser's: this phrase sits inside a translated sentence, and on a browser set to a
 * language Konode does not ship, the sentence is English and the phrase has to be too.
 */
export function relativeTime(iso: string, now: number, locale: string | undefined): string {
  const at = Date.parse(iso);
  const secs = Number.isNaN(at) ? 0 : Math.max(0, Math.floor((now - at) / 1000));
  if (secs < 1) return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(0, "second");
  // numeric "always" from here on: "auto" turns -1 day into "yesterday", which is a calendar
  // claim, and 40 hours before 9 in the morning was the day before yesterday.
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "always" });
  if (secs < 60) return rtf.format(-secs, "second");
  const mins = Math.floor(secs / 60);
  if (mins < 60) return rtf.format(-mins, "minute");
  const hours = Math.floor(mins / 60);
  if (hours < 24) return rtf.format(-hours, "hour");
  const days = Math.floor(hours / 24);
  if (days < 60) return rtf.format(-days, "day");
  if (days < 365) return rtf.format(-Math.floor(days / 30), "month");
  return rtf.format(-Math.floor(days / 365), "year");
}

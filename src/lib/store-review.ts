// Where this install can be rated, for the "Rate in the store" row in Settings.
//
// Keyed on the extension's own id, because that is what says which store an install came
// from: each store assigns its own (Firefox uses the gecko id the manifest pins). An Edge
// user who installed from the Chrome Web Store carries the Web Store's id, so that is
// where their rating goes, and where it counts. An id not listed here (the local unpacked
// build, a Chromium package someone built and loaded themselves) has no store to rate it
// in, so it gets no row. A self-built Firefox package keeps the gecko id, and AMO is still
// the right place for it.
//
// Edge Add-ons assigns a new id when the listing is created; add it here once it exists
// (internal/PUBLISHING-EDGE.md, "After certification").

import { STORE_NAME } from "@/lib/utils/extensions-match";

export interface ReviewPage {
  /** The store's own name. A brand, so it is shown as is in every language. */
  store: string;
  url: string;
}

const PAGES: Record<string, ReviewPage> = {
  mmlfiiimnpnjcjhhbldenpcmnibedkfa: {
    store: STORE_NAME.chrome,
    url: "https://chromewebstore.google.com/detail/konode/mmlfiiimnpnjcjhhbldenpcmnibedkfa/reviews",
  },
  // AMO's rating widget is on the listing itself, not on its reviews page.
  "konabe@proton.me": {
    store: STORE_NAME.firefox,
    url: "https://addons.mozilla.org/firefox/addon/konode/",
  },
};

export function reviewPageFor(extensionId: string): ReviewPage | null {
  return PAGES[extensionId] ?? null;
}

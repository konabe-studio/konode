# Browser compatibility

Konode works through the browser's extension APIs, so a browser that installs it but leaves
an API out can't sync that data type. Bookmarks need `bookmarks`, open tabs need `tabs`,
history needs `history`, the extension list needs `management`, and Google Drive sign-in
needs `identity.launchWebAuthFlow`. GitHub and WebDAV need nothing beyond a network request.
This page tracks what each browser actually does, not only whether it installs.

Last updated: 2026-11-24 · Konode version: 1.6.0

## Legend

| Mark | Meaning |
|---|---|
| ✅ | Works: tested here, or confirmed by a user (the Source column says which) |
| ⚠️ | Works with a limitation (see Source and notes) |
| ❌ | Tested, does not work |
| 🚫 | Not possible on this browser (the API or the install route is missing) |
| ⏳ | Not tested yet |

A blank cell means the row stops earlier: Konode can't be installed there at all.

## Desktop

| Browser | Engine | Install from | Install | Bookmarks | Open tabs | History | Extension list | Google Drive | GitHub | WebDAV | Source and notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Google Chrome | Chromium | Chrome Web Store | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | Tested here, and the browser most of Konode's users run |
| Brave | Chromium | Chrome Web Store | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | Tested here. QA pass, Brave 157, 2026-11-09 (WebDAV). Drive: three-device group with Firefox and Helium, 1.2.0 |
| Helium | Chromium | Chrome Web Store | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | Tested here. QA pass, Helium 0.21.1.1, 2026-11-09 (WebDAV) and 2026-09-29 (Drive) |
| Microsoft Edge | Chromium | Edge Add-ons, or the Chrome Web Store | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | Tested here. Drive sign-in from the Edge Add-ons install, 2026-11-06. Edge 142 renumbered its bookmark roots, handled since 1.5.1 ([#66](https://github.com/konabe-studio/konode/issues/66)). A long history froze the browser once a minute before 1.6.0 ([#96](https://github.com/konabe-studio/konode/issues/96)) |
| Norton Neo | Chromium | Chrome Web Store | ✅ | ⚠️ | ⏳ | ✅ | ⏳ | ✅ | ⏳ | ⏳ | QA, 2026-09-29. Neo stores a `chrome://` bookmark under its own `neo://` name; Konode treats the two as one since 1.4.0 ([#41](https://github.com/konabe-studio/konode/issues/41)) |
| Vivaldi | Chromium | Chrome Web Store | ✅ | ⚠️ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | Tested here, Vivaldi 8.3 (Chromium 156) with Konode 1.6.0, 2026-11-23: from the Chrome Web Store on Koofr and Google Drive against Thorium (open tabs both ways, restore, a tab sent to Vivaldi), and against a Chromium device on WebDAV (bookmarks, history, the extension list, a tab sent from Vivaldi). Vivaldi shows a folder of its own choosing as the bookmark bar, so your other browsers' bar arrives one level up until you make Vivaldi's Bookmarks folder the bar ([how](TROUBLESHOOTING.md#vivaldi)). A bookmark deleted on Vivaldi goes to Vivaldi's Trash, which extensions see as a move, so the deletion does not reach your other devices; deletions made elsewhere do arrive. From the next version Vivaldi's deletions arrive too. Vivaldi's starter bookmarks (Home, Shopping, Travel and the rest) sync like any other |
| Opera | Chromium | Chrome Web Store, through Opera's "Install Chrome Extensions" | ⚠️ | ⚠️ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | Tested here, Opera 140 (Chromium 157) with Konode 1.6.0, 2026-11-23: installed from the Chrome Web Store through "Install Chrome Extensions"; against a Chromium device on WebDAV, every data type and Send to device, both ways; then on Koofr, Google Drive and GitHub against Thorium, Send to device included. Your other browsers' bar lands on Opera's bookmark bar. A bookmark deleted on Opera goes to Opera's Trash, which extensions see as a move, so the deletion does not reach your other devices; deletions made elsewhere do arrive. From the next version Opera's deletions arrive too ([what to do until then](TROUBLESHOOTING.md#opera)) |
| ungoogled-chromium | Chromium | Chrome Web Store, after the steps on `chrome://ungoogled-first-run/` (the chromium-web-store helper) | ⚠️ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | Tested here, ungoogled-chromium 157 with Konode 1.6.0, 2026-11-23: against a Chromium device on WebDAV, every data type and Send to device, both ways; then installed from the Web Store and on GitHub against Thorium, Send to device included. ungoogled-chromium can't install from the Web Store out of the box: it takes the helper its first-run page describes. Google Drive can't sign in there: ungoogled-chromium rewrites the sign-in return address to one Google can't accept ([why](TROUBLESHOOTING.md#ungoogled-chromium)); use GitHub or WebDAV |
| Yandex Browser | Chromium | Chrome Web Store | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | Tested here, Yandex 26.11 (Chromium 154) with Konode 1.6.0, 2026-11-23 and 24: installed from the Chrome Web Store, then on Google Drive and GitHub against Thorium, and on Koofr (WebDAV). Bookmarks added on the bar travel both ways, and so do their deletions; Yandex deletes outright, with no Trash in between. Tabs sent with Send to device open both ways, Yandex publishes its open tabs, and history travels both ways. The other devices' extension lists arrive; Yandex had no extension besides Konode, so it had none to send. Yandex shows extensions one more bookmark root, its Collections under the name Favorites, which Konode files with the bookmarks bar; it was empty here |
| Thorium | Chromium | Chrome Web Store | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | Tested here, Thorium 156 with Konode 1.6.0, 2026-11-23: against a Chromium device on WebDAV, every data type and Send to device, both ways; and from the Chrome Web Store on Koofr against Vivaldi, then on Google Drive and GitHub |
| Firefox | Gecko | Firefox Add-ons | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | Tested here. QA pass, Firefox 159, 2026-11-09 (WebDAV). Drive: three-device group, 1.2.0. History keeps each page's original visit date |
| Waterfox | Gecko | Firefox Add-ons | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | Tested here, first on Waterfox 140 with Konode 1.0.2 (2026-07) |
| Zen | Gecko | Firefox Add-ons | ✅ | ✅ | ⚠️ | ✅ | ✅ | ✅ | ✅ | ✅ | Tested here, Zen 1.24.3b (Firefox 160) with Konode 1.6.0, 2026-11-23: against a Chromium device on WebDAV, every data type and Send to device, both ways; then installed from Firefox Add-ons, on Google Drive and GitHub against Thorium, a tab sent from Thorium included. History keeps each page's original visit date. Only the workspace in front shares its open tabs, because Zen hides the others from extensions ([why](TROUBLESHOOTING.md#zen)) |
| Orion (macOS) | WebKit | Chrome Web Store or Firefox Add-ons, from inside Orion | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | ⚠️ | ✅ | ✅ | User reports on Orion RC ([#7](https://github.com/konabe-studio/konode/issues/7), [#9](https://github.com/konabe-studio/konode/issues/9), [#24](https://github.com/konabe-studio/konode/issues/24)). In August Orion RC had no `history.search` or `management.getAll`; not re-checked since. Drive: Konode fixed its side on 2026-09-08 (#24), not re-tested |
| Zephium | WebView2 (Windows), WebKit (macOS) | Chrome Web Store, from inside Zephium | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | Runs Chrome extensions on its own extension runtime, not on Chromium, so each API depends on what Zephium has built. Its install screen lists the APIs it does not provide |

## Android

| Browser | Engine | Install from | Install | Bookmarks | Open tabs | History | Extension list | Google Drive | GitHub | WebDAV | Source and notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Firefox for Android | Gecko | Firefox Add-ons | ✅ | 🚫 | ✅ | 🚫 | ✅ | 🚫 | ✅ | ✅ | QA, Firefox 158 on Android 15, 2026-10-26 (Koofr, end-to-end encryption on); then installed from Firefox Add-ons on GitHub against Thorium, 2026-11-23: open tabs restored both ways, Send to device both ways (a received tab opens in the background). No `bookmarks`, `history` or `identity` API, so Settings offers only open tabs and the extension list. No permission prompts: allow them in the add-on's Permissions screen ([details](TROUBLESHOOTING.md#firefox-for-android)) |
| Iceraven | Gecko | Firefox Add-ons | ✅ | 🚫 | ✅ | 🚫 | ⚠️ | 🚫 | ⏳ | ✅ | Tested here, Iceraven 2.53.1 (Gecko 160) on the Android 15 emulator with Konode 1.6.0 from Firefox Add-ons, 2026-11-24, against a Chromium device on WebDAV: open tabs and their restore, Send to device and the extension list, both ways. The same GeckoView limits as Firefox for Android: no `bookmarks`, `history` or `identity` API, and no permission prompts, so allow them on the add-on's Permissions screen (Settings → Extensions → Konode → Permissions); a WebDAV server on the internet needs "Allow for all sites" there. Iceraven reports its built-in Mozilla Android Components add-ons as ordinary extensions, so Konode sends them in the extension list as if you had installed them |
| IronFox | Gecko | Firefox Add-ons, after Settings → IronFox settings → Security → "Allow installation of add-ons" | ⚠️ | 🚫 | ⏳ | 🚫 | ⏳ | 🚫 | ⏳ | ⏳ | IronFox 160.0.1 on the Android 15 emulator, 2026-11-24: add-ons cannot be installed until that setting is on; then Konode installs from Firefox Add-ons. IronFox does not grant an add-on's host permissions at install, so on Konode's Permissions screen even the GitHub and Google addresses start switched off. The sync steps were not run here: IronFox has no remote debugging setting, and on the x86_64 test emulator its renderer crashed twice while Konode's setup changed pages, so the setup could not be finished. It needs a real phone; the engine is the one Iceraven runs |
| Fennec | Gecko | Firefox Add-ons | ⏳ | 🚫 | ⏳ | 🚫 | ⏳ | 🚫 | ⏳ | ⏳ | Same GeckoView limits as Firefox for Android |
| Quetta | Chromium | Chrome Web Store, Edge Add-ons | ✅ | ⏳ | ⏳ | ⏳ | ⏳ | ✅ | ⏳ | ⏳ | Drive works on a current Quetta: confirmed by a user, 2026-09-19 ([#24](https://github.com/konabe-studio/konode/issues/24), [#37](https://github.com/konabe-studio/konode/issues/37)). Older versions loaded the sign-in redirect as a page. Quetta ships arm64 only and crashes at launch on the x86_64 test emulator, so the rest needs a real phone |
| Vivaldi | Chromium | Chrome Web Store, with "Always Show Desktop Site" on (Settings → Content Settings) | ⚠️ | ⚠️ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | Tested here, Vivaldi 8.3 (Chromium 156) on the Android 15 emulator with Konode 1.6.0, 2026-11-24, against a Chromium device on WebDAV: open tabs and their restore, history and Send to device both ways, bookmarks added on either side arrive on the other, and the other device's extension list arrives (Vivaldi had no extension besides Konode, so it had none to send). Then on Google Drive and GitHub with end-to-end encryption, open tabs only: both read every other device's tabs and upload Vivaldi's own. The Google sign-in opens in a Vivaldi window and comes back signed in. The store page offers "Add to Vivaldi" only with Always Show Desktop Site on, and while it is on, Konode's own pages lay out at desktop width and show next to nothing, so turn it off again once Konode is installed. Vivaldi 8.3 shows the permission prompt, which 8.2 did not. A bookmark deleted on Vivaldi goes to Vivaldi's Trash, which extensions see as a move, so the deletion does not reach your other devices; deletions made elsewhere do arrive, and land in Vivaldi's Trash. Your other browsers' bar lands in Vivaldi's Bookmarks folder |
| Microsoft Edge (stable) | Chromium | Edge Add-ons, from inside Edge | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | Edge for Android installs only listed Edge Add-ons; Konode is listed there since 1.5.1. Not measured: Edge ships arm64 only, and on the x86_64 test emulator Edge 158 installs from Google Play but crashes at launch (2026-11-23) |
| Microsoft Edge Canary | Chromium | Edge Add-ons, by ID or CRX | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | Developer options: tap the build number five times. Crashes at launch on the x86_64 test emulator, like Edge |
| Bare Browser | Chromium | Chrome Web Store, CRX | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | Ships arm64 only: on the x86_64 test emulator it installs from Google Play but crashes at launch (2026-11-23), so it needs a real phone |
| Titanium (formerly Helium for Android) | Chromium | Chrome Web Store, CRX or ZIP | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | |
| Cromite | Chromium | Chrome Web Store, with the tab's "Desktop site" on (browser menu) | ⚠️ | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | Tested here, Cromite 153 (the x86_64 build from its GitHub releases) on the Android 15 emulator with Konode 1.6.0, 2026-11-24. Extensions are on out of the box; the store page offers "Add to Chrome" once the tab shows the desktop site. Cromite never shows a permission prompt and its extension settings cannot grant one, so nothing that needs an optional permission works: open tabs, history, the extension list, and WebDAV, whose server address needs one. Konode's setup says so when the prompt does not come. Google Drive's sign-in crashes Cromite: its sign-in window fails to start. On GitHub with end-to-end encryption, bookmarks travel: the other devices' bookmarks arrive under Other bookmarks, the only bookmark root Cromite shows besides its Tabs collection, and a bookmark added on Cromite is uploaded, as is its deletion; Cromite deletes outright |
| Lemur | Chromium | Chrome Web Store, Edge Add-ons | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | |
| Yandex Browser | Chromium | Chrome Web Store, from the store's desktop page (browser menu → "Go to the desktop version") | ⚠️ | ⚠️ | ❌ | ✅ | ✅ | ❌ | ✅ | ✅ | Installed on Yandex 26.11, Android 15 emulator, 2026-11-23: the mobile store page only says to switch to Chrome, so the install takes the store's desktop version, where "Add to Chrome" is; setup then offers all four data types. With Open tabs on, Konode 1.6.0 crashes Yandex's extension process at every sync: Yandex grants the `tabGroups` permission but has no such API, and reading it is fatal there. Konode's pages crash with it. Without Open tabs it runs: set up that way on GitHub against Thorium, 2026-11-24, it sent a tab to Thorium and took in a bookmark added there, and turning Open tabs on afterwards brought the crash straight back. Yandex for Android shows extensions two bookmark roots, Mobile and Favorites (on the desktop, Favorites is Yandex's Collections), so what your other browsers keep on the bar and in Other bookmarks lands together in Favorites. Yandex's bookmark screen lists everything directly in Favorites as a folder: a bookmark kept loose there opens as an empty folder, while bookmarks inside folders show normally. Bookmarks you add on Yandex go to Mobile, and on a desktop browser they arrive in Other bookmarks, because desktop Chromium hides its Mobile bookmarks folder from extensions while it is empty. Bookmarks and their deletions travel both ways; a bookmark deleted on Yandex is deleted outright, with no Trash in between. History travels both ways too. So does the extension list. "Open all" opens the store's mobile pages, so switch each to the desktop version to install. Koofr (WebDAV) connects and syncs. After Konode had been turned off and back on, its pages showed message keys (`opt_nav_backend` and the like) instead of text; restarting Yandex brought the text back. Google Drive does not connect: Yandex refuses the sign-in within a second, before any Google page opens, so Konode reports that the sign-in window closed. Still so after a restart, 2026-11-24 |
| Mises | Chromium | Chrome Web Store | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | Ships arm64 only: on the x86_64 test emulator Mises (Chromium 141, from Google Play) starts, but every page crashes, its own settings pages and the Chrome Web Store included (2026-11-24), so it needs a real phone |
| Chromium "Desktop Android" build | Chromium | Chrome Web Store, CRX | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | An experimental Google build, not the Chrome from the Play Store |
| Google Chrome | Chromium | none | 🚫 | | | | | | | | No extension support |
| Samsung Internet | Chromium | Galaxy Store only | 🚫 | | | | | | | | Curated add-ons only, no Web Store, no sideloading |
| Brave, Opera, Thorium, DuckDuckGo | Chromium | none | 🚫 | | | | | | | | No extension support |

## iOS

| Browser | Engine | Install from | Install | Bookmarks | Open tabs | History | Extension list | Google Drive | GitHub | WebDAV | Source and notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Orion | WebKit | Chrome Web Store or Firefox Add-ons, from inside Orion | ⚠️ | ✅ | ✅ | ✅ | ✅ | ❌ | ⏳ | ✅ | Field test against Brave on one WebDAV folder with end-to-end encryption, 2026-08-11. Drive sign-in fails inside Orion's own API bridge. Setup did not open by itself on a first install; since 1.3.0 the popup opens it with a click, which has not been run on a device yet. See the [ROADMAP](ROADMAP.md#not-supported-but-closer-than-it-was-ios--webkit) |

## What differs by engine

| | Chromium | Firefox (desktop) | Firefox for Android | Orion (WebKit) |
|---|---|---|---|---|
| History from other devices | Arrives dated at the sync | Keeps the original visit date | Not available | ⏳ |
| Tab groups | Restored, with names and colours once Konode may read them | Restored where the browser has groups (Firefox 138 and later) | Restored ungrouped | Restored ungrouped |
| Send to device: sending | Right-click a page or a link, or the popup | Also from a tab's own menu | From the popup | ⏳ |
| Send to device: receiving | ✅ | ✅ | ✅ | ⏳ |
| Google Drive sign-in | PKCE flow, works on every desktop Chromium browser, not only Chrome. On Android it works on Quetta and Vivaldi, not on Yandex, and crashes Cromite | Same flow | Not available | Fails on iOS |

## Test checklist (per browser)

1. Install from the store, or sideload the CRX or the unpacked build.
2. Setup opens on first run, or the popup offers to finish it.
3. Connect each storage provider: Google Drive, GitHub, WebDAV.
4. Push: bookmarks, open tabs, history and the extension list reach the storage.
5. Pull: data from another device appears in the right place (bookmarks bar, other
   bookmarks, mobile bookmarks).
6. Send a tab to the device and from it.
7. Survives a browser restart: still installed, still signed in, still syncing.
8. The popup and Settings are usable on a phone screen.

## Reporting a browser

Tested Konode on a browser that isn't listed, or found a ⏳ that you can fill in?
[Open an issue](https://github.com/konabe-studio/konode/issues/new) with the browser name
and version, the operating system, the Konode version, the storage you used, and which
checklist steps passed. A short "it works" for one row helps too.

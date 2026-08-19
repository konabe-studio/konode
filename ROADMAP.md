# ROADMAP.md: direction

High-level direction. Shipped history is in `CHANGELOG.md`.

## Vision
A privacy-first browser sync that puts the user's data on storage **they own**
(Google Drive / GitHub / WebDAV), with **no Konode server** and **no telemetry**.
Native-sync parity (add + delete propagate both ways) with optional E2EE, working
on any Chromium browser and on Firefox.

## Now (done / hardened)
- Two-way bookmark sync with deletion propagation (tombstones), folders preserved.
- Near-instant sync-on-change; reliable with the MV3 worker cold.
- Opt-in E2EE (AES-256-GCM); SHA-256 integrity, verified on download.
- Three backends: Google Drive, GitHub (fine-grained PAT), WebDAV.
- History / sessions / extensions data types; conflict-resolution UI.
- **Drive OAuth refresh token (PKCE)**: survives past the ~1h token, no re-consent.
- **Tests + lint + CI**: Vitest + ESLint + GitHub Actions, on every push and again on a
  version tag.
- **True multi-device merge (3+ devices)**: `downloadAll()` + fold every peer per sync.
- **Session-manager UI**: the popup lists each peer device's session with a
  per-device Restore button; `konode_remote_sessions` is a device-keyed map so
  sessions aggregate across all peers.
- **Cross-peer data merge for every type**: extensions now aggregate across all
  peers too (`konode_remote_extensions` is device-keyed; the popup unions the lists),
  so bookmarks, history, sessions and extensions all merge across all devices.
- **Newest-peer ordering**: the engine sorts peers newest-first by packet
  `timestamp` (`orderPeersByTime`), so `peers[0]` (the LWW/manual-conflict baseline)
  is correct on every backend. GitHub/WebDAV list files in arbitrary order; rather
  than per-backend commit/mtime lookups, ordering uses the same clock LWW already
  trusts.
- **Sync-engine + bookmark-merge test coverage**: an in-memory `chrome.bookmarks`
  fake drives `importBookmarks` (merge/replace/tombstone/folders) and
  `SyncEngine.syncType` (pull → fold every peer → push merged) under Vitest.
- **All three backends device-verified**: two-way sync confirmed end-to-end on
  Google Drive, GitHub, and WebDAV (pCloud). Stale-read 409s fixed (`cache:no-store`);
  idle syncs no longer re-commit (`uploadIfChanged`).
- **Store packaging + releases**: `npm run package:chrome` builds a Web Store zip
  with the manifest `key` stripped (the CWS rejects `key` on a first upload) while
  `dist/` keeps it for unpacked dev; pushing a `v*` tag runs a GitHub Actions release
  that attaches both packaged zips, Chrome and Firefox (source builds, no client secret).
  Released through v1.3.0. **One folder per destination**, because the two variants of a
  version are otherwise indistinguishable once zipped: `web-ext-artifacts/chrome/` and
  `.../firefox/` hold the store uploads, with Konode's OAuth secret compiled in;
  `.../source/` holds what goes on the release page, with no secret. Each package run
  declares which it means to build, reads the bundle back, and refuses to write the zip
  when the two disagree, in either direction. See `scripts/build-variant.mjs`.
- **Pre-submission hardening**: a peer's extension `storeUrl` is rebuilt locally
  from the id (a forged URL was a phishing vector); onboarding requests all optional
  permissions in one call (a second request lost the user gesture); the dead
  `SET_EXTENSION_ENABLED` handler is gone, so `management` is strictly read-only.
- **Bookmark restore points** (1.1.0): timestamped copies of the bookmark tree on your own
  storage, the newest 10 kept, saved by hand or automatically when Konode refuses an
  unusual mass deletion. A restore only ever adds bookmarks back.
- **A card per storage provider** (1.1.0): Google Drive, Nextcloud / ownCloud, pCloud
  (EU or US), Koofr, Fastmail, GitHub, and WebDAV for everything else.
- **Activity + Statistics in Settings** (1.1.0), joined into one tab in 1.2.0, which also
  added the device list and letting you forget a device you no longer use.
- **Firefox shipped** (1.2.0): the build is in the release and the add-on is live on
  Firefox Add-ons. Verified across Firefox, Brave and Helium on one sync folder, with
  history arriving on the original visit dates, which only Firefox permits.
- **The interface translated** (1.2.0, completed in 1.3.0): every screen reads
  through the browser's own `chrome.i18n`, so no library and no bundle cost. The popup and
  the setup wizard shipped in 1.2.0; Settings was the last surface holding hardcoded
  English and went out with 1.3.0. English, Hungarian, German, Spanish and Chinese
  (Simplified) are complete at 308 strings each. `i18n.test.ts` guards the catalogues: a shipped
  language must translate every key, and no language may drop a placeholder English has or
  invent one it doesn't. A key nobody has translated yet is work in progress, not a
  failure, so a language still being worked on cannot break the build.
- **Translation opened to volunteers** on
  [Hosted Weblate](https://hosted.weblate.org/projects/konode/), which is where Spanish,
  Chinese (Simplified), Italian and Estonian came from.
- **A full review pass** (1.2.0): correctness fixes across the sync engine, the storage
  backends and the interface, including bookmark renames, moves and folder reorders now
  propagating. See `CHANGELOG.md`.

## Now live
Konode is live on both stores. Both served **1.2.1** going into this release, after the
Chrome Web Store's review of 1.2.1 cleared and closed the one-patch gap that had been open
since 2026-08-07.

- [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/konode/): **serving 1.3.0**
  since 2026-08-17, listed since 2026-08-04. AMO auto-approved and signed the upload, so
  it went out within minutes; the source submission a bundled add-on requires is reviewed
  afterwards rather than before.
- Chrome Web Store: **1.3.0 submitted, in review**, so the listing serves 1.2.1 until it
  clears. First published 2026-07-20, item ID `mmlfiiimnpnjcjhhbldenpcmnibedkfa`.

The two therefore sit a version apart again for a few days, which is the normal shape of a
release here rather than anything going wrong. Both store uploads are built by hand with
Konode's own OAuth client compiled in and live in `web-ext-artifacts/chrome/` and
`.../firefox/`; the zips attached to the GitHub release are source builds without it, from
`.../source/`. See the packaging note under *Store packaging + releases* above for what
keeps the two from being confused.

## Next
- **Backend expansion**, cheapest sign-in first. See *Platform priority* item 3 below.
- **History sync performance**: the full-history dedup scan every import runs.
- **More languages.** Japanese, Italian and Estonian are open volunteer work on Weblate
  with no target date. A language joins `shipped-languages.json` once it is complete, which
  is the last step of shipping it: that one list is what both the packaging scripts and
  `i18n.test.ts` read, so what we ship and what we hold to a completeness check cannot
  drift apart. Completeness is the whole bar: the translators
  are native speakers and Weblate is where their work gets reviewed, so a language no
  maintainer here reads is not thereby held back.
- **Scoped in the tracker, not here.** Three issues carry design work that belongs on this
  list, with the API checks and the reasoning written out where contributors can read them
  rather than in a local file. No dates and no version targets, the same as everything else
  under *Next*: #11 and #10 were gated on the translations release, which shipped
  2026-08-17, and that is the only timing claim either of them supports.
  - [#11 What Konode can and cannot sync](https://github.com/konabe-studio/konode/issues/11)
    measures us against Brave Sync's list and answers it with a principle instead of a
    backlog: Konode can only sync what means the same thing in every browser. Two real
    candidates fall out. **Reading list** (`chrome.readingList`, Chrome 120+) is the
    cheaper of them, because `capabilities.ts` already handles a data type a browser does
    not implement, so it would report itself unavailable on Firefox and the sync would skip
    it with no engine change. **Live tab groups** (`chrome.tabGroups`, live groups only,
    since Brave's *saved* groups are not exposed to extensions) is structurally the same
    problem as #6 and belongs in the same design.
  - [#10 Device identity is per install, not per machine](https://github.com/konabe-studio/konode/issues/10),
    split from #7. The rule it lands on: never merge identities automatically, ask, and ask
    with the only two facts that let a human decide, how recently the device uploaded and
    what data it holds. Default to keeping both, because Forget is reversible while taking
    over an identity overwrites. The structural half is worth more than the duplicate row:
    **nothing ages out a peer**, so a device that never syncs again is merged every cycle,
    forever, until somebody hits Forget.
  - [#6 Sync a tab's container](https://github.com/konabe-studio/konode/issues/6), matched
    by NAME, because `cookieStoreId` is per profile and means nothing on another machine.
    Firefox only: Chromium has no container concept at all, and whether Brave 1.92's
    containers reach extensions is unverified rather than settled. Needs `cookies` and
    `contextualIdentities`, both as optional permissions, which `capabilities.ts` is
    already the right place to gate.

## Not supported, but closer than it was: iOS / WebKit

**e.g. Orion on iOS.** Still not a supported target, and the honest reason is no longer
"it doesn't work" but "nobody has signed up to keep it working". A field session on
2026-08-11, Orion against Brave on one WebDAV folder with E2EE on, got all four data types
syncing. What it also found is that WebKit breaks the assumptions the Chromium code is
written on, in ways the test suite cannot see.

What is fixed and **shipped in 1.3.0**, but **not yet verified on the device**. The first
two came out of that session; the third is what the session made obvious:

- **Two roots answering to one kind.** Orion has a "Bookmarks Bar" *and* a "Favorites",
  and the WebKit title override made both of them the bar, so arriving bookmarks landed in
  whichever the browser listed first. An 80-bookmark tree arrived as 32 + 48 across the
  two. The match now prefers the root that is a bar by id and only falls back to the title
  rescue, which keeps the 1.0.2 fix working on an Orion that has no id-1 bar.
- **One open per gesture, not per call.** WebKit grants a click a single programmatic
  open. Session restore was spending it on a probe tab and then rescuing the rest with a
  `windows.create` that was swallowed just as silently, so a 10-tab session restored as 1.
  The engine is now settled before the gesture is spent, seeded from the platform and
  remembered in `konode_tabs_single_open`. The suite stayed green through all of this
  because the fake exempted `windows.create` from the blocker; it no longer does.
- **No way back into setup.** Onboarding was opened from exactly one place, the
  `onInstalled` → `tabs.create(onboarding.html)` call, and on WebKit that open is a no-op.
  A first install therefore showed nothing: no wizard, and a popup saying only "No backend
  configured", so setup had to be found by opening Settings and knowing what to look for.
  The popup now offers to finish setting up until a provider has been chosen, and opens the
  wizard from a **click**, which is the one allowance WebKit reliably honours. This was the
  gap that kept iOS from being merely "a browser we support". It is also the item on this
  list that has never run on Orion at all, since a first install is the only thing that
  shows it.

What is still genuinely missing:

- **Google Drive sign-in fails** inside the browser's own API bridge
  (`identity.launchWebAuthFlow` is not reliably implemented on iOS WebKit web extensions).
  Feature-gated, with a message pointing at GitHub or WebDAV. WebDAV is verified there;
  GitHub is untested.

A real iOS/WebKit target is still its own scoped effort, and the honest blocker is now
verification rather than code: three fixes are written and none has been run on the device.
What is left after that is one sign-in method that already degrades to a working
alternative.

## Platform priority (set 2026-07-10; items 1 and 2 have since shipped)
Sequenced by where our value prop is strongest, not by raw browser size:

1. **Chromium-first launch. Done 2026-07-20.** The "own your storage" pitch is
   *strongest here*: Chromium's only native sync is Google's cloud (no self-host), and the
   privacy-minded audience is Chromium-based: Brave, ungoogled-chromium and Helium, all of
   which we already support (the PKCE Drive flow exists specifically because
   `getAuthToken` fails on Brave). The Chrome Web Store listing went out first.
2. **Firefox. Done 2026-08-04.** Never a volume play (Firefox is a small share of desktop
   and its native Sync is self-hostable, so our edge is weaker there), but it is a close
   fit for the people who want this most, it's floccus/xBrowserSync's home turf, and only
   with it is the "every browser" claim true. All of the key work shipped:
   browser-agnostic bookmark-root resolution (Chrome ids "1/2/3" vs Firefox
   `toolbar_____`/`menu________`), the Firefox manifest variant (`background.scripts`
   event page + `browser_specific_settings`, via `scripts/make-firefox-manifest.mjs`),
   per-browser OAuth redirect registration, `management`-API graceful degradation, and
   AMO packaging plus review.
3. **Backend expansion, tiered by auth cost.** Cheapest first:
   - *Presets over the existing WebDAV backend*: **done in 1.1.0.** Nextcloud / ownCloud
     (host field), pCloud (EU or US), Koofr and Fastmail (fixed endpoints) each have a
     card; Synology, kDrive and anything else go through the generic WebDAV card.
   - *Token / basic-auth backends* (Dropbox token, S3-compatible, Backblaze B2):
     WebDAV/GitHub-class, ~0.5-1.5 d each, and they port to Firefox trivially.
   - *OAuth (PKCE) backends* (Dropbox OAuth, OneDrive/Graph): ~2-4 d each (provider
     app registration + redirect + refresh + QA, per browser).
   - *MEGA*: heavier (~3-5 d; own crypto SDK to bundle). See
     *MEGA integration (design notes)* below for the how.

## MEGA integration (design notes)
Added 2026-07-13. MEGA (mega.io) as a fourth `IBackend`, alongside Drive / GitHub /
WebDAV. Slots into the same per-device-per-type file model
(`konode_<type>_<device_id>.json` in a `Konode` folder). Rated ~3-5 d because,
unlike our other backends, MEGA has no plain HTTPS storage endpoint a browser can
PUT/GET against. You have to speak its API through a client library that also does
the crypto.

### Why it's not "just another WebDAV"
- **No usable REST/WebDAV surface for us.** MEGA's WebDAV/FTP support exists only via
  *MEGAcmd*, a local desktop server the user would have to run, useless for a
  zero-dependency extension. The real integration path is MEGA's own binary/JSON API,
  which is only practical to drive through a client SDK.
- **The SDK carries MEGA's client-side crypto.** MEGA is zero-knowledge: keys are
  derived from the password on the client, the password is never sent, and every file
  is encrypted client-side. Any library that talks to the API has to reproduce that
  key derivation and file encryption. That's the "own crypto SDK to bundle" cost.

### The library
- **[`megajs`](https://mega.js.org)** (npm `megajs`, MIT) is the maintained,
  browser-capable JS SDK. It handles MEGA's auth, key handling, encryption, folder
  handling, and networking. It deliberately does **no** file I/O. It works on
  buffers/streams, which suits us fine (our payloads are already JSON strings in
  memory).
- **Must verify it runs in an MV3 service worker.** Two hard requirements before we
  commit: (a) it bundles clean with our SW Vite build and is **eval-free / no remote
  code** (MV3 CSP forbids both), and (b) it uses `fetch` (not `XMLHttpRequest`, which
  doesn't exist in an MV3 SW). Prototype this first; it's the main schedule risk.

### Auth: prefer a session token over a stored password
- `megajs` logs in with **email + password** (2FA via `secondFactorCode` supported).
  The password is the master-key material, so treat it like the WebDAV password we
  already store: device-local in `chrome.storage.local`, never uploaded.
- **Better:** log in interactively once, then persist the resulting **session token**
  (megajs can export/restore a session) instead of keeping the raw password around.
  Same posture as the Drive refresh token: one credential entry, no long-lived
  password at rest. Store the session, not the passphrase, when we can.
- Credential entry is the *user typing their own backend credential into our own
  settings field* (exactly like WebDAV today), not us authenticating on their behalf.

### Mapping to `IBackend`
Implement `MEGABackend implements IBackend` (`src/lib/backends/mega-backend.ts`):
- `connect()`: construct the `Storage`/session, `mkdir` the `Konode` folder if absent.
- `upload(packet)`: MEGA has **no in-place overwrite**. Uploading a same-named file
  creates a second node (MEGA keeps versions). So the semantics we need are
  *delete-existing-then-upload*: find the node named
  `konode_<type>_<device_id>.json`, remove it, then `folder.upload(name, body)` and
  await `.complete`. Otherwise peers accumulate duplicate files and `downloadAll`
  double-counts.
- `downloadAll(type, excludeDeviceId)`: list the `Konode` folder's children, filter
  by the `konode_<type>_` prefix / `.json` suffix, exclude our own `device_id`,
  `downloadBuffer()` each, `JSON.parse`. Skip unreadable files (same tolerance the
  WebDAV backend has for partial writes).
- `testConnection()`: attempt login + list the folder; map bad-credential / 2FA
  errors to friendly messages.
- `listVersions()`: return `[]` (we don't use it; all three existing backends stub it).

### Wiring (mirrors the other backends)
- `types.ts`: add `"mega"` to `BackendType`; add a `mega?: { email; session?;
  password?; folder? }` block to `BackendConfig`.
- `abstract-backend.ts`: add the `case "mega": return new MEGABackend(config)` arm.
- Options + onboarding UI: a MEGA card with the credential fields and a **Test
  connection** button (reuse the existing `TEST_BACKEND` message path).

### Interaction with our own E2EE (call it out in docs)
MEGA already encrypts everything client-side, so turning on Konode's optional AES-GCM
E2EE on top is **redundant but harmless**, and it keeps the plaintext-SHA-256
checksum identical to other backends, so content still matches cross-provider. Worth a
one-line note in the UI so users don't think Konode E2EE is *required* for MEGA to be
private (it isn't). GDPR-wise MEGA is a strong story: zero-knowledge by default, data
on storage the user owns, consistent with the "own your storage, no Konode server"
pitch.

### Open questions / risks
- **MV3 SW compatibility of `megajs`** (above): the gating unknown; prototype first.
- **Bundle size**: megajs + its crypto is the largest dep we'd add; check the SW
  bundle stays reasonable.
- **Rate limits / API etiquette**: MEGA throttles aggressively; confirm our ~30s
  alarm floor + debounced writes don't trip EAGAIN, and that `withRetry` maps MEGA's
  error codes to backoff.
- **Firefox parity**: should port for free (browser-agnostic `fetch`), but re-verify once a
  MEGA backend exists. The Firefox build itself is runtime-verified as of 1.2.0, so the open
  question is the new backend, not the build.

## iCloud: asked for, and not on our terms

Requested on Reddit, 2026-08-17. The answer is no, and the reason is not effort.

- **iCloud Drive has no public API for third parties, and no WebDAV.** What circulates as
  "iCloud over WebDAV" is a relay service that proxies the files through its own server,
  which is precisely what this project exists to avoid. Routing someone's bookmarks
  through a third party on the way to storage they own is worse than not supporting it.
- **The one sanctioned route is CloudKit**, which needs a paid Apple Developer membership
  and writes into a container the *developer* registers, not into the user's iCloud Drive.
  The data lands in a private database they cannot open in Finder, cannot copy files out
  of, and cannot hand to another tool. They can delete it wholesale through Apple's
  storage settings, and that is the whole of their control over it.

The second point disqualifies it, not the fee. "Storage you own" means the files are
visible, copyable and portable, and that a user can walk away from Konode without losing
them. CloudKit would be the one backend where that stops being true, so it would buy an
Apple logo on a card in the setup wizard at the cost of the only claim the project makes.

Apple users are served today by any WebDAV provider, and by a private GitHub repository.
Reopen this if Apple ever ships an API that writes to the user's visible iCloud Drive.

## Later / nice-to-have
- Incremental diff for >10k bookmarks; history sync performance (the full-history dedup
  scan every import runs is what's left, after 1.2.0 overlapped the per-page writes that
  were the bigger part of a slow first sync).
- **Diffs between restore points.** Show what actually changed between two restore
  points in the Activity tab, rather than only that a sync ran. Checked against the code
  before listing it: `sync/snapshots.ts` writes a full bookmark tree per restore point
  through the generic `IBackend` file ops, and `restoreSnapshot()` already reads one back
  and decrypts it in order to restore it. So this is a comparison view over data that
  already exists plus a tree diff, not new plumbing, and it behaves the same on Drive,
  GitHub and WebDAV because restore points are ordinary files we write ourselves. The
  provider-side route is *not* available for this: `listVersions()` returns `[]` on all
  three backends. Two limits worth stating wherever this is described: bookmarks only
  (`exportBookmarkPayload`), and only across the newest `MAX_SNAPSHOTS`, which is 10.
- Optional OAuth proxy (serverless) to avoid shipping the Google client secret.

## Publishing

**Chrome Web Store.** 1.0.0 submitted for review on **2026-07-19**, **published
2026-07-20** (<https://chromewebstore.google.com/detail/konode/mmlfiiimnpnjcjhhbldenpcmnibedkfa>).
1.2.1 cleared review after it, and **1.3.0 is submitted on top of it and in review**,
so the listing serves 1.2.1 meanwhile. Listing copy is
maintained per language in the dashboard: the name and the short description come from the
extension's own catalogues and translate themselves, but the long description is entered by
hand, in each of the languages Konode ships.

**Locale codes are Chrome's list, not BCP 47.** `_locales` directory names must come from
the set Chrome documents, and a name outside it is not an error: Chrome ignores the
directory and quietly serves English. Simplified Chinese arrived from Weblate as `zh_Hans`,
which is correct BCP 47 and which Chrome does not know, so 308 translated strings reached
nobody, and the Web Store offered no Chinese listing language because as far as it could
tell the extension had no Chinese. It is `zh_CN` (and `zh_TW` for Traditional).

Renaming the directory was enough, and Weblate needed no change: on its next pull it
adopted `public/_locales/zh_CN/messages.json` and writes there now. The `zh_Hans` still in
its URLs is its own internal code for the language, not the filename, and the two are not
the same thing. Do **not** "fix" this with the component's *Language code style*: the only
option that yields `zh_CN` is POSIX-with-country-code, which forces a country onto every
language, turning `de` into `de_DE` and `hu` into `hu_HU`. Chrome accepts neither, so it
would break four shipped languages to fix one.

What is still worth watching is a NEW language whose code carries a script subtag, such as
Traditional Chinese, since Weblate would create it under the BCP 47 name. `i18n.test.ts`
fails on that shape, so it surfaces as a red CI on the Weblate pull request rather than as
a translation nobody can read.

**Firefox Add-ons.** Live at <https://addons.mozilla.org/firefox/addon/konode/> since
**2026-08-04**, first listed with 1.2.0, then 1.2.1, **serving 1.3.0 since 2026-08-17**.
An update to an add-on that is already listed is auto-approved and signed on upload, and
the source review happens afterwards, which is why 1.3.0 reached users while its version
notes were still being filled in. The source archive must be the commit the upload was
BUILT from, not necessarily the tag: 1.3.0 was built from `efd6eb0`, two commits past
`v1.3.0`, and an archive of the tag would have rebuilt into a package with eight locale
directories and the old Chinese name against an upload with five and the new one. AMO
diffs that rebuild and requires no differences. Packaged with
`npm run package:firefox` and checked with `npm run lint:firefox`. AMO requires a source
submission, since the build is bundled and minified, and the reviewer rebuilds and diffs
it.

Done for the Chrome Web Store: keyless store package (`npm run package:chrome`), $5
developer registration,
listing copy + screenshots, per-permission justifications, data-usage disclosures, and
the live privacy policy
(<https://github.com/konabe-studio/konode/blob/main/PRIVACY.md>). OAuth uses the
non-sensitive `drive.file` scope, so Google app verification was not required and the
free launch path (no brand verification) is in effect.

# Publishing to Firefox (AMO)

Step-by-step for listing Konode on [addons.mozilla.org](https://addons.mozilla.org)
(AMO). The Chrome Web Store flow lives in `ROADMAP.md → Publishing`; this is the
Firefox counterpart.

## What you're submitting
- **gecko id:** `konabe@proton.me`. **STABLE. Never change it after the first
  upload** (a new id = a brand-new listing that loses your reviews/users).
  (Was `konode@konode.org` until 2026-07-28 — a leftover pointing at a domain that
  was dropped and is not ours. Changed while AMO was still empty, i.e. while free.)
- **Minimum Firefox:** `128.0`.
- **Data collection:** none. The manifest already declares
  `browser_specific_settings.gecko.data_collection_permissions: { required: ["none"] }`,
  so AMO's data prompt is "No data collected."

All of these come from `scripts/make-firefox-manifest.mjs`; you don't set them by hand.

### ⚠️ The gecko id is tied to the Google OAuth client

Firefox derives the Drive sign-in redirect from the add-on id:

```
https://<sha1(gecko id)>.extensions.allizom.org/gdrive
```

It is a plain hash of the id, so it is **stable across profiles and installs** — which
is why it can be registered with Google at all (the `moz-extension://<uuid>/` origin is
per-install random and could not be). The flip side: **change the gecko id and Drive
sign-in breaks** with `redirect_uri_mismatch` until the new URL is added as an
Authorized redirect URI in the Google Cloud Console.

`npm run build:firefox` prints the current value on every run, so check it there rather
than computing it. For the id above:

```
https://35d48e659840bd4c2ff0ecf69c470919a3a111b8.extensions.allizom.org/gdrive
```

The redirect for the old `konode@konode.org` id
(`https://7a110f3c29a633744585eb6a2ec57ff9586b4528.extensions.allizom.org/gdrive`) is
now dead and can be removed from the Console.

GitHub and WebDAV are unaffected — neither uses OAuth.

## 0. One-time setup
1. A **Firefox account**, signed in at the Developer Hub:
   <https://addons.mozilla.org/developers/>.
2. *(Optional, only for CLI submission)* AMO API credentials: Developer Hub →
   **Manage API Keys** → generate a JWT issuer + secret.

## 1. Build the package
From the repo root, **with your `.env` present** (bakes in
`VITE_GOOGLE_CLIENT_SECRET` so the Google Drive backend works for users, exactly
like the CWS build; a secret-less build just disables Drive, GitHub/WebDAV are
unaffected):

```bash
npm ci
npm run lint:firefox      # web-ext lint
npm run package:firefox   # → web-ext-artifacts/konode-firefox-<version>.zip
```

`package:firefox` runs both Vite builds into `dist-firefox/`, rewrites the copied
Chrome manifest into the Firefox variant, then `web-ext build` zips it.

**`lint:firefox` expects 0 errors and 0 notices. Two warnings are normal** and are not
ours: `UNSAFE_VAR_ASSIGNMENT` for `innerHTML` in the vendor chunk that carries react-dom
(React sets `innerHTML` internally). `src/` contains no `innerHTML` and no
`dangerouslySetInnerHTML`. Warnings are not a rejection reason.

**Write down the exact Node and npm you built with** — step 4 needs them. Measured
2026-08-04: the build is **byte-for-byte deterministic** on the same machine and
toolchain (two consecutive `build:firefox` runs, all 24 files identical), which is what
makes the reviewer's diff pass at all. What has NOT been verified is whether a *different
Node major* emits identical bytes, so declare the version rather than a range.

## 2. Submit (listed) on AMO
1. Developer Hub → **Submit a New Add-on**.
2. Distribution channel: **On this site** (listed / public). (Pick *On your own*
   only if you want a self-distributed signed `.xpi` instead of a public listing.)
3. Upload `web-ext-artifacts/konode-firefox-<version>.zip`. AMO auto-validates it.
4. **Source code (required).** Konode is bundled and minified by Vite, and Mozilla
   requires sources whenever a module bundler or minifier is used. The reviewer
   **rebuilds and diffs it against the uploaded package: "there must be no
   differences."** So the notes have to reproduce the bytes, not merely explain them.
   - Upload a **source archive** straight from the tag (the repo is public, so this
     needs no cleanup, and it cannot accidentally carry `node_modules/` or `.env`):
     ```bash
     git archive --format=zip -o web-ext-artifacts/konode-src-1.2.0.zip v1.2.0
     ```
   - ⚠️ **The Google client secret has to go in the reviewer notes.** `.env` is not in
     the repo, and `VITE_GOOGLE_CLIENT_SECRET` **is compiled into the output** —
     verified 2026-08-04, it appears in `background.js` and in `chunks/theme-*.js`. A
     secret-less rebuild therefore differs in two files and **fails the diff**. Saying
     "Drive is optional, a secret-less build just disables it" does not satisfy the
     requirement; it explains a difference that is not allowed to exist.
     Handing it over costs nothing that isn't already spent: the source submission is
     private to Mozilla, and the value is readable in the published `.xpi` by anyone who
     unzips it. (A distributed client secret is not a secret. Google's *Web application*
     client type is what forces one into the PKCE exchange; a client type that permits a
     genuinely public client would remove it. Out of scope here, worth its own decision.)
     **Never commit it.**
   - Reviewer / build notes — paste this, with the version numbers you actually used:
     ```
     Build: Node 20.20.2, npm 10.8.2 (Windows 11). Deterministic: repeat runs
     produce identical bytes.

       1. unzip the source archive
       2. create a file `.env` at the repo root containing exactly:
          VITE_GOOGLE_CLIENT_SECRET=<paste the value here>
       3. npm ci
       4. npm run build:firefox

     Output is dist-firefox/, which is what the uploaded zip contains. The build
     runs two Vite passes (UI entry points, then the background script) and then
     scripts/make-firefox-manifest.mjs rewrites the copied Chrome manifest into the
     Firefox variant (event-page background, gecko id, no Chrome `key`).
     ```
     Mozilla's reviewers default to Ubuntu 24.04.4 / Node 24.14.0 / npm 11.9.0 and ask
     that you document any difference from that — hence naming the exact versions above.
   - **Also explain the innerHTML warnings**, because AMO's own upload checklist lists
     them under "issues that can lead to rejections" and a reviewer meets them as
     minified code:
     ```
     The two UNSAFE_VAR_ASSIGNMENT warnings for innerHTML are in
     chunks/puzzle-<hash>.js, the bundled vendor chunk containing react-dom.
     React sets innerHTML internally. The extension's own source contains no
     innerHTML and no dangerouslySetInnerHTML — grep the source archive for
     either to confirm.
     ```
5. **Listing metadata.** Reuse the Chrome `STORE_LISTING.md` copy where it fits. The
   answers settled at the 1.2.0 submission, so they don't need re-deriving:
   - **Categories** (max 3): *Bookmarks*, *Privacy & Security*, *Tabs*. AMO has no
     Productivity category, which is what the CWS listing uses.
   - **Support email:** `konabe@proton.me` — the same address as the Google consent screen
     and the gecko id. It becomes **public** on the listing.
   - **Support website:** <https://github.com/konabe-studio/konode/issues>.
   - **License:** *Mozilla Public License 2.0*, matching `LICENSE`.
   - **This add-on is experimental:** leave unchecked.
   - **Requires payment / non-free services / hardware:** leave unchecked. A free Google
     Drive or GitHub account is enough; the paid providers on the storage cards are
     options, not requirements.
   - **Privacy policy:** tick the box and paste `PRIVACY.md` — AMO takes the policy
     **text** (Markdown supported), unlike CWS which takes a URL.
6. **Data collection:** answer *No data collected* (the manifest already says so).
   ⚠️ **A reviewer cannot test Konode without third-party storage** — there are no Konode
   accounts, it writes to storage the user already owns, and AMO's own checklist asks for
   test credentials in that case. Least exposure: a throwaway GitHub repo plus a
   fine-grained PAT scoped to **only that repo** (contents read/write), handed over in the
   reviewer notes and **revoked when the review closes**. Drive would mean handing over a
   Google account and needs an interactive consent flow; WebDAV would mean standing up a
   server.
7. **Firefox for Android: leave it UNCHECKED** until Konode has actually run there.
   Compatibility is set per version, so this is not a one-time decision — tick it in a
   later upload once tested. As of 1.2.0 it has never run on Android Firefox, and there
   are specific reasons to expect trouble rather than a pleasant surprise:
   - Mozilla documents that on Android the Add-ons Manager **does not let the user edit
     host permissions and does not indicate a pending host-permission request**. The
     WebDAV backend stands on exactly that grant (`optional_host_permissions:
     https://*/*`), so WebDAV setup may be broken there, or unexplainably broken.
   - Drive sign-in (`identity.launchWebAuthFlow`) is untested on Android.
   - Mozilla recommends MV2 for Android-targeted extensions because of parity gaps.
     Konode is MV3.
   - Android availability wants `browser_specific_settings.gecko_android` (even as `{}`)
     and the manifest has no such key. MDN says without it an extension is desktop-only;
     Extension Workshop says it is installable without it but recommended. **The two docs
     disagree**, so settle it by testing, not by reading.
   - Test path: `web-ext run -t firefox-android` with adb and "Remote debugging via USB"
     enabled on the phone.
8. **Version notes / release notes:** paste the release's CHANGELOG section.
9. Submit for review. (Review latency varies, often days.)

### Validator warnings that are expected (1.2.0)

AMO's upload validation returns **0 errors, 4 warnings** — it passes. All four are known:
- **2× innerHTML** in the react-dom vendor chunk (see step 4).
- **2× "Manifest key not supported by the specified minimum Firefox version"** —
  `data_collection_permissions` arrived in Firefox 140 (Android 142) while
  `strict_min_version` is 128. Harmless: 128–139 simply ignore the key, and those
  versions have no data-consent prompt for it to affect. Worth raising the floor in a
  later release: the 128 baseline is attributed to module background scripts, but MDN's
  compat data puts `background.type: "module"` at Firefox **112**, so 128 is more
  conservative than it needs to be. Check the current ESR before picking the new floor,
  and note Android would need `gecko_android.strict_min_version: "142"` to go quiet too.

## 3. After approval
- Publicly listed on AMO; Mozilla serves auto-updates when you upload a new version.
- Installable on Firefox **desktop** and, if you marked it, **Firefox for Android**.

## Version bumps
- Bump `version` in `package.json` (the build stamps it into the manifest via
  `sync-version`).
- Rebuild and upload the new zip **under the same gecko id** → same listing, seamless
  update.

## CLI alternative (optional)
With AMO API credentials you can submit from the terminal instead of the web UI:

```bash
web-ext sign --channel listed --source-dir dist-firefox \
  --api-key <JWT_ISSUER> --api-secret <JWT_SECRET>
```

AMO may still ask for the source archive for review, exactly as in the web flow.

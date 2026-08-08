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
  Released through v1.2.0.
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
- **A full review pass** (1.2.0): correctness fixes across the sync engine, the storage
  backends and the interface, including bookmark renames, moves and folder reorders now
  propagating. See `CHANGELOG.md`.

## Now live
Konode **1.2.0 is live on both stores**: the Chrome Web Store (first published 2026-07-20,
item ID `mmlfiiimnpnjcjhhbldenpcmnibedkfa`) and
[Firefox Add-ons](https://addons.mozilla.org/firefox/addon/konode/) (2026-08-04). Nothing
is waiting on a submission.

## Next
- **Backend expansion**, cheapest sign-in first. See *Platform priority* item 3 below.
- **History sync performance**: the full-history dedup scan every import runs.

## Not supported: iOS / WebKit

**e.g. Orion on iOS.** First install there shows no
onboarding (the `onInstalled` → `tabs.create(onboarding.html)` open is a no-op on
WebKit) and Google Drive sign-in fails inside the browser's own API bridge
(`identity.launchWebAuthFlow` is not reliably implemented on iOS WebKit web
extensions). The Drive option is now feature-gated + fails with a friendly message
there. Sync itself has run on Orion, and 1.0.2 fixed three WebKit-specific bugs found that
way, so this is not untested ground. It is still not a supported target: a real iOS/WebKit
target is its own scoped effort, not a quick fix.

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
   - *Proton Drive*: blocked on Proton's side, not on ours. See
     *Proton Drive integration (research notes)* below.

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

## Proton Drive integration (research notes)
Added 2026-08-08. Short answer: **not yet, and not on the terms Proton offers today.**
Proton Drive is the most obvious name missing from our provider list (zero-knowledge, EU,
privacy-first, exactly our audience), and the blocker is not our architecture. It is that
there is no third-party door into Drive right now. This section records what we checked so
the next person doesn't re-check it, and what would have to change for the answer to flip.

### What exists today
- **No public API.** Proton has never published one for Drive, and as of mid-2026 still
  hasn't. The standing community request for one lives on Proton's UserVoice forum.
- **[`ProtonDriveApps/sdk`](https://github.com/ProtonDriveApps/sdk)** (MIT, npm
  `@protontech/drive-sdk`) is the only real door: one shared C# + TypeScript engine that
  Proton is migrating its own clients onto, and what the official Proton Drive CLI
  (released June 2026) is built on.
- **The SDK's own README rules our use out.** It allows *personal, non-commercial
  projects* and states that it is "not yet ready for third-party production use", with
  commercial or production third-party apps called out as not allowed. A free MPL-2.0
  extension on the Chrome Web Store and AMO is still production distribution, not a
  personal project. The MIT license also covers only the code in that repo; access to
  Proton's hosted service stays governed by Proton's own terms.
- **They are not hostile to third parties, though.** Proton reserves an app-identification
  header for exactly this case: `x-pm-appversion: external-drive-<name>@<semver>` (rclone
  ships `external-drive-rclone@...`). Third-party clients are tolerated when they identify
  themselves honestly, rate-limit, and sync off events instead of polling.

### Why it is not "just another backend"
- **Auth is out of scope for the SDK.** The README is explicit: no authentication, no
  login flow, no session management. That is the entire hard part, and it is the part we
  would have to write against a private endpoint: Proton's `/auth/v4` SRP handshake, plus
  2FA, plus two-password mode, plus human verification. What little session helper the SDK
  does carry was username + password SRP with no 2FA path as of late 2025 (issue #6), so
  every Proton account with 2FA turned on, which is much of the audience that picks Proton
  in the first place, would be locked out unless we build that ourselves.
- **CAPTCHA on non-browser sign-in.** rclone's Proton backend hits `Code=9001` CAPTCHA on
  `/auth/v4` routinely; the API treats browser and non-browser auth differently, and a
  background service worker has nowhere to present that challenge. rclone's backend has
  also broken outright before (September 2024) and users report silent rate limiting.
- **We would be asking for the wrong credential.** WebDAV takes a server password, Drive
  and GitHub take scoped tokens. SRP would have us put the *Proton account password*, the
  master credential for that person's Mail, Pass and Drive, into a settings field. That is
  the opposite of the posture the rest of Konode has, and "it stays device-local" does not
  make the blast radius acceptable. Note that Proton's own CLI refuses this trade too: it
  signs in through the browser and keeps only a session.
- **MV3 runtime risk, worse than megajs.** The TypeScript SDK's crypto module
  (`OpenPGPCryptoWithCryptoProxy` over `@proton/crypto`) expects a worker pool, and
  `new Worker` does not exist inside an MV3 service worker (the spec forbids nested
  workers). We would need a worker-free crypto path in the SW, eval-free bundling under
  MV3 CSP, and OpenPGP plus Proton's crypto is a bigger bundle than anything we ship now.
  Firefox's event page has no such worker limit, so this would land as a Chromium-only
  problem on a backend that has to work on both.
- **Moving target.** The SDK is pre-release ("the architecture and public interface may
  still change"), and Proton is migrating Drive to a new cryptographic model at the end of
  2026 / early 2027, after which older SDK versions stop interoperating with the service.
  Building against it now means rebuilding it then.

### What already works, with no code from us
`rclone serve webdav` over rclone's Proton Drive backend, or one of the community
Proton-Drive-to-WebDAV bridges, exposes Drive over plain WebDAV on localhost, and our
generic **WebDAV (other)** card points at it as-is. That is the same shape as MEGAcmd, and
the MEGA notes above reject it for the same reason: a desktop daemon the user has to keep
running is not something a zero-dependency extension can call a supported backend. It is a
fine answer to a support question, not a card in the UI, and it inherits every CAPTCHA and
breakage risk listed above.

### If we shipped it anyway
Rough cost is ~2-3 weeks, not the 3-5 days MEGA is rated at, and nearly all of it is auth
and MV3 crypto rather than the `IBackend` mapping (that part is ordinary: a `Konode`
folder, `konode_<type>_<device_id>.json` per device, same as everywhere else). On top sits
a maintenance tail we do not control: any Proton auth change or client force-upgrade can
take the backend down between our releases, and users would blame Konode for it. Not worth
it while the terms say no.

### Revisit triggers
- Proton ships the auth / session module and opens the SDK to third-party production use.
  That is their stated plan, after the crypto migration completes (end 2026 / early 2027).
- Any browser-delegated sign-in we could drive from `launchWebAuthFlow`, the way the
  official CLI signs in through the browser, instead of SRP in a form field.
- An official WebDAV or S3 surface for Drive (long requested, no sign of it).

Until one of those, the honest public answer stays: Proton Drive is not supported, and
here is the local-bridge workaround if you want it today.

## Later / nice-to-have
- Incremental diff for >10k bookmarks; history sync performance (the full-history dedup
  scan every import runs is what's left, after 1.2.0 overlapped the per-page writes that
  were the bigger part of a slow first sync).
- Optional OAuth proxy (serverless) to avoid shipping the Google client secret.

## Publishing

**Chrome Web Store.** 1.0.0 submitted for review on **2026-07-19**, **published
2026-07-20** (<https://chromewebstore.google.com/detail/konode/mmlfiiimnpnjcjhhbldenpcmnibedkfa>).
1.2.0 is what the listing serves today.

**Firefox Add-ons.** Live at <https://addons.mozilla.org/firefox/addon/konode/> since
**2026-08-04**, shipped with 1.2.0. Packaged with `npm run package:firefox` and checked
with `npm run lint:firefox`. AMO requires a source submission, since the build is bundled
and minified, and the reviewer rebuilds and diffs it.

Done for the Chrome Web Store: keyless store package (`npm run package:chrome`), $5
developer registration,
listing copy + screenshots, per-permission justifications, data-usage disclosures, and
the live privacy policy
(<https://github.com/konabe-studio/konode/blob/main/PRIVACY.md>). OAuth uses the
non-sensitive `drive.file` scope, so Google app verification was not required and the
free launch path (no brand verification) is in effect.

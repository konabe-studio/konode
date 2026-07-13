# ROADMAP.md — direction

High-level direction. Granular tasks live in `TODO.md`; what's in flight is in
`SESSION_HANDOFF.md`; shipped history is in `CHANGELOG.md`.

## Vision
A privacy-first browser sync that puts the user's data on storage **they own**
(Google Drive / GitHub / WebDAV), with **no Konode server** and **no telemetry**.
Native-sync parity (add + delete propagate both ways) with optional E2EE, working
on any Chromium browser.

## Now (done / hardened)
- Two-way bookmark sync with deletion propagation (tombstones), folders preserved.
- Near-instant sync-on-change; reliable with the MV3 worker cold.
- Opt-in E2EE (AES-256-GCM); SHA-256 integrity, verified on download.
- Three backends: Google Drive, GitHub (fine-grained PAT), WebDAV.
- History / sessions / extensions data types; conflict-resolution UI.
- **Drive OAuth refresh token (PKCE)** — survives past the ~1h token, no re-consent.
- **Tests + lint + CI** — Vitest + ESLint + GitHub Actions (verify green after `npm install`).
- **True multi-device merge (3+ devices)** — `downloadAll()` + fold every peer per sync.
- **Session-manager UI** — the popup lists each peer device's session with a
  per-device Restore button; `konode_remote_sessions` is a device-keyed map so
  sessions aggregate across all peers.
- **Cross-peer data merge for every type** — extensions now aggregate across all
  peers too (`konode_remote_extensions` is device-keyed; the popup unions the lists),
  so bookmarks, history, sessions and extensions all merge across all devices.
- **Newest-peer ordering** — the engine sorts peers newest-first by packet
  `timestamp` (`orderPeersByTime`), so `peers[0]` (the LWW/manual-conflict baseline)
  is correct on every backend. GitHub/WebDAV list files in arbitrary order; rather
  than per-backend commit/mtime lookups, ordering uses the same clock LWW already
  trusts.
- **Sync-engine + bookmark-merge test coverage** — an in-memory `chrome.bookmarks`
  fake drives `importBookmarks` (merge/replace/tombstone/folders) and
  `SyncEngine.syncType` (pull → fold every peer → push merged) under Vitest.
- **All three backends device-verified** — two-way sync confirmed end-to-end on
  Google Drive, GitHub, and WebDAV (pCloud). Stale-read 409s fixed (`cache:no-store`);
  idle syncs no longer re-commit (`uploadIfChanged`).

## Next
All feature / polish / QA items are done — the remaining work is the **publishing
phase** (see *Before publishing* below).

## Platform priority (2026-07-10)
Sequenced by where our value prop is strongest, not by raw browser size:

1. **Chromium-first launch.** The "own your storage" pitch is *strongest here*:
   Chromium's only native sync is Google's cloud (no self-host), and the biggest
   privacy audience is Chromium-based — Brave alone is 100M+ MAU (growing ~2.5M/mo),
   plus ungoogled-chromium / Helium, all of which we already support (the PKCE Drive
   flow exists specifically because `getAuthToken` fails on Brave). Ship a strong
   Chrome Web Store listing first.
2. **Firefox as a fast-follow (v1.1), ~1–2 wk.** Not a volume play (Firefox desktop
   is ~4% and shrinking, and its native Sync is self-hostable, so our edge is weaker
   there) — but it's exactly our ICP, it's floccus/xBrowserSync's home turf, AMO +
   r/firefox is a high-fit channel, and only then is the "every browser" claim true.
   Key work: browser-agnostic bookmark-root resolution (Chrome ids "1/2/3" vs
   Firefox `toolbar_____`/`menu________`), a Firefox manifest (`background.scripts`
   event page + `browser_specific_settings`), per-browser OAuth redirect
   registration, `management`-API graceful degradation, and AMO packaging/review.
3. **Backend expansion, tiered by auth cost.** Cheapest first:
   - *Presets over the existing WebDAV backend* (Nextcloud / Synology / pCloud /
     kDrive / ownCloud) — near-zero code, mostly docs. Already functional.
   - *Token / basic-auth backends* (Dropbox token, S3-compatible, Backblaze B2) —
     WebDAV/GitHub-class, ~0.5–1.5 d each, and they port to Firefox trivially.
   - *OAuth (PKCE) backends* (Dropbox OAuth, OneDrive/Graph) — ~2–4 d each (provider
     app registration + redirect + refresh + QA, per browser).
   - *MEGA* — heavier (~3–5 d; own crypto SDK to bundle). See
     *MEGA integration (design notes)* below for the how.

## MEGA integration (design notes)
Added 2026-07-13. MEGA (mega.io) as a fourth `IBackend`, alongside Drive / GitHub /
WebDAV. Slots into the same per-device-per-type file model
(`konode_<type>_<device_id>.json` in a `Konode` folder). Rated ~3–5 d because,
unlike our other backends, MEGA has no plain HTTPS storage endpoint a browser can
PUT/GET against — you have to speak its API through a client library that also does
the crypto.

### Why it's not "just another WebDAV"
- **No usable REST/WebDAV surface for us.** MEGA's WebDAV/FTP support exists only via
  *MEGAcmd*, a local desktop server the user would have to run — useless for a
  zero-dependency extension. The real integration path is MEGA's own binary/JSON API,
  which is only practical to drive through a client SDK.
- **The SDK carries MEGA's client-side crypto.** MEGA is zero-knowledge: keys are
  derived from the password on the client, the password is never sent, and every file
  is encrypted client-side. Any library that talks to the API has to reproduce that
  key derivation and file encryption. That's the "own crypto SDK to bundle" cost.

### The library
- **[`megajs`](https://mega.js.org)** (npm `megajs`, MIT) is the maintained,
  browser-capable JS SDK. It handles MEGA's auth, key handling, encryption, folder
  handling, and networking. It deliberately does **no** file I/O — it works on
  buffers/streams, which suits us fine (our payloads are already JSON strings in
  memory).
- **Must verify it runs in an MV3 service worker.** Two hard requirements before we
  commit: (a) it bundles clean with our SW Vite build and is **eval-free / no remote
  code** (MV3 CSP forbids both), and (b) it uses `fetch` (not `XMLHttpRequest`, which
  doesn't exist in an MV3 SW). Prototype this first — it's the main schedule risk.

### Auth — prefer a session token over a stored password
- `megajs` logs in with **email + password** (2FA via `secondFactorCode` supported).
  The password is the master-key material, so treat it like the WebDAV password we
  already store: device-local in `chrome.storage.local`, never uploaded.
- **Better:** log in interactively once, then persist the resulting **session token**
  (megajs can export/restore a session) instead of keeping the raw password around.
  Same posture as the Drive refresh token — one credential entry, no long-lived
  password at rest. Store the session, not the passphrase, when we can.
- Credential entry is the *user typing their own backend credential into our own
  settings field* (exactly like WebDAV today) — not us authenticating on their behalf.

### Mapping to `IBackend`
Implement `MEGABackend implements IBackend` (`src/lib/backends/mega-backend.ts`):
- `connect()` — construct the `Storage`/session, `mkdir` the `Konode` folder if absent.
- `upload(packet)` — MEGA has **no in-place overwrite**: uploading a same-named file
  creates a second node (MEGA keeps versions). So the semantics we need are
  *delete-existing-then-upload*: find the node named
  `konode_<type>_<device_id>.json`, remove it, then `folder.upload(name, body)` and
  await `.complete`. Otherwise peers accumulate duplicate files and `downloadAll`
  double-counts.
- `downloadAll(type, excludeDeviceId)` — list the `Konode` folder's children, filter
  by the `konode_<type>_` prefix / `.json` suffix, exclude our own `device_id`,
  `downloadBuffer()` each, `JSON.parse`. Skip unreadable files (same tolerance the
  WebDAV backend has for partial writes).
- `testConnection()` — attempt login + list the folder; map bad-credential / 2FA
  errors to friendly messages.
- `listVersions()` — return `[]` (we don't use it; WebDAV/GitHub stub it too).

### Wiring (mirrors the other backends)
- `types.ts`: add `"mega"` to `BackendType`; add a `mega?: { email; session?;
  password?; folder? }` block to `BackendConfig`.
- `abstract-backend.ts`: add the `case "mega": return new MEGABackend(config)` arm.
- Options + onboarding UI: a MEGA card with the credential fields and a **Test
  connection** button (reuse the existing `TEST_BACKEND` message path).

### Interaction with our own E2EE (call it out in docs)
MEGA already encrypts everything client-side, so turning on Konode's optional AES-GCM
E2EE on top is **redundant but harmless** — and it keeps the plaintext-SHA-256
checksum identical to other backends, so content still matches cross-provider. Worth a
one-line note in the UI so users don't think Konode E2EE is *required* for MEGA to be
private (it isn't). GDPR-wise MEGA is a strong story: zero-knowledge by default, data
on storage the user owns — consistent with the "own your storage, no Konode server"
pitch.

### Open questions / risks
- **MV3 SW compatibility of `megajs`** (above) — the gating unknown; prototype first.
- **Bundle size** — megajs + its crypto is the largest dep we'd add; check the SW
  bundle stays reasonable.
- **Rate limits / API etiquette** — MEGA throttles aggressively; confirm our ~30s
  alarm floor + debounced writes don't trip EAGAIN, and that `withRetry` maps MEGA's
  error codes to backoff.
- **Firefox parity** — should port for free (browser-agnostic `fetch`), but re-verify
  once the Firefox build is runtime-tested.

## Later / nice-to-have
- Incremental diff for >10k bookmarks; history sync performance (the full-history
  dedup scan is the current bottleneck on the ~5s sync tail).
- Optional OAuth proxy (serverless) to avoid shipping the Google client secret.

## Before publishing
- OAuth consent screen: app name, logo, **privacy policy URL** (write the policy).
- `drive.file` scope justification + demo video for Google verification.
- Chrome Web Store listing ($5 one-time); review the permission warnings.

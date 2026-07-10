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
   - *Mega* — heavier (~3–5 d; own crypto SDK to bundle).

## Later / nice-to-have
- Incremental diff for >10k bookmarks; history sync performance (the full-history
  dedup scan is the current bottleneck on the ~5s sync tail).
- Optional OAuth proxy (serverless) to avoid shipping the Google client secret.

## Before publishing
- OAuth consent screen: app name, logo, **privacy policy URL** (write the policy).
- `drive.file` scope justification + demo video for Google verification.
- Chrome Web Store listing ($5 one-time); review the permission warnings.

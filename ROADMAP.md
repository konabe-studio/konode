# ROADMAP.md — direction

High-level direction. Granular tasks live in `TODO.md`; what's in flight is in
`SESSION_HANDOFF.md`; shipped history is in `CHANGELOG.md`.

## Vision
A privacy-first browser sync that puts the user's data on storage **they own**
(Google Drive / GitHub / WebDAV), with **no Synkro server** and **no telemetry**.
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
  per-device Restore button; `synkro_remote_sessions` is a device-keyed map so
  sessions aggregate across all peers.
- **Cross-peer data merge for every type** — extensions now aggregate across all
  peers too (`synkro_remote_extensions` is device-keyed; the popup unions the lists),
  so bookmarks, history, sessions and extensions all merge across all devices.
- **Newest-peer ordering** — the engine sorts peers newest-first by packet
  `timestamp` (`orderPeersByTime`), so `peers[0]` (the LWW/manual-conflict baseline)
  is correct on every backend. GitHub/WebDAV list files in arbitrary order; rather
  than per-backend commit/mtime lookups, ordering uses the same clock LWW already
  trusts.
- **Sync-engine + bookmark-merge test coverage** — an in-memory `chrome.bookmarks`
  fake drives `importBookmarks` (merge/replace/tombstone/folders) and
  `SyncEngine.syncType` (pull → fold every peer → push merged) under Vitest.

## Next
1. Pre-publish QA: end-to-end test the **GitHub** and **WebDAV** backends (only
   Drive has been verified across devices so far).

## Later / nice-to-have
- Firefox support (`browser_specific_settings` + the `browser.*` polyfill).
- Mega backend.
- Incremental diff for >10k bookmarks; history sync performance (the full-history
  dedup scan is the current bottleneck on the ~5s sync tail).
- Optional OAuth proxy (serverless) to avoid shipping the Google client secret.

## Before publishing
- OAuth consent screen: app name, logo, **privacy policy URL** (write the policy).
- `drive.file` scope justification + demo video for Google verification.
- Chrome Web Store listing ($5 one-time); review the permission warnings.

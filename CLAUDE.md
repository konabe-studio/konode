# CLAUDE.md — Konode project guide

Context for any AI/dev session picking up this repo. Read this first, then
`SESSION_HANDOFF.md` for the live cursor (what's in flight right now).

## What Konode is

A **Manifest V3 Chrome extension** that syncs browser data to **storage the user
owns** — no Konode server, no telemetry. Works on any Chromium browser (tested on
Brave and Helium; also Chrome, ungoogled-chromium).

- **Data types:** bookmarks, history, sessions (open tabs), installed-extension list.
- **Backends:** Google Drive (OAuth), GitHub (fine-grained PAT), WebDAV (basic auth).
- **Privacy:** optional end-to-end encryption (AES-256-GCM). E2EE is a **conscious
  choice made during onboarding** (default off, but the user picks encrypt-or-not
  explicitly — nothing is silently uploaded behind a hidden default). Credentials
  live only in `chrome.storage.local` on the device.

## Build & run

```bash
npm install          # also refreshes package-lock
npm run type-check   # tsc --noEmit — must be clean before committing
npm run build        # build:ui (vite) + build:sw (vite.sw.config.ts) → dist/
```
Then load `dist/` unpacked at `chrome://extensions` (Developer mode). **After any
rebuild you must click ↻ reload on the extension** — MV3 won't swap a running
service worker automatically.

> The maintainer runs build/type-check/reload manually. Two separate Vite builds:
> the UI (popup/options/onboarding HTML entry points) and the service worker
> (single ES entry, `emptyOutDir:false` so it doesn't wipe the UI build). `public/`
> (manifest + icons) is copied to `dist/` by Vite.

**Firefox build:** `npm run build:firefox` → `dist-firefox/`. Same two Vite builds
with `--outDir dist-firefox`, then `scripts/make-firefox-manifest.mjs` overwrites the
copied Chrome manifest with the Firefox variant (event-page `background.scripts`
instead of `service_worker`, no Chrome `key`, `browser_specific_settings.gecko`).
Runtime APIs are browser-agnostic via `lib/utils/ext.ts` (`webextension-polyfill`),
so the same TS builds for both. Load `dist-firefox/` via `about:debugging` →
"Load Temporary Add-on". **Not yet runtime-verified on Firefox.**

## Architecture

```
src/
├── background/service-worker.ts   MV3 SW: ensureInit, alarms, message router, bookmark listeners
├── popup/        App.tsx + components/AuditLog.tsx   (status, conflict banner, restore, audit log)
├── options/      App.tsx          (backend, data types, device, advanced/E2EE)
├── onboarding/   App.tsx          (first-run wizard)
└── lib/
    ├── types.ts                   all shared types (SyncPacket, BookmarkPayload, Tombstone, messages…)
    ├── backends/  abstract-backend (factory + IBackend) · gdrive · gdrive-oauth (PKCE+refresh) · github · webdav
    ├── handlers/  bookmarks · history · tabs · extensions   (export/import per data type)
    ├── sync/      sync-engine (orchestration, E2EE, conflicts) · conflict-resolver
    ├── crypto/    encryption.ts   (AES-256-GCM, PBKDF2 600k, sha256)
    └── utils/     storage · retry (HttpError + backoff) · logger (audit) · messaging
```

## Sync model (important)

- **Per device, per data type** a file `konode_<type>_<device_id>.json` is written
  to the backend's `Konode` folder. `device_id` is a random UUID per install.
- **Packet** = `SyncPacket { version, device_id, timestamp, data_type, checksum
  (SHA-256 of plaintext), encrypted, payload, verifier? }`. When E2EE is on, `payload`
  is the base64 `salt+iv+ciphertext`; checksum stays over plaintext so identical content
  matches across devices. Checksum (64-char SHA-256) is **required and verified on
  download** before import — a missing/short checksum is rejected. `verifier`
  (present only when encrypted) is a passphrase verifier: on download the engine
  checks the peer's verifier against the local passphrase and throws a
  `PassphraseError` on mismatch — so a mistyped passphrase fails loudly instead of
  silently forking devices into unreadable data.
  **Encryption disagreements are non-fatal and self-healing** (no marker file — the
  group's intent is read from peers' `encrypted` flags): mismatches are recorded as
  per-device warnings in the `syncType` fold and surfaced by `sync()` *after* the
  device uploads its own (correctly-encrypted) file, so the group never deadlocks.
  Three cases: (a) **E2EE on here, peer plaintext** → the peer is **skipped
  silently** — it's usually a stale/orphan file (a removed device's file lingers
  forever) and isn't this device's problem, so it must not warn forever; (b) **E2EE
  off here, peer encrypted** → a non-fatal `EncryptionMismatchError` **nudge** ("enable
  E2EE here") on the device that can actually fix it; (c) **encrypted peer, wrong
  passphrase** → `PassphraseError` (a live, actionable problem). Enabling/rotating
  E2EE clears the upload checksums and the upload record is tagged with the encryption
  form (`enc:`/`plain:`), so a device always re-uploads in the current form and a
  previously-mixed group converges on the next sync.
- **Flow** (`sync-engine.syncType`): pull every peer file (`downloadAll(type,
  ownDeviceId)` excludes our own) → auto-merge each peer in (additive + deletion-
  aware, non-destructive) → push merged, unless strategy is `manual` (queue a
  conflict per diverging peer). The merge always runs — even on a fresh device it
  merges into the empty local tree (safer than a destructive replace, which would
  wipe a new device's existing local bookmarks). The `replace`/`clearAndImport`
  path exists but is not used by the live flow (tests only); a whole-tree overwrite
  is intentionally never triggered automatically.
- **Bookmarks** use a `{ tree, tombstones }` envelope (legacy bare-array still
  accepted). Merge is **additive + deletion-aware**: adds propagate, and deletions
  propagate via **tombstones** (`onRemoved` records `{url, deletedAt}`; merge
  removes peer-tombstoned URLs and won't re-add them; tombstones GC'd after 90
  days). Folder hierarchy is preserved. Safety: a merge whose peer deletions would
  remove more than `settings.bulk_delete_percent` of local bookmarks (**default
  60%**, user-adjustable 50–95% in Settings → Advanced; floor of 20 so small trees
  aren't tripped) is skipped — guards against a corrupt/oversized tombstone log
  wiping the tree, while a normal bulk cleanup up to the threshold still propagates.
- **Bookmark moves** propagate via a URL-keyed move-log (`konode_bm_moves`, LWW) —
  a relocated bookmark follows the winning peer's folder + index. **Folder reorders**
  (a folder repositioned among its siblings) use a separate **path-keyed** move-log
  (`konode_bm_folder_moves`, `FolderMoveRecord { path:[rootKind,…titles], index, at,
  prev?, next? }`, LWW): the merge resolves the path to the local folder and
  repositions it (Step C). Placement is **anchor-based**, not by absolute index — an
  absolute index doesn't translate when the two devices have different device-local
  siblings (the real bug: a folder at index 7 on one browser vs 6 on the other). `prev`/
  `next` are the keys of the siblings on either side at move time (a bookmark → `u:<url>`,
  a folder → `f:<title>`); the receiver places the folder right after `prev` (or before
  `next`), falling back to the absolute `index` only when neither anchor exists locally.
  `moveToIndex` reads back and nudges once to absorb Chromium's same-parent move quirk
  (a downward move lands one slot short; Firefox uses the final-index convention). Only
  pure reorders are recorded; a **cross-parent folder move**
  relocates its bookmarks via the URL move-log and the emptied folder shell is pruned
  on the receiver (Step D — only folders that merge itself emptied). Path resolution
  fails safe. Not handled (by design): folder rename, duplicate sibling titles, and
  relocating a moved folder as a single node (bookmarks move; the folder node doesn't).
- **Conflict strategies** are now **per-item (per URL)**: `lww` (newest action
  wins), `prefer-local`, `prefer-remote`, `manual` (popup banner resolves).
- **History** is additive + de-duped; restore is lossy by design (Chrome can't set
  visit times/counts). **Sessions/extensions** are stored per peer device (keyed by
  `device_id`) for restore/display: the popup lists every peer's session and unions
  every peer's extension list ("missing on this device").

## MV3 lifecycle gotchas (don't regress these)

- The SW is **suspended when idle (~30s)** and recreated on the next event. Every
  entry point (`onAlarm`, `handleMessage`, bookmark debounce, lifecycle) awaits
  **`ensureInit()`** so it never races a not-yet-created `syncEngine`. Symptom if
  broken: "only syncs while the SW DevTools console is open".
- Event listeners are registered **once at top level**, never inside `init()`.
- `chrome.extension.getViews` does **not** exist in an MV3 SW — STATE_UPDATE is
  broadcast unconditionally with `.catch()`.
- **Alarm floor is ~30s** (`periodInMinutes` min 0.5). Periodic pull can't be
  faster; receiving-side latency ≈ up to one interval. Editing device uploads in
  ~1s (debounced fast path + 30s backstop alarm).
- `chrome.identity.getAuthToken` works only on real Chrome — **not** Brave/Helium/
  ungoogled. So Drive uses the **PKCE authorization-code flow** via
  `launchWebAuthFlow` (`lib/backends/gdrive-oauth.ts`): one interactive consent →
  **refresh token**, then access tokens refresh via a plain POST (no UI, no
  browser session). Implicit grant + silent `prompt=none` was tried first and
  fails on Brave (can't reach the Google session). The Web-app `client_secret`
  ships embedded (non-confidential for an installed app; rotatable in the console).

## Storage keys (`chrome.storage.local`)

`konode_settings`, `konode_state`, `konode_audit`, `konode_bm_cache`,
`konode_bm_tombstones`, `konode_bm_moves`, `konode_bm_folder_moves`,
`konode_gdrive_session`, `konode_remote_extensions`,
`konode_remote_sessions`. The last two are **device-keyed maps**
(`{ [device_id]: { device_id, timestamp, session|extensions } }`) — one entry per
peer device, so the popup can list every peer's session and union every peer's
extension list. Legacy single-object shape still read by the normalizers.

## Conventions

- TypeScript strict; `tsc --noEmit` must pass. Match existing file style/idioms.
- `Uint8Array<ArrayBuffer>` (not bare `Uint8Array`) for Web Crypto buffers (TS 5.7+).
- Commit per logical change; conventional-commit style messages.
- The granular task checklist is `TODO.md`; direction is `ROADMAP.md`; history is
  `CHANGELOG.md`.

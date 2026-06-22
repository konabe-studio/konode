# CLAUDE.md — Synkro project guide

Context for any AI/dev session picking up this repo. Read this first, then
`SESSION_HANDOFF.md` for the live cursor (what's in flight right now).

## What Synkro is

A **Manifest V3 Chrome extension** that syncs browser data to **storage the user
owns** — no Synkro server, no telemetry. Works on any Chromium browser (tested on
Brave and Helium; also Chrome, ungoogled-chromium).

- **Data types:** bookmarks, history, sessions (open tabs), installed-extension list.
- **Backends:** Google Drive (OAuth), GitHub (fine-grained PAT), WebDAV (basic auth).
- **Privacy:** optional end-to-end encryption (AES-256-GCM, opt-in); credentials
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

- **Per device, per data type** a file `synkro_<type>_<device_id>.json` is written
  to the backend's `Synkro` folder. `device_id` is a random UUID per install.
- **Packet** = `SyncPacket { version, device_id, timestamp, data_type, checksum
  (SHA-256 of plaintext), encrypted, payload }`. When E2EE is on, `payload` is the
  base64 `salt+iv+ciphertext`; checksum stays over plaintext so identical content
  matches across devices. Checksum is **verified on download** before import.
- **Flow** (`sync-engine.syncType`): pull peer file first (`download(type,
  ownDeviceId)` excludes our own file) → if local empty: replace → else auto-merge
  (pull remote in, push merged) unless strategy is `manual` (queue a conflict).
- **Bookmarks** use a `{ tree, tombstones }` envelope (legacy bare-array still
  accepted). Merge is **additive + deletion-aware**: adds propagate, and deletions
  propagate via **tombstones** (`onRemoved` records `{url, deletedAt}`; merge
  removes peer-tombstoned URLs and won't re-add them; tombstones GC'd after 90
  days). Folder hierarchy is preserved. Safety: a merge that would delete >50% of
  local bookmarks is refused.
- **Conflict strategies** are now **per-item (per URL)**: `lww` (newest action
  wins), `prefer-local`, `prefer-remote`, `manual` (popup banner resolves).
- **History** is additive + de-duped; restore is lossy by design (Chrome can't set
  visit times/counts). **Sessions/extensions** are stored for restore/display only.

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

`synkro_settings`, `synkro_state`, `synkro_audit`, `synkro_bm_cache`,
`synkro_bm_tombstones`, `synkro_gdrive_session`, `synkro_remote_extensions`,
`synkro_remote_sessions`.

## Conventions

- TypeScript strict; `tsc --noEmit` must pass. Match existing file style/idioms.
- `Uint8Array<ArrayBuffer>` (not bare `Uint8Array`) for Web Crypto buffers (TS 5.7+).
- Commit per logical change; conventional-commit style messages.
- The granular task checklist is `TODO.md`; direction is `ROADMAP.md`; history is
  `CHANGELOG.md`.

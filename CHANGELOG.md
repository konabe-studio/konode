# Changelog

All notable changes to Synkro. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); the project is pre-1.0.

## [Unreleased] — 0.1.0

The first working build, hardened over a review + fix pass. Highlights:

### Added
- **End-to-end encryption (opt-in)** — AES-256-GCM + PBKDF2 (600k), wired into the
  sync engine. Toggle + passphrase in Settings → Advanced. Data is encrypted
  before it leaves the device; the storage provider can't read it.
- **WebDAV backend made functional** — requests an `optional_host_permissions`
  grant for the user's server origin at runtime (it couldn't reach arbitrary
  hosts before).
- **Bookmark deletion sync (tombstones)** — deletes now propagate across devices
  instead of resurrecting; folder hierarchy preserved; 90-day tombstone GC; a
  >50% mass-delete is refused as a safety net.
- **Conflict resolution UI** — popup banner (Keep local / Use remote) + a working
  "Manual" strategy; per-item (per-URL) resolution.
- **Session restore** and **extension re-enable** message handlers; audit log
  mounted in the popup with a Clear action.
- Onboarding requests optional permissions for the chosen data types.
- **Session-manager UI** — the popup now lists the open-tab session of **each** peer
  device (name, tab count, last-synced time) with a per-device Restore button,
  instead of a single "Restore tabs from another device" button. Remote sessions are
  stored device-keyed (`synkro_remote_sessions` is now a map), so every peer's
  session survives instead of only the newest. Sessions carry the device label so
  the list is human-readable.
- **Cross-peer extension aggregation** — `synkro_remote_extensions` is now device-keyed
  too; the popup unions every peer's installed-extension list (deduped by id), so
  "missing on this device" reflects extensions installed on **any** other device, not
  just the most recently synced one.

### Changed
- **Sync model**: pull peer file first (excluding our own), then for additive
  data types always merge the peer in and push the merged result — fixes "remote
  changes never arrived" under Last Write Wins.
- **Multi-device merge**: `IBackend.download` → `downloadAll`, returning every
  peer file; the engine folds them all in per sync (oldest→newest) so 3+ devices
  converge in one cycle instead of relying on slow transitive propagation.
  Per-strategy deletion handling stays inside the bookmark merge; prefer-local now
  consistently adds peers' new bookmarks while ignoring their deletions.
- **Newest-peer ordering**: the engine now sorts downloaded peer packets newest-first
  by their `timestamp` (`orderPeersByTime`) before resolving conflicts and folding
  them in. GitHub and WebDAV list files in arbitrary order, so `peers[0]` (the LWW /
  manual-conflict baseline) was previously an arbitrary peer rather than the most
  recent one. Uses the same clock LWW relies on — no per-backend commit/mtime lookups.
- **Near-instant sync-on-change** (~1s debounced fast path) with a 30s backstop
  alarm; periodic pull floor lowered from 60s to Chrome's real 30s minimum.
- Integrity: checksums are now **SHA-256** (was a mislabeled djb2) and **verified
  on download**; payload shape validated before import.
- Retry policy: only transient failures (network, 408/429/5xx via `HttpError`)
  are retried — deterministic 4xx no longer waste attempts.
- Google Drive backend: `res.ok` checks everywhere (no more silent "success" on a
  failed upload); create path uses `multipart/related`; downloads via the
  authenticated GitHub Contents API instead of the unauthenticated `download_url`.
- Permissions: `history`/`tabs`/`management` moved to `optional_permissions`
  (requested on enable); unused `sessions` permission and dead Mega host removed;
  `api.github.com` added.
- Security/UX: fine-grained GitHub token link (single repo) instead of classic
  `repo` scope; WebDAV `http://` warning; honest Drive credential copy; external
  Google Fonts fetch removed (privacy).
- Bookmark merge preserves the remote folder structure (no longer flattened into
  "Other Bookmarks"); replace guards against an empty/malformed remote tree and
  snapshots local first; root matching uses Chrome's stable IDs.

### Fixed
- `type-check` now passes (non-existent `SyncTab` type; `includes("tabs")` against
  a value no longer in `DataType`; `Uint8Array<ArrayBuffer>` for Web Crypto).
- Live popup status (the MV3 `chrome.extension.getViews` broadcast gate was dead).
- **MV3 race**: every entry point awaits `ensureInit()`, so sync works with the
  worker cold — not only while the SW DevTools console is held open.
- Multi-device: `download()` excludes the caller's own file across all backends,
  so a device stops masking its peers.
- `bufferToBase64` RangeError on large encrypted payloads (chunked encoding).

### Removed
- Unused deps (`zustand`, `webextension-polyfill`) and dead components
  (StatusBadge, SyncButton, DataTypeRow).

### Tooling
- **Vitest** suite (encryption, retry policy, conflict resolver, tombstone
  helpers) with an in-memory chrome.* stub; **ESLint** flat config; **GitHub
  Actions CI** (type-check + test on every push). Scripts: `test`, `test:watch`,
  `lint`, `check`.

### Drive OAuth (refresh token)
- Replaced the implicit grant (token died after ~1h, silent re-auth unreliable on
  Brave) with **PKCE authorization-code + refresh token** (new shared module
  `lib/backends/gdrive-oauth.ts`). One interactive consent stores a refresh token;
  access tokens then refresh via a plain POST — no UI, no browser session — so
  background sync survives indefinitely on every Chromium browser. backend +
  options + onboarding share the one implementation.
- _Needs runtime verification (re-sign-in required to mint the first refresh
  token). See `SESSION_HANDOFF.md`._

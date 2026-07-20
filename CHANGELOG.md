# Changelog

All notable changes to Konode. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/).

## [1.0.1] — 2026-07-20

First post-launch patch, from testing the published build on more browsers.

### Fixed
- **Google Drive sign-in on engines without `launchWebAuthFlow`** — on iOS WebKit
  browsers (e.g. Orion) the interactive sign-in either isn't implemented or throws an
  opaque native error (`undefined is not an object (evaluating 'parameters.length')`).
  The Drive option is now feature-gated (hidden behind a "not available in this
  browser — use GitHub or WebDAV" note when the API is absent), and any non-cancel
  sign-in failure surfaces that friendly message instead of the raw engine error.
  iOS / WebKit remains unsupported overall (onboarding also doesn't open there); this
  just keeps the Drive path from dead-ending. GitHub and WebDAV are unaffected.

## [1.0.0] — 2026-07-19

The build submitted to the Chrome Web Store for review (2026-07-19) and **published
2026-07-20** (item `mmlfiiimnpnjcjhhbldenpcmnibedkfa`): E2EE hardened end-to-end,
Firefox supported, the brand applied everywhere, store packaging + releases wired up,
and a round of pre-submission security hardening.

### Security / E2EE hardening
- **Stopped uploading the passphrase verifier** — `encrypt("konode-verify-v1")`
  on third-party storage was an offline brute-force oracle on the passphrase.
  A mismatch now surfaces via the payload's GCM decrypt failure (same loud
  `PassphraseError`); legacy peers' verifiers are still checked on download.
- **Passphrase strength floor** — a new manually-typed E2EE passphrase must be
  ≥12 characters (options + onboarding, with an honest "guessable offline"
  explanation); generated keys and already-saved passphrases are unaffected.
  PRIVACY.md and the README now document the offline-guessing threat model.
- **E2EE mixed-state self-healing** — encryption disagreements between devices
  no longer hard-abort or deadlock the group: the device uploads its own
  (correctly-encrypted) file first, mismatches are per-device warnings, an
  orphaned plaintext file is skipped silently instead of warning forever, and
  enabling/rotating E2EE forces a re-upload in the new form so a mixed group
  converges in one cycle.
- **No plaintext downgrade paths** — a device with E2EE off no longer decrypts
  encrypted peers (it gets an "enable E2EE here" nudge instead of silently
  re-publishing the group's data in plaintext), and a manual conflict-resolve
  can't import a plaintext packet into an encrypted device.
- **Passphrase UX** — double-entry confirm for new passphrases (options +
  onboarding), content-free saved-secret masking, reveal-on-demand eye,
  explicit confirmation before turning E2EE off.
- **Leaked OAuth client retired** — the Google OAuth client secret briefly
  committed to source now lives in a gitignored `.env` and is injected at build
  time (`VITE_GOOGLE_CLIENT_SECRET`); the exposed client was deleted in the
  Google Cloud Console and replaced with a fresh one.
- **Peer extension `storeUrl` rebuilt locally** — the popup/options opened a peer's
  synced `storeUrl` verbatim; with E2EE off, anyone with backend write access could
  forge it and point "Install" at a phishing page. It is now reconstructed from the
  extension id, pinning the host to the Web Store.
- **`management` is strictly read-only** — dropped the dead `SET_EXTENSION_ENABLED`
  handler (no UI ever sent it), so the code matches the read-only permission
  justification and PRIVACY.md.

### Added
- **Firefox support** — runtime APIs routed through `webextension-polyfill`,
  browser-agnostic bookmark-root resolution (Chrome `1/2/3` ⇄ Firefox
  `toolbar_____`/`menu________`/`unfiled_____` by kind), a Firefox manifest
  variant (`npm run build:firefox` → `dist-firefox/`, event-page background,
  gecko id `konode@konode.org`, `data_collection_permissions: none`), web-ext
  packaging + lint, and a per-browser OAuth redirect. Runtime-verified on
  Waterfox 140 (onboarding, Drive OAuth, sync, session restore, history).
- **Folder reorder sync** — a folder repositioned among its siblings propagates
  via a path-keyed move-log with **anchor-based** placement (lands next to the
  same neighbor on every device, not at a raw index that doesn't translate);
  cross-parent folder moves relocate their bookmarks and the emptied shell is
  pruned on the receiver.
- **Configurable mass-delete guard** — the bookmark bulk-delete safety cap is a
  setting (default 60%, 50–95% in Settings → Advanced) instead of a hard 50%,
  so a legitimate bulk cleanup propagates while a corrupt tombstone log still
  can't wipe a tree.
- **Per-device sessions & extensions everywhere** — the popup lists every peer
  device's session with per-device restore, and unions every peer's extension
  list.
- **Brand** — peer-mesh logo mark, reproducible icon generation, full UI
  re-skin (popup, options, onboarding) with system light/dark, self-hosted
  fonts, and the Proton-Pass-style top-tab settings layout.
- **Docs for launch** — marketing README with screenshot, GETTING_STARTED,
  TROUBLESHOOTING, PRIVACY.md (near-final), STORE_LISTING.md (CWS listing +
  OAuth consent copy), MPL-2.0 LICENSE, build-fingerprint verification script
  (`npm run checksum`).

### Fixed
- **Move-to-last-position convergence** — Chromium's same-parent move quirk
  (an index measured against the pre-removal array) made "move to the end"
  land one slot short forever; the corrective nudge now clamps to the child
  count so it actually reaches the last slot.
- **Cross-root move safety** — a peer root that can't be confidently mapped
  (e.g. an older build's foreign id) can no longer yank an existing bookmark
  into the default root.
- **Duplicate-URL deletion safety** — deleting one of several identical-URL
  bookmarks no longer tombstones (deletes) the URL on every peer.
- **Audit backlog cleared** (4-agent review, 2026-07-07): sticky manual
  conflict resolutions (no more re-notify loop), the sync-lock race, backend
  list errors no longer masquerade as "no peers", export works without the
  history permission, SecretField renders the generated key.
- **Onboarding permission request** — the WebDAV server origin and the optional
  data-type permissions are now requested in a single `permissions.request` call; a
  second call after an `await` could be rejected for lacking a user gesture,
  stranding WebDAV users who also enabled a data type.

### Tooling
- CI now **enforces** lint (`continue-on-error` removed), runs `npm ci` from
  the committed lockfile, and `eslint-plugin-react-hooks` is wired in
  (rules-of-hooks as an error, exhaustive-deps advisory).
- Single-source version (`scripts/sync-version.mjs` stamps the manifests from
  `package.json`).
- **Chrome Web Store packaging** — `npm run package:chrome` builds, then zips a
  staging copy of `dist/` with the manifest `key` removed (the CWS rejects `key` on
  a first upload) while `dist/` keeps it for unpacked-dev ID stability.
- **Release workflow** — pushing a `v*` tag builds and publishes a GitHub release
  with the packaged Chrome zip (source build, no client secret); v1.0.0 released.

## [0.1.0]

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
  stored device-keyed (`konode_remote_sessions` is now a map), so every peer's
  session survives instead of only the newest. Sessions carry the device label so
  the list is human-readable.
- **Cross-peer extension aggregation** — `konode_remote_extensions` is now device-keyed
  too; the popup unions every peer's installed-extension list (deduped by id), so
  "missing on this device" reflects extensions installed on **any** other device, not
  just the most recently synced one.

### Changed
- **Saved secrets are masked in Settings**: once a token / WebDAV password / E2EE
  passphrase is saved, the field shows a `••••••` summary (last 4 chars) instead of
  binding the raw value into the DOM — a "Replace" action re-enters edit mode. The
  reveal (eye) toggle is now per-field, so unmasking one secret no longer unmasks the
  others. (A `type="password"` field always exposes its value in the DOM; this keeps
  the saved secret out of casual inspection / screenshots / screen-sharing. Note:
  credentials are still stored in `chrome.storage.local` — the standard extension
  model, since there's no OS secret store.)
- **GitHub upload 409 fixed at the root**: GitHub sends `Cache-Control: max-age=60`
  on contents reads, so the browser HTTP cache returned a *stale* SHA for up to a
  minute after a write — every PUT (and every retry) then 409'd with "…does not
  match". All backend reads (GitHub, WebDAV, Drive) now use `cache: "no-store"` so a
  peer file / SHA is always fresh; the GitHub SHA is re-read on each attempt and a 409
  is retried with exponential backoff (up to 5 attempts).
- **No redundant uploads**: each data type now records the checksum it last uploaded
  and skips the upload when nothing changed — so a sync that finds nothing new no
  longer writes a fresh commit every interval (which also removed the main 409
  trigger). Made the bookmark payload deterministic (a missing `dateAdded`, e.g. on
  the root node, now falls back to `0` instead of `Date.now()`) so an unchanged tree
  hashes identically across syncs and devices.
- **Resilient downloads**: a single corrupt or partially-written remote file (e.g.
  trailing bytes after the JSON — "Unexpected non-whitespace character after JSON")
  no longer aborts the whole sync. Each backend skips a file it can't parse, and the
  engine skips any peer whose file fails to apply (parse / checksum / import), folding
  in the rest. The owning device rewrites its file cleanly on the next sync.
- **Forgiving GitHub repository field**: the backend now normalizes the Repository
  value to an `owner/repo` slug (`normalizeRepoSlug`), accepting a pasted
  `https://github.com/owner/repo` URL, a `.git` suffix, a trailing slash, or the
  `git@github.com:` SSH form — previously these produced a confusing "repository not
  found" because the GitHub API 404s on a full URL or a trailing slash.
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
- **Bookmark moves now propagate.** The URL-keyed merge ignored a bookmark's
  folder, so moving one between folders didn't sync. Added a per-URL move log
  (`konode_bm_moves`, recorded on `onMoved`) carried in the payload; the merge
  relocates a locally-present bookmark to the peer's folder with last-write-wins
  (prefer-local keeps local placement; prefer-remote always adopts the peer's).
  The merge also passes the **position/index** from the peer's tree to
  create/move, so a moved or added bookmark lands at the peer's spot instead of
  always at the end of the folder.
- **Empty folders no longer resurrect.** Folders carry no tombstone (those are
  URL-keyed), so a deleted folder's bookmarks were removed but the empty folder
  synced back from a peer. Now the merge creates folders lazily (only when a
  descendant bookmark is actually added) and empty folders are pruned from the
  synced payload — so deleting a folder propagates fully.
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
  helpers, remote-session/extension normalizers, peer ordering, **bookmark merge +
  `SyncEngine.syncType`**) with an in-memory `chrome.storage` + `chrome.bookmarks`
  stub; **ESLint** flat config; **GitHub Actions CI** (type-check + test on every
  push). Scripts: `test`, `test:watch`, `lint`, `check`.

### Drive OAuth (refresh token)
- Replaced the implicit grant (token died after ~1h, silent re-auth unreliable on
  Brave) with **PKCE authorization-code + refresh token** (new shared module
  `lib/backends/gdrive-oauth.ts`). One interactive consent stores a refresh token;
  access tokens then refresh via a plain POST — no UI, no browser session — so
  background sync survives indefinitely on every Chromium browser. backend +
  options + onboarding share the one implementation.
- _Needs runtime verification (re-sign-in required to mint the first refresh
  token). See `SESSION_HANDOFF.md`._

### UI / brand re-skin
- **Popup re-skinned** to a system-following light/dark theme (new `sk-*` design
  tokens; opts in via a `.sk-body` class). Content-fit height with a pinned
  header + a single scrolling body, so the audit log grows the popup instead of
  pushing the header off the top at Chrome's ~600px ceiling; the leftover black
  strip after toggling the audit log is gone. Active streams became a 4-circle
  icon grid (green = OK, amber spinner = syncing) and the wordmark header was
  dropped (settings moved into the status row).
- **Options + onboarding re-skinned** to the same palette — accent moved from
  Google blue to the signal green, with light/dark surfaces, borders and focus
  rings retuned. Fixed green-on-green contrast where the selected-card tint and
  the icon chips were the same pale green (account avatar, Disconnect button,
  selected backend icon, sidebar/onboarding logo).
- **Self-hosted fonts** — Inter + JetBrains Mono (latin-subset woff2, OFL) bundled
  under `public/fonts`, wired via `@font-face`; the external Google Fonts fetch is
  gone for good and DM Sans is no longer referenced. Nothing leaves the device.

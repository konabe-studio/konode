# Synkro — TODO & Roadmap

> Last updated: 2026-06-19

---

## ✅ Done

- [x] Google OAuth client ID + Drive backend
- [x] GitHub PAT auth + backend
- [x] WebDAV backend (reachable via optional host permission)
- [x] **Sync flow** — pull-first (download → merge → upload); fresh-device guard
- [x] **Onboarding** — first-run wizard (backend + auth + data types)
- [x] **Import / Export** — JSON file backup in Settings → Advanced
- [x] **E2EE** — AES-256-GCM wired into the sync engine, opt-in via Settings
- [x] **Conflict UI** — popup banner resolves queued conflicts (Manual strategy)
- [x] **History sync** — with de-dup (note: Chrome can't restore visit times/counts)
- [x] **Extensions sync** — list + "missing on this device" surfacing
- [x] Session restore (open tabs from another device)
- [x] SHA-256 checksums, verified on download
- [x] Optional permissions for history/tabs/management
- [x] Live popup status (fixed the MV3 broadcast), keyboard-operable setup UI

---

## 🔜 Next

- [x] **OAuth refresh (Drive)** — PKCE auth-code + refresh token
      (`lib/backends/gdrive-oauth.ts`). Background sync renews silently past the
      ~1h expiry on every Chromium browser. (Silent re-auth via prompt=none was
      tried first and failed on Brave.) _Needs runtime verification — re-sign-in
      required to mint the first refresh token._
- [x] Bookmark deletion sync (tombstones); near-instant sync-on-change; 30s pull
      floor; SW ensureInit so sync works with the worker cold.
- [x] **True multi-device merge** — `IBackend.downloadAll()` returns every peer
      file; the engine folds them all in per sync (oldest→newest), so 3+ devices
      converge in one cycle. Per-strategy deletion handling lives in the bookmark
      merge. (Cost scales with device count — N peer fetches per data type/sync.)
- [x] **Session manager UI** — popup lists each peer device's session (name, tab
      count, last-synced) with a per-device Restore button. `synkro_remote_sessions`
      is now a device-keyed map, so every peer's session survives (sessions now
      aggregate across all peers, not newest-peer-wins).
- [x] Aggregate **extensions** across *all* peers — `synkro_remote_extensions` is a
      device-keyed map; the popup unions every peer's list (deduped by id). All four
      data types now merge across all peers.
- [ ] Backend "newest version" selection on GitHub/WebDAV (needs commit/mtime, not list order)
- [x] **Tests + lint + CI** — Vitest (encryption, retry, conflict resolver,
      tombstone helpers) + ESLint flat config + GitHub Actions CI. _Run
      `npm install` once to pull the new devDeps and regenerate the lockfile,
      then confirm `npm run test` / CI is green._

---

## 🔒 Security / E2EE hardening (pre-launch, do in order)

Found during post-build QA of the E2EE settings UI.

- [x] **1 — Don't reveal the passphrase's last 4 chars.** `SecretField` shows a
      `••••last4` summary; fine for API tokens / WebDAV password (rotatable), but for
      the **E2EE passphrase** it leaks the ending, character classes, and (via dot
      count) the length — a screenshot / shoulder-surf disclosure. Unlike a token, the
      passphrase can't be cheaply rotated (rotating = re-encrypt + re-key every device).
      Fix: for the passphrase field use a content-free indicator (`Set ✓` / fixed dot
      count, not real length) + the reveal-eye on demand. Leave token/password fields
      as-is.
- [x] **2 — Confirm passphrase on entry (double-entry).** A mistyped passphrase
      makes E2EE data unrecoverable, and every device must match. Today the `verifier`
      only catches a mismatch on a *second* device *after* upload — the first device
      happily encrypts everything with the typo. Add a set-time confirm field (or
      reveal-before-save) in options + onboarding E2EE blocks. ("Generate a strong key"
      is typo-free; manual entry is not.)
- [x] **3 — Handle the E2EE on/off asymmetry across devices.** If device A has E2EE
      on and B has it off: A reads B's plaintext and merges it, then re-uploads
      encrypted — so B's data sits **unencrypted** on the backend (privacy promise
      broken), while B throws `PassphraseError` every cycle reading A and never
      converges. No "should be encrypted" signal exists, so B silently accepts
      plaintext. First cut surfaced `EncryptionMismatchError`; QA found it **hard-
      aborted before upload → deadlock** (see #4).
- [x] **4 — Fix the E2EE mixed-state deadlock (found in #3 QA).** Two bugs combined
      so two devices with the *same* passphrase still each reported the other as
      plaintext forever: (a) `uploadIfChanged` keys only on the *plaintext* checksum,
      so enabling E2EE never re-uploaded the device's own file encrypted; (b) the
      mismatch **threw and aborted the sync before the upload**, so no device ever
      replaced its stale plaintext file. Fix: `updateSettings` clears the upload
      checksums on any encryption/passphrase change (forces a re-upload in the new
      form); the mismatch is now **non-fatal** — skip merging that peer, record a
      per-device warning, keep folding the rest, and **still upload our own** file,
      surfaced by `sync()` as a visible (self-healing) warning. Group converges within
      a cycle once every device uses the same setting + passphrase.
      _Optional later:_ an `e2ee_expected` folder marker for group consensus + a
      clearer "this group is encrypted" message and central passphrase-mismatch check.
- [x] **5 — Peek a saved passphrase (reveal eye).** After save + reload the field
      only offered Replace (pencil) — no way to view the stored passphrase without
      overwriting it. Added a reveal (eye) toggle to the saved-secret summary; the
      default stays content-free (per #1), revealed on demand.
- [x] **6 — Confirm before turning E2EE OFF.** Disabling encryption is a downgrade
      (next sync re-uploads unencrypted). The toggle now requires an explicit
      Cancel / Turn-off confirmation instead of flipping on a stray click.

---

## 🧭 Later / Nice-to-have

- [ ] Firefox support (browser_specific_settings + polyfill)
- [ ] Mega backend
- [ ] Incremental bookmark diff for >10k bookmarks
- [ ] Audit log export, keyboard shortcuts
- [ ] Populate `bytes_transferred` (currently unused)
- [ ] **BuyMeACoffee donate button** in Settings — plain external link only (no
      BMC embed script/iframe; that would load third-party JS and break the
      privacy-first, no-external-request stance). Keep it subtle.

---

## 📦 Before publishing (Google OAuth verification + Chrome Web Store)

- [x] **Test GitHub sync end-to-end** (fine-grained PAT) — two-way sync verified
      (fixed a repo-URL parse + a stale-SHA 409 along the way)
- [x] **Test WebDAV sync end-to-end** (basic auth) — verified on pCloud (free tier):
      `synkro/` folder + files appear, two-way sync works
- [~] **Privacy policy** — first draft written (`PRIVACY.md`); fill the
      `[BRACKETED]` placeholders (publisher, contact email, date), have it reviewed,
      then host it at a public URL (e.g. GitHub Pages or the studio site)
- [~] Consent screen: app name, logo, **privacy policy URL** — copy drafted in
      `STORE_LISTING.md`; needs the hosted policy URL + contact email, then fill in
      the Cloud Console
- [x] `drive.file` scope justification — drafted in `STORE_LISTING.md`
- [~] **Chrome Web Store listing copy** — name, summary, description, category,
      single-purpose, and per-permission justifications drafted in `STORE_LISTING.md`
      (remaining: screenshots, $5 registration, submit)
- [ ] Demo video (1–3 min screencast)
- [ ] Verification request (1–4 weeks, free)
- [ ] Chrome Web Store listing ($5 one-time)

---

## 🎨 Brand & UI refresh (final pre-launch polish)

The functionality is done; the last step before launch is making it *look*
intentional — so the UI doesn't read as generic / AI-generated. Build on a single
brand concept (`BRAND.md`) and apply it everywhere.

- [ ] **Brand concept** — positioning, personality, logo direction, color palette,
      typography, voice, anti-"AI-slop" principles (see `BRAND.md`)
- [ ] **Logo** — wordmark + mark + app icons (16 / 32 / 48 / 128)
- [ ] **Brand guidelines** — the system, with do/don't
- [x] **UI pass** — popup, options **and** onboarding re-skinned to the new design
      system with system light/dark (`sk-*` tokens, signal-green accent, pulse;
      noise/glow/DM Sans removed). Popup: active-streams icon grid, content-fit
      height with a pinned header, wordmark dropped. Fonts (Inter + JetBrains Mono)
      now **self-hosted** — no external Google Fonts fetch.
- [ ] **Website** (privacy-first story, backends, open source)
- [ ] **Pitch deck**

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

## 🧭 Later / Nice-to-have

- [ ] Firefox support (browser_specific_settings + polyfill)
- [ ] Mega backend
- [ ] Incremental bookmark diff for >10k bookmarks
- [ ] Audit log export, keyboard shortcuts
- [ ] Populate `bytes_transferred` (currently unused)

---

## 📦 Before publishing (Google OAuth verification + Chrome Web Store)

- [ ] **Test GitHub sync end-to-end** (fine-grained PAT) — only the Drive backend
      has had real multi-device testing so far
- [ ] **Test WebDAV sync end-to-end** (basic auth + runtime host permission) — ditto;
      only Drive is verified
- [ ] Consent screen: app name, logo, **privacy policy URL** (write the policy first)
- [ ] `drive.file` scope justification
- [ ] Demo video (1–3 min screencast)
- [ ] Verification request (1–4 weeks, free)
- [ ] Chrome Web Store listing ($5 one-time)

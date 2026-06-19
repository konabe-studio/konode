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

- [ ] **True multi-device merge** — fold *all* peer files, not just the newest one
      (download() now excludes our own file; the engine still compares against a single peer)
- [ ] **OAuth refresh** — replace the Drive implicit grant with getAuthToken / auth-code + PKCE
      so background sync survives past the ~1h token expiry
- [ ] **Session manager UI** — list/restore named sessions (engine + storage already support it)
- [ ] Backend "newest version" selection on GitHub/WebDAV (needs commit/mtime, not list order)
- [ ] Tests + lint + CI (none yet)

---

## 🧭 Later / Nice-to-have

- [ ] Firefox support (browser_specific_settings + polyfill)
- [ ] Mega backend
- [ ] Incremental bookmark diff for >10k bookmarks
- [ ] Audit log export, keyboard shortcuts
- [ ] Populate `bytes_transferred` (currently unused)

---

## 📦 Before publishing (Google OAuth verification + Chrome Web Store)

- [ ] Consent screen: app name, logo, **privacy policy URL** (write the policy first)
- [ ] `drive.file` scope justification
- [ ] Demo video (1–3 min screencast)
- [ ] Verification request (1–4 weeks, free)
- [ ] Chrome Web Store listing ($5 one-time)

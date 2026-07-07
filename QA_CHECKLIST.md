# Synkro — manual QA checklist (Sprint E–G)

Runtime verification for the audit-fix work (E2EE hardening, backend guards,
lifecycle, dead-code sweep, token unification). Automated coverage is green
(`npm run type-check` + `npm run test` = 85 tests + build); this covers what only
shows up in a real browser and across devices.

> Two Chromium profiles/devices help — call them **A** and **B**. Use the same
> backend (a throwaway GitHub private repo or WebDAV is easiest for inspecting the
> raw files). After every rebuild: `chrome://extensions` → **↻ reload**.

## 0. Setup
- [ ] `npm install && npm run type-check && npm run test && npm run build` all clean
- [ ] Load `dist/` unpacked on A and B (Developer mode)
- [ ] No console errors when opening popup / options / onboarding

## A. Encryption (biggest changed area — C1, conscious choice, verifier)
- [ ] Onboarding shows the **"Encrypt your data?"** step; default is OFF
- [ ] Choose **encrypt** → passphrase field is **masked** with a working eye toggle
- [ ] **Generate a strong key** → key is revealed so you can copy it; confirm field appears
- [ ] Finish with encryption ON → backend files are **ciphertext** (open one and check)
- [ ] Fresh setup choosing **no encryption** → finishes; backend files are readable JSON
- [ ] A & B, **same passphrase** → bookmarks sync both ways
- [ ] A & B, **different passphrase** → a **visible error** ("passphrase doesn't match…"), NOT silent success
- [ ] Options: toggle E2EE **on without a passphrase** → warning shown; sensitive data not uploaded plaintext
- [ ] Options: **disabling E2EE** requires the confirm dialog; the saved passphrase shows a content-free mask (no length/tail), reveal works

### C1 — E2EE downgrade (the key round-2 fix)
- [ ] A & B both E2EE ON and converged
- [ ] Turn E2EE **OFF on A** (confirm) → A re-uploads its file as **plaintext** (verify on backend), no orphan/duplicate file
- [ ] A shows a **visible nudge** that other devices are still encrypted (NOT a silent "success")
- [ ] B (still encrypted) does **not** merge A's plaintext file (no silent absorb)
- [ ] Turn E2EE off on B too (same passphrase cleared everywhere) → the two converge again
- [ ] Re-enable E2EE on both → files become ciphertext again (self-heal, no manual re-save needed)

## B. Bookmarks, folders & tombstones
- [ ] Add a bookmark on A → appears on B (edit device ~1s; receiver up to one interval)
- [ ] Delete a **bookmark** on A → removed on B, does not resurrect on the next cycle
- [ ] Delete a **folder with bookmarks** on A → folder + contents gone on B, no resurrection
- [ ] **Edit a bookmark's URL** on A → B shows the new URL only, **no duplicate** of the old one
- [ ] **Move** a bookmark between folders on A → the move reflects on B
- [ ] (If 3 devices) move the same bookmark on B and C → converges to the newest move, single copy

## C. Backends & guards
- [ ] **WebDAV https://** → connects & syncs
- [ ] **WebDAV http://** (non-localhost) → **rejected** with a clear message
- [ ] **WebDAV http://localhost** (if you have one) → allowed
- [ ] **GitHub private repo** → connects & syncs
- [ ] **GitHub public repo** → **refused** with a clear message
- [ ] **Google Drive** → sign in, sync; force a token refresh (set the stored session `expires_at=0`) → refreshes with no popup
- [ ] Backup **export** with history/extensions **not enabled** → still exports bookmarks (no "Failed")
- [ ] Backup **import** of a file containing a `javascript:`/`data:` bookmark → that entry is **skipped**, not created

## D. Data types & permissions (PR-6)
- [ ] Fresh onboarding → **only Bookmarks** is pre-checked (extensions NOT default-on)
- [ ] Enabling **history / sessions / extensions** triggers the permission prompt at that moment
- [ ] **Sessions:** restore a peer's tabs from the popup
- [ ] **Extensions:** the "missing on this device" list populates in **both** the popup and the **options** page

## E. UI / theme (token unification — verify visually, can't be auto-tested)
- [ ] **Popup** in light AND dark (OS theme) — colors, layout, spacing intact
- [ ] **Options** in light AND dark — sidebar, cards, toggles, accents intact
- [ ] **Onboarding** in light AND dark — colors/accents intact
- [ ] No unstyled flash or wrong-theme flicker on open

## F. Lifecycle & reliability (C2, CO-4)
- [ ] **Sync now** → badge goes syncing → success; never sticks on "syncing"
- [ ] Leave the browser idle a few minutes, then change a bookmark → still syncs (SW woke from cold)
- [ ] Interrupt/close during a sync, reopen → no permanently stuck "syncing" badge
- [ ] **Audit log** (popup): shows recent events; **no account email / raw URLs** in the detail (PR-L2); "Clear" empties it

## G. Conflicts
- [ ] Set strategy to **Manual**, diverge two peers → a conflict banner appears; resolving local/remote works
- [ ] With 3 peers diverging on manual → a banner per peer (not just the newest)

---

### Notes / findings
_(record anything that misbehaves here, with the step letter)_

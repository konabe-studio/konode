# Konode — store listing & OAuth consent copy

Everything the Chrome Web Store submission and the Google OAuth consent screen
need, in one place. Items marked `[FILL]` are maintainer actions.

> Recreated 2026-07-16 — the original draft referenced by `TODO.md` was never
> committed. Every claim below is checked against `public/manifest.json` and the
> code as of this commit.

---

## Chrome Web Store — listing

**Name:** Konode

**Summary** (≤132 chars):

> Sync bookmarks, tabs, history, and extensions to storage you own — Google
> Drive, GitHub, or WebDAV. Optional encryption.

(120 characters.)

**Category:** Productivity → Tools

**Language:** English (US)

**Description:**

> Konode syncs your browser data to storage **you** own. There is no Konode
> server and no account to create — your bookmarks go straight from your browser
> to your Google Drive, a GitHub repository, or any WebDAV server (Nextcloud,
> Synology, pCloud, and more).
>
> **What it syncs**
> - Bookmarks — full folder structure, adds, deletes, moves, and reorders
> - Open tabs — save your session and restore another device's tabs
> - History — a synced, de-duplicated list
> - Extensions — see which extensions are missing on this device
>
> Bookmarks sync on their own; history, tabs, and the extension list are
> optional and each one asks for its permission only when you turn it on.
>
> **Private by design**
> - No Konode servers. Your data travels only between your browser and the
>   storage backend you configure.
> - No telemetry, no analytics, no tracking of any kind.
> - Optional end-to-end encryption (AES-256-GCM). You choose during setup —
>   nothing is uploaded until you've decided. With encryption on, your storage
>   provider can't read your data.
> - Credentials stay on your device, in the browser's extension storage.
> - Open source (MPL-2.0): https://github.com/konabe-studio/konode
>
> **Works on your browser**
> Chrome, Brave, Helium, ungoogled-chromium — Google Drive sign-in works on all
> of them, not just Chrome. A Firefox version is available too.
>
> **How it works**
> Each device writes its own sync file to a `Konode` folder on your backend and
> merges every other device's file — additively and deletion-aware, so 3+
> devices converge without a central server. Conflicts can be resolved
> newest-wins, prefer-local, prefer-remote, or manually from the popup.

**Single-purpose statement** (CWS requires one purpose):

> Konode's single purpose is synchronizing the user's browser data (bookmarks,
> open tabs, history, extension list) to a storage backend the user owns.

**Privacy policy URL:** `[FILL — see PRIVACY.md hosting note below]`

**Support/homepage URL:** https://github.com/konabe-studio/konode

**Remote code:** No. All code ships in the package; the CSP is
`script-src 'self'; object-src 'none'` and nothing is fetched or eval'd.

### Data-usage disclosures (CWS "Privacy practices" tab)

- Collected by the developer: **nothing**. Konode has no servers; no data is
  transmitted to the developer.
- Data handled locally / sent only to the user's own configured backend:
  bookmarks, browsing history (optional), open tabs (optional), installed
  extension list (optional), authentication credentials for the user's backend.
- Not sold, not transferred to third parties, not used for ads or
  creditworthiness — no data leaves the user's control.

### Permission justifications (one per manifest entry)

**Required permissions:**

| Permission | Justification |
|---|---|
| `bookmarks` | Core function: read the bookmark tree to sync it, and apply adds/deletes/moves coming from the user's other devices. |
| `storage` | Stores settings, backend credentials, sync state, and the local audit log on the device. Nothing is synced through it. |
| `identity` | `launchWebAuthFlow` for the Google Drive OAuth sign-in (authorization-code + PKCE). Used only when the user picks the Drive backend. |
| `alarms` | Periodic background sync in an MV3 service worker (which is suspended when idle — alarms are the only reliable scheduler). |
| `notifications` | Notifies the user of sync conflicts awaiting manual resolution and of sync errors that need attention. No promotional use. |
| `unlimitedStorage` | Large bookmark trees plus per-peer session/extension snapshots can exceed the 10 MB `storage.local` quota on multi-device setups. |

**Optional permissions** (requested at runtime, only when the user enables the
matching data type):

| Permission | Justification |
|---|---|
| `history` | Only if the user turns on history sync: read history to upload it, add entries coming from other devices. |
| `tabs` | Only if the user turns on session sync: read open tabs' URLs/titles to save the session and restore a peer device's session. |
| `management` | Only if the user turns on extension-list sync: read-only list of installed extensions ("missing on this device" view). Konode never installs, removes, or disables anything. |

**Host permissions (required):** `https://www.googleapis.com/*`,
`https://oauth2.googleapis.com/*`, `https://accounts.google.com/*` — the Google
Drive backend (OAuth token exchange + Drive API); `https://api.github.com/*` —
the GitHub backend. Requests go only to the backend the user actively selects.

**Optional host permissions:** `https://*/*` (plus `http://localhost/*`,
`http://127.0.0.1/*` for self-hosted servers) — the WebDAV backend must reach a
server whose address only the user knows. The broad pattern is **optional**: it
is requested at runtime, scoped in practice to the origin the user typed, and
only when the user configures WebDAV. Users who use Drive or GitHub are never
asked for it.

### Submission checklist

- [ ] Screenshots, 1280×800: popup (status + streams), options (backend +
      E2EE), onboarding (backend choice), popup (session restore). `docs/popup.png`
      exists; retake at store resolution.
- [ ] Small promo tile 440×280 (reuse the mesh mark on `--bg`, per `BRAND.md`).
- [ ] $5 developer registration.
- [ ] Privacy policy hosted at a public URL and linked in the listing AND the
      consent screen.
- [ ] Demo video (optional for listing, helpful for OAuth verification).

---

## Google OAuth consent screen (Cloud Console)

- **App name:** Konode
- **User support email:** `[FILL]`
- **App logo:** `public/icons/icon128.png`
- **App domain / homepage:** `[FILL — see hosting note]`
- **Privacy policy URL:** `[FILL — must be on an authorized domain]`
- **Authorized domain:** `[FILL]`
- **Developer contact:** `[FILL]`
- **Scopes:** `https://www.googleapis.com/auth/drive.file` only (non-sensitive).

### Privacy-policy hosting note

Two different bars apply:

- **Chrome Web Store listing:** any publicly reachable URL is accepted — a
  GitHub link works here.
- **Google OAuth consent screen / brand verification:** the privacy policy must
  live on the **same domain as the app's homepage**, and that domain must be an
  **authorized domain** whose ownership is verified in Google Search Console.
  `github.com` can't be verified as yours, and Google has rejected shared-host
  subdomains (`*.github.io`) as not first-party in verification reviews — even
  when technically verifiable in Search Console. Use a domain you own (the
  Firefox gecko id already assumes `konode.org`) and host the homepage +
  privacy policy there.

Note: `drive.file` is a **non-sensitive** scope, so the heavyweight
sensitive-scope review doesn't apply — but brand verification (showing the
Konode name + logo on the consent screen instead of a bare domain) still
requires the authorized-domain setup above.

### `drive.file` scope justification

> Konode stores the user's browser-sync files (bookmarks, and optionally
> history, open tabs, and the extension list — as JSON, optionally end-to-end
> encrypted) in a "Konode" folder in the user's own Google Drive, and reads
> those same files back to sync the user's other devices. `drive.file` grants
> access only to files the app itself creates, which is exactly Konode's need:
> it cannot and does not read any other Drive content. No broader scope is
> requested. Data is used solely at the user's direction to provide sync;
> nothing is transferred to the developer or any third party (see the Limited
> Use commitment in the privacy policy).

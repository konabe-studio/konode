# Konode

> Privacy-first browser sync to your own storage — no middlemen, no telemetry.

Konode is a Manifest V3 Chrome extension that syncs your browser data (bookmarks, sessions, history, installed-extension list) to storage you control. Supports **Google Drive**, **GitHub**, and **WebDAV**.

---

## Features

- **Bookmarks** — two-way sync that preserves your folder structure
- **Sessions** — save the current tab set and restore it on another device
- **History** — sync recent history with a configurable day limit *(restore is best-effort: Chrome can't restore original visit times)*
- **Installed extensions** — sync the list and surface what's missing on each device
- **Conflict resolution** — Last Write Wins, Prefer Local, Prefer Remote, or Manual (resolve from the popup)
- **Zero telemetry** — no Konode server, no analytics; data goes only to the storage you choose
- **E2EE** — optional AES-256-GCM encryption: turn it on in Settings → Advanced and your data is encrypted before it leaves the device

---

## Backends

| Backend      | Status       | Notes                                          |
|--------------|--------------|------------------------------------------------|
| Google Drive | ✅ Supported  | OAuth via Chrome Identity API (`drive.file`)   |
| GitHub       | ✅ Supported  | Fine-grained token, single private repo        |
| WebDAV       | ✅ Supported  | Nextcloud, ownCloud, Synology, pCloud, kDrive  |
| Mega         | 🔜 Planned   | Requires megajs + Node polyfills               |

---

## Stack

- **Manifest V3** (service worker background)
- **React 18** + **TypeScript** (popup, options, onboarding)
- **Vite** — manual multi-page build (popup/options/onboarding) plus a separate service-worker build (`vite.sw.config.ts`)
- **Tailwind CSS v3** (custom dark design system)
- **Web Crypto API** — AES-256-GCM E2EE

---

## Project Structure

```
konode/
├── manifest.json
├── popup.html
├── options.html
├── src/
│   ├── background/
│   │   └── service-worker.ts      ← alarm polling, listener hub, message router
│   ├── popup/
│   │   ├── App.tsx                ← sync status, conflict resolution, quick actions
│   │   └── components/
│   │       └── AuditLog.tsx
│   ├── options/
│   │   └── App.tsx                ← full settings: backend, data types, device, advanced
│   ├── onboarding/
│   │   └── App.tsx                ← first-run wizard: backend + auth + data types
│   └── lib/
│       ├── types.ts               ← all shared types
│       ├── backends/
│       │   ├── abstract-backend.ts   ← factory + IBackend interface
│       │   ├── gdrive-backend.ts
│       │   ├── github-backend.ts
│       │   └── webdav-backend.ts
│       ├── handlers/
│       │   ├── bookmarks-handler.ts  ← export, import (merge/replace), diff, listeners
│       │   ├── history-handler.ts
│       │   ├── tabs-handler.ts
│       │   └── extensions-handler.ts
│       ├── sync/
│       │   ├── sync-engine.ts        ← orchestrates per-type sync, E2EE, conflicts
│       │   └── conflict-resolver.ts  ← LWW, prefer-local/remote, manual
│       ├── crypto/
│       │   └── encryption.ts         ← AES-256-GCM (wired, opt-in)
│       └── utils/
│           ├── storage.ts            ← chrome.storage.local wrapper
│           ├── retry.ts              ← exponential backoff
│           ├── logger.ts             ← audit log
│           └── messaging.ts          ← popup ↔ background messaging
```

---

## Getting Started

### 1. Install dependencies

```bash
npm install
```

### 2. Configure Google OAuth (if using Google Drive)

1. Create a project at [console.cloud.google.com](https://console.cloud.google.com)
2. Enable the **Google Drive API**
3. Create OAuth credentials → Chrome Extension
4. Copy the client ID into `manifest.json`:

```json
"oauth2": {
  "client_id": "YOUR_CLIENT_ID.apps.googleusercontent.com",
  "scopes": ["https://www.googleapis.com/auth/drive.file"]
}
```

### 3. Build

```bash
# Development (watch mode)
npm run dev

# Production build
npm run build
```

### 4. Load the extension

1. Open `chrome://extensions`
2. Enable **Developer Mode**
3. Click **Load unpacked**
4. Select the `dist/` folder

---

## Data Format

All sync data is stored as `SyncPacket` JSON files in your backend:

```json
{
  "version": "1.0",
  "device_id": "uuid-v4",
  "timestamp": "2025-01-15T10:30:00Z",
  "data_type": "bookmarks",
  "checksum": "<sha-256 hex of the plaintext payload>",
  "encrypted": false,
  "payload": "{ ...JSON data... }"
}
```

Files are named `konode_{data_type}_{device_id}.json`. When E2EE is enabled,
`encrypted` is `true` and `payload` is the AES-256-GCM blob (salt + IV +
ciphertext, base64); the `checksum` is still computed over the plaintext so
identical content matches across devices. The checksum is verified on download
before any data is imported.

---

## Password Sync — Why It's Not Here

Chrome extensions **cannot access** the browser's native password store. This is an intentional security boundary enforced by Chromium.

**Alternatives:**
- [Bitwarden](https://bitwarden.com) — open source, self-hostable
- [Proton Pass](https://proton.me/pass) — E2EE, cross-platform
- [Vaultwarden](https://github.com/dani-garcia/vaultwarden) — self-hosted Bitwarden server

---

## Roadmap

| Status | Features |
|--------|----------|
| ✅ Done | Bookmarks / sessions / history / extensions sync · Google Drive + GitHub + WebDAV · popup + options + onboarding · E2EE (opt-in) · conflict resolution UI |
| 🔜 Next | True multi-device merge (fold all peers), session manager UI, OAuth refresh/PKCE for Drive |
| 🧭 Later | Firefox support, Mega backend, incremental diff for >10k bookmarks, tests + CI |

---

## Privacy & Security

- No data is ever sent to Konode servers (there are none). Your data goes only to the storage backend you configure (Google Drive, GitHub, or your WebDAV server).
- **Optional E2EE**: enable it in Settings → Advanced to encrypt every payload (AES-256-GCM, PBKDF2-SHA256) before it leaves the device. Without it, data is stored as plaintext on your chosen backend.
- The synced data includes your **installed-extension list** (used to flag missing extensions on other devices).
- Credentials (Drive access token, GitHub token, WebDAV password) and your E2EE passphrase are stored in `chrome.storage.local` on this device only. They are never uploaded. Note `chrome.storage.local` is not encrypted at rest — prefer a fine-grained GitHub token (single repo) and a WebDAV app password.
- Google Drive OAuth is scoped to `drive.file` (only files Konode creates).
- `history`, `tabs`, and `management` are requested as **optional permissions**, only when you enable those data types.
- Audit log stored locally, last 200 entries. Rate limiting + exponential backoff (transient errors only) on all backend calls.

---

## License

MIT — use it, fork it, self-host it.

# Synkro

> Privacy-first browser sync to your own storage — no middlemen, no telemetry.

Synkro is a Manifest V3 Chrome extension that syncs your browser data (bookmarks, tabs, sessions, history) to storage you control. Currently supports **Google Drive** and **GitHub**. Mega is planned.

---

## Features

- **Bookmarks** — full two-way sync with merge and diff
- **Open Tabs** — export/store current session across devices
- **Named Sessions** — save and restore tab sessions by name
- **History** — incremental sync with configurable day limit
- **Conflict resolution** — Last Write Wins, Prefer Local, Prefer Remote, or Manual
- **Zero telemetry** — no external server, no analytics
- **E2EE** — AES-256-GCM encryption *(Sprint 2)*

---

## Backends

| Backend      | Status       | Notes                                          |
|--------------|--------------|------------------------------------------------|
| Google Drive | ✅ Supported  | OAuth via Chrome Identity API                  |
| GitHub       | ✅ Supported  | Personal Access Token, private repo            |
| Mega         | 🔜 Planned   | Requires megajs + Node polyfills               |

---

## Stack

- **Manifest V3** (service worker background)
- **React 18** + **TypeScript** (popup + options)
- **Vite** + `vite-plugin-web-extension`
- **Tailwind CSS v3** (custom dark design system)
- **Zustand** — state management *(planned for popup)*
- **Web Crypto API** — AES-256-GCM E2EE

---

## Project Structure

```
synkro/
├── manifest.json
├── popup.html
├── options.html
├── src/
│   ├── background/
│   │   └── service-worker.ts      ← alarm polling, listener hub, message router
│   ├── popup/
│   │   ├── App.tsx                ← sync status, quick actions
│   │   └── components/
│   │       ├── StatusBadge.tsx
│   │       ├── SyncButton.tsx
│   │       ├── DataTypeRow.tsx
│   │       └── AuditLog.tsx
│   ├── options/
│   │   └── App.tsx                ← full settings: backend, data types, device, advanced
│   └── lib/
│       ├── types.ts               ← all shared types
│       ├── backends/
│       │   ├── abstract-backend.ts   ← factory + IBackend interface
│       │   ├── gdrive-backend.ts
│       │   ├── github-backend.ts
│       │   └── mega-backend.ts       ← stub
│       ├── handlers/
│       │   ├── bookmarks-handler.ts  ← export, import, diff, listeners
│       │   ├── history-handler.ts
│       │   └── tabs-handler.ts
│       ├── sync/
│       │   ├── sync-engine.ts        ← orchestrates per-type sync
│       │   └── conflict-resolver.ts  ← LWW, prefer-local/remote, 3-way diff
│       ├── crypto/
│       │   └── encryption.ts         ← AES-256-GCM (Sprint 2)
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
  "checksum": "a3f8c2d1",
  "encrypted": false,
  "payload": "{ ...JSON data... }"
}
```

Files are named `synkro_{data_type}_{device_id}.json`.

---

## Password Sync — Why It's Not Here

Chrome extensions **cannot access** the browser's native password store. This is an intentional security boundary enforced by Chromium.

**Alternatives:**
- [Bitwarden](https://bitwarden.com) — open source, self-hostable
- [Proton Pass](https://proton.me/pass) — E2EE, cross-platform
- [Vaultwarden](https://github.com/dani-garcia/vaultwarden) — self-hosted Bitwarden server

---

## Roadmap

| Sprint | Features |
|--------|----------|
| 1 ✅   | Bookmarks + Tabs sync, Google Drive + GitHub backends, Popup + Options UI |
| 2      | E2EE (AES-256-GCM), History sync, Mega backend |
| 3      | Firefox support (webextension-polyfill), Conflict UI, Session manager |
| 4      | Incremental diff optimisation, >10k bookmark performance |

---

## Privacy & Security

- No data ever sent to Synkro servers (there are none)
- Credentials stored only in `chrome.storage.local` (device-local)
- GitHub tokens scoped to `repo` only
- Google Drive OAuth scoped to `drive.file` (only files created by Synkro)
- Audit log stored locally, last 200 entries
- Rate limiting + exponential backoff on all backend calls

---

## License

MIT — use it, fork it, self-host it.

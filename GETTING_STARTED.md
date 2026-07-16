# Getting started with Konode

Konode syncs your browser data — bookmarks, open tabs, history, and your
installed-extension list — to storage **you** own (Google Drive, GitHub, or WebDAV).
No Konode account, no Konode server. This guide walks you through your first setup and
adding a second device.

- [Install](#install)
- [First run (onboarding)](#first-run-onboarding)
- [Connecting a backend](#connecting-a-backend)
  - [Google Drive](#google-drive)
  - [GitHub](#github)
  - [WebDAV](#webdav)
- [Choosing what to sync](#choosing-what-to-sync)
- [End-to-end encryption](#end-to-end-encryption)
- [Adding a second device](#adding-a-second-device)
- [How syncing works](#how-syncing-works)

## Install

Store listings (Chrome Web Store and Firefox Add-ons) are on the way. Until then you
can build and load Konode yourself — see **Build from source** in the
[README](README.md).

After loading, click the Konode icon to open the popup, or open the options page to
configure everything.

## First run (onboarding)

On first launch Konode opens a short setup wizard:

1. **Choose a storage backend** — Google Drive, GitHub, or WebDAV (details below).
2. **Sign in / enter your credentials** for that backend.
3. **Choose what to sync** — bookmarks are on by default; history, open tabs, and the
   extension list are opt-in.
4. **Choose encryption** — decide, consciously, whether to turn on end-to-end
   encryption. It's off by default; nothing is uploaded until you've made this choice.
5. **Finish** — Konode does its first sync and you're done.

You can change any of this later in the options page.

## Connecting a backend

You only connect **one** backend. All your devices must use the **same** backend (and,
if you enable encryption, the **same passphrase**) to sync together.

### Google Drive

1. Select **Google Drive** and click **Connect**.
2. Sign in to your Google account and approve access.
3. That's it. Konode uses the `drive.file` scope, so it can only see and touch the
   files it creates — never the rest of your Drive. It writes a small set of JSON files
   to a `Konode` folder.

> Works on any Chromium browser (Chrome, Brave, Helium, ungoogled-chromium) and on
> Firefox — the sign-in uses a browser-agnostic flow, not Chrome-only Google
> integration.

### GitHub

1. Create a **fine-grained personal access token**:
   [github.com/settings/tokens](https://github.com/settings/tokens?type=beta) → **Generate new token**.
2. Scope it to **a single private repository** (create an empty private repo for this,
   e.g. `konode-sync`), and grant **Repository permissions → Contents: Read and write**.
3. In Konode, select **GitHub / Gitea / GitLab**, paste the token and the repository
   (`owner/repo`, or paste the full repo URL — Konode normalizes it).
4. Konode refuses a **public** repository — your sync data should live in a private one.

### WebDAV

1. Select **WebDAV** and enter your server **URL** (must be `https://`), **username**,
   and **password** (use an app password if your provider offers one).
2. Works with Nextcloud, ownCloud, Synology, pCloud, kDrive, and any standard WebDAV
   server. Konode creates a `konode/` folder for its files.
3. Plain `http://` is rejected for security (except `http://localhost`).

## Choosing what to sync

- **Bookmarks** — on by default. Two-way sync with folders preserved; deletions
  propagate (no old bookmarks quietly coming back).
- **Open tabs / sessions**, **History**, **Installed-extension list** — opt-in. When
  you turn one on, the browser asks for the matching permission at that moment. If you
  never enable it, Konode never holds that permission.

## End-to-end encryption

Optional, and a conscious choice — it's **off by default**.

- Turn it on in onboarding or **Settings → Advanced**. Type a passphrase (you'll
  confirm it by re-typing) or **generate a strong key**.
- With encryption on, your data is encrypted on your device (AES-256-GCM) **before**
  upload, so your storage provider can't read it.
- **Every device must use the same passphrase.** Konode warns you loudly on a mismatch
  rather than silently forking your data.
- **If you lose the passphrase, the encrypted data can't be recovered** — save it
  somewhere safe (a password manager).

## Adding a second device

1. Install Konode on the second browser/device.
2. In onboarding, choose the **same backend** and sign in to the **same account**.
3. If you use encryption, enter the **same passphrase**.
4. The first sync **merges** the two devices non-destructively — your existing local
   bookmarks are kept and combined with what's on the backend.

## How syncing works

- Each device writes one file per data type to your backend
  (`konode_<type>_<device_id>.json`). Every sync pulls in each other device's file,
  merges it, and pushes the result back.
- **The editing device syncs in about a second.** Other devices pick up changes on
  their next periodic pull (up to ~30 seconds — the browser's minimum alarm interval).
- History restore is best-effort: browsers can't set original visit times, so imported
  history shows the sync moment. Treat history as a synced list/backup, not a faithful
  timeline.

Stuck on something? See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) or
[open an issue](https://github.com/konabe-studio/konode/issues).

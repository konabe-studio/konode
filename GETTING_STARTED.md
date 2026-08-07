# Getting started with Konode

Konode syncs your browser data (bookmarks, open tabs, history, and your
installed-extension list) to storage **you** own (Google Drive, GitHub, or WebDAV).
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

- **Chrome / Brave / Helium / other Chromium browsers**: install from the
  [Chrome Web Store](https://chromewebstore.google.com/detail/konode/mmlfiiimnpnjcjhhbldenpcmnibedkfa).
- **Firefox / Waterfox**: install from
  [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/konode/).

You can also build and load Konode yourself; see **Build from source** in the
[README](README.md). Those builds need your own Google OAuth client for Drive sync,
while GitHub and WebDAV work as they do in the store builds.

Konode opens its setup wizard in a new tab as soon as it's installed, so there's nothing to
go looking for. Afterwards, click the Konode icon for the popup, or open the options page to
change anything.

## First run (onboarding)

On install Konode opens a short setup wizard:

1. **Choose where your data goes**: a card each for Google Drive, Nextcloud / ownCloud,
   pCloud, Koofr, Fastmail, GitHub, and WebDAV (other), details below.
2. **Sign in / enter your credentials** for that backend.
3. **Choose what to sync**: bookmarks are on by default; history, open tabs, and the
   extension list are opt-in.
4. **Choose encryption**: decide, consciously, whether to turn on end-to-end
   encryption. It's off by default; nothing is uploaded until you've made this choice.
5. **Finish**: Konode does its first sync and you're done.

You can change any of this later in the options page.

## Connecting a backend

You only connect **one** backend. All your devices must use the **same** backend (and,
if you enable encryption, the **same passphrase**) to sync together.

### Google Drive

1. Select **Google Drive** and click **Connect**.
2. Sign in to your Google account and approve access.
3. That's it. Konode uses the `drive.file` scope, so it can only see and touch the
   files it creates, never the rest of your Drive. It writes a small set of JSON files
   to a `Konode` folder.

> Works on any Chromium browser (Chrome, Brave, Helium, ungoogled-chromium) and on
> Firefox. The sign-in uses a browser-agnostic flow, not Chrome-only Google
> integration.

### GitHub

1. Create a **fine-grained personal access token**:
   [github.com/settings/tokens](https://github.com/settings/tokens?type=beta) → **Generate new token**.
2. Scope it to **a single private repository** (create an empty private repo for this,
   e.g. `konode-sync`), and grant **Repository permissions → Contents: Read and write**.
3. In Konode, select **GitHub**, paste the token and the repository (`owner/repo`, or
   paste the full repo URL; Konode normalizes it). GitHub itself only: Gitea and GitLab
   aren't supported, so don't point it at a self-hosted instance.
4. Konode refuses a **public** repository: your sync data should live in a private one.

### WebDAV

1. Pick your provider: **Nextcloud / ownCloud**, **pCloud**, **Koofr**, **Fastmail**, or
   **WebDAV (other)** for anything else (Synology, kDrive, and so on).
2. The presets know the address, so you type less. Nextcloud and ownCloud ask for your
   server's host and Konode builds the rest of the path from it and your username; pCloud
   asks whether your account lives in the EU or the US (and needs a paid plan); Koofr and
   Fastmail need no address at all. **WebDAV (other)** takes the full URL, which must be
   `https://`.
3. Enter your **username** and **password**. Use an app password where your provider
   offers one: Nextcloud under Settings → Security, a Koofr app password with your Koofr
   email, or a Fastmail app password with Files (WebDAV) access and your full Fastmail
   address.
4. Plain `http://` is rejected for security (except `http://localhost`). Konode creates a
   `konode/` folder for its files.

## Choosing what to sync

- **Bookmarks**: on by default. Two-way sync with folders preserved; deletions
  propagate (no old bookmarks quietly coming back).
- **Open tabs / sessions**, **History**, **Installed-extension list**: opt-in. When
  you turn one on, the browser asks for the matching permission at that moment. If you
  never enable it, Konode never holds that permission.

## End-to-end encryption

Optional, and a conscious choice. It's **off by default**.

- Turn it on in onboarding, or later in **Settings → Storage**, in the **Encryption** card
  next to the provider it protects you from. Type a passphrase of at least 12 characters
  (you'll confirm it by re-typing) or **generate a strong key**, which is the safer choice.
- With encryption on, your data is encrypted on your device (AES-256-GCM) **before**
  upload, so your storage provider can't read it.
- **Every device must use the same passphrase.** Konode warns you loudly on a mismatch
  rather than silently forking your data.
- **If you lose the passphrase, the encrypted data can't be recovered**. Save it
  somewhere safe (a password manager).

## Adding a second device

1. Install Konode on the second browser/device.
2. In onboarding, choose the **same backend** and sign in to the **same account**.
3. If you use encryption, enter the **same passphrase**.
4. The first sync **merges** the two devices non-destructively: your existing local
   bookmarks are kept and combined with what's on the backend.

## How syncing works

- Each device writes one file per data type to your backend
  (`konode_<type>_<device_id>.json`). Every sync pulls in each other device's file,
  merges it, and pushes the result back.
- **Edit a bookmark and this device uploads in about a second.** Other devices pick it up
  on their next scheduled pull, every 60 seconds by default (adjustable from 30 to 600
  under Settings → Device; 30s is the browser's minimum for a background check). History,
  open tabs and the extension list have no instant path, so they travel on that interval.
- History restore depends on the browser. **Firefox** keeps each page's original visit
  date. **Chromium** browsers give an extension no way to set it, so on Chrome, Brave and
  the rest an arriving page is stamped with the moment it reached you. Visit counts can't
  be restored on either. Treat history as a synced list, not a faithful timeline.

Stuck on something? See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) or
[open an issue](https://github.com/konabe-studio/konode/issues).

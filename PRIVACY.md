# Synkro — Privacy Policy

_Last updated: [EFFECTIVE DATE — e.g. June 23, 2026]_

> **Draft.** Replace the `[BRACKETED]` placeholders (publisher name, contact email,
> effective date, hosted URL) with your final details, and have someone review it
> before you submit it to Google OAuth verification and the Chrome Web Store.

## The short version

Synkro is a browser extension that syncs your own browser data to storage **you
control**. We do not run any servers, we do not have a database, and we never
receive your data. Everything you sync goes directly from your browser to the
storage backend **you** choose and sign in to (Google Drive, GitHub, or a WebDAV
server). We don't track you, show ads, or use analytics.

In plain terms: **your data stays yours.** Synkro is the pipe, not the destination.

## Who this policy covers

This policy applies to the **Synkro** browser extension ("Synkro", "we", "us"),
published by **[PUBLISHER NAME — e.g. Kōnabe Studio]**. It explains what data the
extension touches, where that data goes, and what we do — and don't do — with it.

## What data Synkro accesses

Synkro only accesses the data types **you turn on**. Nothing is read or synced
unless you enable it and grant the matching browser permission. Depending on your
choices, Synkro may read:

- **Bookmarks** — your bookmark tree (folders, titles, URLs), so it can be synced.
- **Browsing history** — visited URLs and titles, if you enable history sync.
- **Open tabs / sessions** — the URLs and titles of your open tabs, if you enable
  session sync.
- **Installed-extension list** — the names, IDs, versions, and store links of your
  installed extensions, if you enable extension-list sync (this surfaces which
  extensions are "missing on this device"). Synkro **cannot install or remove**
  extensions; it can enable or disable an already-installed extension only when you
  click to do so from its popup.

Synkro reads this data **only to sync it to the storage backend you selected.** It
is not used for any other purpose.

The browser permissions for the more sensitive types — **history**, **open tabs**,
and the **extension list** — are **requested when you turn that type on**, not at
install time. If you never enable them, Synkro never holds those permissions and
never reads that data.

## Where your data goes

When you set up Synkro, you choose **one** storage backend and sign in to it with
your own account:

- **Google Drive** (via Google sign-in),
- **GitHub** (via a personal access token you create), or
- a **WebDAV server** (your own, or a provider you use).

Your synced data is written **directly from your browser to that backend, under your
own account.** Synkro operates **no servers of its own** and therefore never
receives, stores, processes, or has access to your synced data. We cannot see your
bookmarks, history, tabs, or extension list.

Each backend is operated by a third party (Google, GitHub, or your WebDAV provider).
Once your data is stored there, it is also subject to **that provider's** privacy
policy and terms. Synkro is not affiliated with these providers.

## Your credentials

The credentials you enter (a Google OAuth token, a GitHub personal access token, or
a WebDAV username and password) are stored **only on your device**, in the browser's
local extension storage (`chrome.storage.local`). They are used solely to
authenticate to the backend you chose. They are **never transmitted to us** (we have
no server to transmit them to) and are not shared with anyone else.

Browser extensions do not have access to the operating system's secure credential
store, so these credentials are held in standard local extension storage. They never
leave your device except as part of the authenticated request to your chosen
backend.

The **encryption passphrase** (if you enable end-to-end encryption) is held the same
way — in local extension storage on your device. It has to be available to the
extension without you present so that background sync can keep running unattended, so
it cannot be locked behind a prompt. It is never uploaded and never leaves your
device. Note that, like the browser's own stored data, it is therefore readable by
someone with full access to your device's browser profile; end-to-end encryption
protects your data on the **storage backend** (which never sees the passphrase), not
against an attacker who already controls your device.

## Optional end-to-end encryption

Synkro offers **optional** end-to-end encryption (AES-256-GCM, with a key derived
from a passphrase you set). During setup you make an **explicit choice** whether to
turn it on — it is **off by default**, but nothing is uploaded until you have
consciously decided. When you enable it, your synced data is encrypted on your
device **before** it is uploaded, so the contents are unreadable to the storage
provider and to anyone who obtains the stored files. You hold the passphrase; if you
lose it, the encrypted data cannot be recovered, and every device must use the same
passphrase (Synkro warns you on a mismatch rather than silently failing).

If you choose **not** to encrypt, your synced data (bookmarks, and any of history,
open tabs, or the extension list you enable) is stored on your chosen backend in
readable form. Choose encryption if your storage might be seen by anyone but you.

Even with encryption on, a small amount of **metadata** in each sync file is not
encrypted: the storage provider can see that Synkro sync files exist, roughly how
many devices you sync (each has a random identifier), which data type each file
holds, and when it was last written — but **not its contents**.

## Google API services (Limited Use)

When you choose Google Drive, Synkro uses the **`drive.file`** scope, which grants
access **only to the files Synkro itself creates** in your Drive — it cannot see or
touch any of your other Drive files.

Synkro's use and transfer of information received from Google APIs adheres to the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including the **Limited Use** requirements. We use this access solely to read and
write your sync files at your direction; we do not transfer or sell this data, and we
do not use it for advertising or any purpose other than providing the sync feature.

## What we do *not* do

- We do **not** run servers or databases that hold your data.
- We do **not** collect analytics, usage statistics, or telemetry.
- We do **not** use tracking, advertising, or fingerprinting.
- We do **not** sell, rent, or share your data with anyone.

## Data retention and deletion

Because Synkro stores nothing on its own infrastructure, **you control retention**:

- **On your device:** uninstalling the extension removes its local data, including
  your stored credentials and settings. Synkro also keeps a short **activity log**
  (recent sync events) **on your device only** — it is never uploaded and is cleared
  when you uninstall.
- **On your backend:** you can delete the files Synkro created (in the `Synkro` /
  `synkro` folder of your Drive, repository, or WebDAV server) at any time, directly
  through that provider.

## Children's privacy

Synkro is a general-purpose utility and is not directed at children. It does not
knowingly collect data from children.

## Your rights (GDPR and similar)

Because your data never reaches us, **you** act as the controller of your own data:
it lives in your browser and in the storage account you chose. You can access,
export, or delete it directly through your device and your storage provider at any
time. If you have questions about how the extension handles data, contact us using
the details below.

## Changes to this policy

If we update this policy, we will revise the "Last updated" date above and post the
new version at its published location. Material changes will be reflected in the
extension's listing.

## Contact

Questions about this policy or Synkro's data handling:
**[CONTACT EMAIL — e.g. hello@konabe.studio]**

_This policy is published at **[PUBLISHED URL]** and linked from the Synkro Chrome
Web Store listing and the Google OAuth consent screen._

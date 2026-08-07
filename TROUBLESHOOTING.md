# Troubleshooting

Common issues and how to fix them. If none of these help,
[open an issue](https://github.com/konabe-studio/konode/issues) with your browser, the
backend you use, and what you saw.

## Sync

**Changes take a while to show up on my other device.**
Edit a bookmark and this device uploads in about a second, as long as **Sync on change** is
on (it is by default, under Settings → Device). The *receiving* device finds out
on its next scheduled pull, which is every 60 seconds by default. You can move that to
anywhere between 30 and 600 seconds under **Settings → Device → Sync interval**; 30s is the
browser's minimum for a background check, so that's the floor, not a bug. History, open
tabs and the extension list have no instant path at all: they travel on that same interval.

**Bookmarks I deleted came back / a big cleanup didn't propagate.**
Konode has a safety cap: a single sync won't apply peer deletions that would remove
more than a threshold of your local bookmarks (default **60%**), to guard against a
corrupt deletion log wiping your tree. If you intentionally deleted a large share, raise
**Max bulk delete from a peer** under **Settings → Device → Safety** (50-95%) and sync
again. A blocked deletion also saves a restore point, so nothing is lost either way.

**Nothing syncs unless I keep a DevTools window open (dev builds).**
After rebuilding an unpacked extension you must click **↻ reload** on it
(`chrome://extensions`). The background service worker is suspended when idle and
wakes on the next event; a normal install handles this automatically.

**My history shows the wrong times.**
On Chromium browsers, by design. Chrome, Brave and the rest give an extension no way to
set a page's original visit time, so an arriving page carries the moment it reached you.
Firefox does allow it and Konode uses it there, so the same sync keeps the original dates
on Firefox. Visit counts can't be restored on either. History is a synced list, not a
faithful timeline.

## Encryption

**"Your passphrase doesn't match your other devices."**
Every device must use the exact same E2EE passphrase. Open **Settings → Storage** and find
the **Encryption** card, reveal or re-enter the passphrase so it matches your other
device(s), and sync again. Konode fails loudly here on purpose: it won't silently fork your
data into unreadable files. Note what it does *not* do, though. The sync isn't cancelled.
This device still uploads its own file correctly, and the peer it couldn't read is reported
as a warning, so the group recovers as soon as the passphrases agree. A new typed
passphrase needs at least 12 characters, or you can generate a key.

**I turned encryption off on one device.**
That's a downgrade: that device re-uploads its data unencrypted, and Konode nudges you
there, on the device that can actually fix it, that your other devices are still encrypted.
Those encrypted devices stay quiet about it on purpose, because a plaintext file on the
backend is usually just a leftover from a device that's gone. To converge again, either
turn E2EE off everywhere or back on everywhere (with the same passphrase).

## Google Drive

**"Connected as ()" / Drive sync fails (building from source).**
Your own Google Cloud project needs the **Google Drive API enabled**
(APIs & Services → Library → Google Drive API → Enable). The OAuth sign-in can succeed
while Drive API calls fail if the API isn't enabled. This doesn't affect installs from
the store.

**"redirect_uri_mismatch" (building from source).**
Your OAuth client must list your extension's redirect URI. On Chromium, load `dist/` and
read the extension ID at `chrome://extensions`; the redirect is
`https://<extension-id>.chromiumapp.org/gdrive`. On Firefox the host is not the add-on ID
but its SHA-1 hex digest, so don't try to assemble it by hand:
`npm run build:firefox` prints the exact URL at the end of the build. Add whichever you
need to your OAuth client's **Authorized redirect URIs**.

**"Google hasn't verified this app."**
Konode requests only the `drive.file` scope (non-sensitive: app-created files only),
so this warning normally doesn't appear. If it does, it's safe to proceed: you're
authorizing access to your own Konode files, and no data goes to any Konode server
(there isn't one).

## GitHub

**"Public repositories aren't allowed" / connection refused.**
Point Konode at a **private** repository. Sync data shouldn't sit in a public repo.

**403 / permission errors.**
Use a **fine-grained** token scoped to the one repo, with
**Contents: Read and write**. A token missing that permission (or scoped to the wrong
repo) will fail.

## WebDAV

**"WebDAV must use https" / connection rejected.**
Plain `http://` is rejected for security (credentials would travel in the clear). Use
`https://`. `http://localhost` is allowed for local testing.

**Connected but I don't see my files.**
Check that the account can create a `konode/` folder at that path. Some providers gate
WebDAV behind a paid tier or a per-app password; check your provider's WebDAV docs.

## Firefox

**The extension list differs from my Chromium device.**
Extension IDs don't cross stores, so between a Chromium browser and Firefox Konode matches
on the extension's name and on the developer's homepage host instead. That catches the
common cases, but an extension published under different names in the two stores still
shows up as "missing on this device". The list is most exact between same-browser peers.

## Starting over

Google Drive has a **Disconnect** button in **Settings → Storage**. GitHub and WebDAV
don't: to leave one of those, either pick a different provider in the same place and enter
its credentials, or remove and reinstall the extension (which clears all local data and
credentials). Your synced files on the backend are untouched. Delete those directly through your storage provider if you want
a full wipe.

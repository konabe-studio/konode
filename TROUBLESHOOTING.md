# Troubleshooting

Common issues and how to fix them. If none of these help,
[open an issue](https://github.com/konabe-studio/konode/issues) with your browser, the
backend you use, and what you saw.

## Sync

**Changes take a while to show up on my other device.**
The editing device uploads in about a second. The *receiving* device polls on an
interval with a floor of ~30 seconds (the browser's minimum alarm period), so expect
up to ~30s of latency there. This is a platform limit, not a bug.

**Bookmarks I deleted came back / a big cleanup didn't propagate.**
Konode has a safety cap: a single sync won't apply peer deletions that would remove
more than a threshold of your local bookmarks (default **60%**), to guard against a
corrupt deletion log wiping your tree. If you intentionally deleted a large share,
raise the threshold in **Settings → Advanced** (50–95%) and sync again.

**Nothing syncs unless I keep a DevTools window open (dev builds).**
After rebuilding an unpacked extension you must click **↻ reload** on it
(`chrome://extensions`). The background service worker is suspended when idle and
wakes on the next event; a normal install handles this automatically.

**My history shows the wrong times.**
By design. Browsers don't let an extension set a page's original visit time, so
restored history entries carry the sync moment. History is a synced list/backup, not a
faithful timeline.

## Encryption

**"Your passphrase doesn't match your other devices."**
Every device must use the exact same E2EE passphrase. Open **Settings → Advanced**,
reveal or re-enter the passphrase so it matches your other device(s), and sync again.
Konode fails loudly here on purpose — it won't silently fork your data into
unreadable files.

**I turned encryption off on one device.**
That's a downgrade: that device re-uploads its data unencrypted, and Konode shows a
nudge that your other devices are still encrypted. To converge again, either turn E2EE
off everywhere or back on everywhere (with the same passphrase).

## Google Drive

**"Connected as ()" / Drive sync fails (building from source).**
Your own Google Cloud project needs the **Google Drive API enabled**
(APIs & Services → Library → Google Drive API → Enable). The OAuth sign-in can succeed
while Drive API calls fail if the API isn't enabled. This doesn't affect installs from
the store.

**"redirect_uri_mismatch" (building from source).**
Your OAuth client must list your extension's redirect URI. Load `dist/` and read the
extension ID at `chrome://extensions`; the redirect is
`https://<extension-id>.chromiumapp.org/gdrive` (Firefox uses
`https://<id>.extensions.allizom.org/gdrive`). Add it to your OAuth client's
**Authorized redirect URIs**.

**"Google hasn't verified this app."**
Konode requests only the `drive.file` scope (non-sensitive — app-created files only),
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
WebDAV behind a paid tier or a per-app password — check your provider's WebDAV docs.

## Firefox

**The extension list differs from my Chromium device.**
Extension IDs aren't the same across stores, so a Chrome extension and its Firefox
build don't map to each other. The "missing on this device" list is most meaningful
between same-browser peers.

## Starting over

To reset a device: disconnect the backend in **Settings**, or remove and reinstall the
extension (this clears its local data and credentials). Your synced files on the
backend are untouched — delete those directly through your storage provider if you want
a full wipe.

# Changelog

All notable changes to Konode. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added

- **Settings speaks your language too.** The popup and the setup wizard already followed
  the language your browser is set to, but Settings stayed in English whatever the rest of
  Konode was reading in, which made it the one screen you had to switch languages for.
  Every tab, label and explanation on it now comes from the same translation files as
  everything else.
- **A way back into setup, from the popup.** Konode opens the setup wizard once, in a tab,
  the moment it installs. If you closed that tab, or were looking elsewhere when it
  appeared, or are on a browser where it never opened at all, there was nothing telling you
  what to do next, and setup had to be found by opening Settings and knowing what to look
  for. The popup now offers to finish setting up until a storage provider has been chosen.
- **Anyone can translate Konode, without touching the code.** Translations are edited on
  [Hosted Weblate](https://hosted.weblate.org/projects/konode/): no git, no pull request,
  and nothing to install. Spanish, Chinese (Simplified), Italian and Estonian have all
  been started there, and a language that isn't finished is still safe to use, because
  anything not yet translated falls back to English string by string.

### Fixed

- **A device you forgot went on haunting your other machines.** Forgetting a device deletes
  its files from your storage, and the machine you did it on stopped listing it straight
  away. Every other device carried on exactly as before: the forgotten machine's tabs were
  still offered for you to restore, and its extensions still counted toward what is
  "missing on this device", with nothing left in your storage to justify either. Each device
  now checks what it remembers about the others against what your storage actually holds,
  and drops whatever is no longer there. Not at the same moment, though: your other devices
  notice on their next sync, not the instant you click Forget. A device whose file simply
  couldn't be read that time is left alone, because "I couldn't reach it" and "it's gone"
  are not the same thing, and only one of them is a reason to forget a machine you still
  use.
- **On Orion, your bookmarks were being split between two places.** Orion keeps both a
  "Bookmarks Bar" and a "Favorites", and Konode recognised both of them as the bookmarks
  bar. Which one an arriving bookmark went into came down to the order Orion happened to
  list them in, so the same folder could end up existing in both, with its contents
  divided. On a real 80-bookmark tree it arrived as 32 in one and 48 in the other. Nothing
  was ever lost, but the tree was torn in half. Arriving bookmarks now go to the real
  bookmarks bar, consistently. A related case is fixed with it: Konode no longer treats
  Chrome's "Mobile bookmarks" and Orion's "Favorites" as the same place, which it did
  because the two browsers happen to number them alike.
- **Restoring a session on Orion brought back a single tab.** Orion allows one tab or
  window to open per click, and Konode spent that one allowance checking whether it was
  allowed to open more, leaving nothing to open the rest with. A 10-tab session arrived as
  1 tab, silently, with nothing in the log to explain it. Konode now settles the question
  before it opens anything, so the whole session arrives in one window. On a browser it
  hasn't met before, the first restore may still fall short, and it now says so and gets
  it right from then on. Chrome, Brave and Firefox are unaffected and keep restoring into
  the window you are already in, pinned tabs still pinned.

- **An unfinished translation no longer fails the build.** The check that stops a
  translation from losing a `$COUNT$`, and taking the number out of the sentence with it,
  treated a string nobody had translated yet as a loss. Every language still in progress
  therefore broke the build, and the real problems were buried: of 22 reported on the
  first contribution from Weblate, 21 were simply work not done yet. The same check also
  objected to one placeholder used twice in a sentence, which Chinese needs and which the
  browser substitutes correctly both times. It now reports only what it was written to
  catch, a placeholder that went missing or one that was never in English.

## [1.2.1] - 2026-08-07

### Changed

- **The store listing is easier to find.** The Web Store takes its title from the
  extension's name, and ours was the bare word "Konode", which matches nothing anyone
  types. It is now "Konode | Private Bookmark & Tab Sync": the name first, then what it
  actually does. The title goes through the translation files, so it appears in your own
  language wherever Konode has been translated.

### Fixed

- **A crash no longer leaves you with a blank page.** If any screen fails to draw, you now
  get a short explanation, the error text to quote in a report, and a reload button,
  instead of an empty window with nothing to go on. Your synced data was never involved in
  those failures, and the new screen says so, because that is the first thing anyone wants
  to know.
- **The "missing on this device" list could quietly hide extensions you really don't have.**
  Matching a neighbour's extension against your own used the developer's homepage address
  as one of its signals, and a large share of extensions point that at their source
  repository. So a single extension of yours homepaged on github.com marked every
  extension sharing that host as already installed. On a real list of ten genuinely absent
  extensions, six vanished this way.
- **The same list dropped anything the browser doesn't call an extension.** Chrome reports
  apps under their own type names, and the list only ever showed the exact word
  "extension", so those entries were synced all the way across and then discarded at the
  last step, with nothing to distinguish them from something never published.
- **The provider logos in the setup wizard were squashed narrower than they should be.**
- **The Settings page could open blank.** On a fresh 1.2.0 install, opening Settings showed
  nothing at all, with `management.getAll is not a function` in the console. 1.2.0 made the
  extension-list permission optional so the install prompt stays small, and Konode then
  asked the browser for your extension list before that permission existed. Chrome answers
  that with an error thrown on the spot rather than a failed promise, which took the whole
  page down with it. Konode now checks that the call is really available before making it.
  Settings opens normally whether or not extension sync is switched on.
- **A data type could stay switched on after losing its permission, and sync nothing.**
  History and the extension list need a permission you grant separately, and browsers let
  you take it back from their own extension settings without telling the extension. When
  that happened, the type still looked enabled, synced nothing, and left an unreadable
  error in the log once a cycle. Konode now says which permission is missing and how to
  restore it, both in Settings and in the sync status, and the rest of your data keeps
  syncing meanwhile.
- **One unsupported browser feature no longer takes the rest of Konode with it.** Konode
  attaches its background listeners the moment it starts, one after another, so a browser
  that didn't implement one of them stopped the whole sequence there. Everything after it
  was never set up, on a Konode that had started and looked fine. Each one is now attached
  on its own, and a browser missing a feature loses only what depends on it. Conflict
  notifications work the same way: a browser that can't show one still records the conflict
  and still lets you resolve it in Konode.

### Fixed: Firefox for Android

All four of these come from one detailed field report, and they share one cause: Konode
assumed that a permission its manifest asks for is a feature the browser actually has.
On Firefox for Android that isn't true, and every symptom below is what happens when the
two disagree. Konode now checks what the browser can really do, and says so plainly where
it can't.

- **Setup blamed your WebDAV server for a permission it was never asked about.** Firefox
  for Android doesn't implement runtime permission prompts, so the request came back
  refused with no prompt ever shown, and the wizard reported that as "Konode needs
  permission to reach your WebDAV server". Konode now checks the permissions you already
  hold *before* asking, so a permission granted by hand in Firefox's add-on settings is
  simply accepted. If it still can't ask, it says so, and tells you where to grant it,
  instead of telling you that you refused.
- **The History toggle silently refused to move.** Turning a data type on asks for its
  optional permission first, and if that came back refused the switch just sprang back
  with no explanation anywhere. It now says why, on the row you clicked.
- **Bookmarks failed with a "getTree" error.** Firefox for Android provides no bookmarks
  API at all. Bookmarks and History are now shown as unavailable there, with the reason,
  and are skipped by the sync rather than failing it every cycle. Open tabs still sync,
  and nothing changes for your desktop devices.
- **The extension could load half-built.** Konode registers its bookmark-change listeners
  when the background script starts. On a browser with no bookmarks API that line threw
  and took the rest of the script down with it, leaving an extension that had started but
  wasn't finished, which looks like it's working.

### Where you can get it

1.2.1 is live on **[Firefox Add-ons](https://addons.mozilla.org/firefox/addon/konode/)**,
so Firefox and Waterfox update to it on their own. On the Chrome Web Store it is in review,
and the listing serves 1.2.0 until that clears; Chrome updates itself once it does. If you
would rather not wait, the Chrome zip is on the
[v1.2.1 release](https://github.com/konabe-studio/konode/releases/tag/v1.2.1) page. Note
that the release zips are built without Konode's own Google OAuth client, so Google Drive
sign-in in those needs an OAuth client of your own. GitHub and WebDAV work with no extra
setup.

## [1.2.0] - 2026-08-04

A full code-review pass over the sync engine, the storage backends and the interface,
plus a Firefox build you can install. Almost all of the rest is correctness: several ways
your data could quietly fail to reach your other devices, and several places Konode
reported success it had never actually checked. The sync file format is unchanged, so
existing setups keep working, but every device re-uploads each of its files once on the
first sync after updating. See Upgrade notes.

### Added

- **A Firefox build, in the release.** Konode has been built for Firefox since 1.0.0, but
  this is the first release you can actually download it from. It syncs against the same
  folder as your Chromium browsers, with the same providers and the same files, so a
  Firefox install joins a group that is already running. Tested here across Firefox,
  Brave and Helium on one sync folder: each device names itself to the others, bookmarks
  and renames travel in both directions, and history arrives with its original dates,
  which is something only Firefox lets an extension do. It is on **[Firefox
  Add-ons](https://addons.mozilla.org/en-US/firefox/addon/konode/)**, so it installs and
  updates like any other add-on.

### Fixed: data not reaching your other devices

- **Changing where you sync synced nothing.** Konode skips an upload when the data hasn't
  changed, but it only compared the data, not where it was going. So after switching
  provider, or changing the GitHub repository, branch or folder, or pointing at a
  different WebDAV server, the new location stayed empty while the popup reported a clean
  sync. Only a later bookmark edit fixed it, which on a settled bookmark tree can be days.
- **The extension list could stop being uploaded altogether.** Your device identity was
  regenerated instead of being saved, and because the "already uploaded" record survived
  that, the new identity's files were never written for anything that doesn't change on
  its own. The installed-extension list is exactly that, which is why it was the one that
  went missing. The identity is now created once and written down.
- **"Manual" conflict resolution never published this device's data.** Manual is meant to
  ask you before pulling a change IN. It also stopped this device sending anything OUT, so
  as soon as another device existed, your changes reached nobody.
- **Renaming a bookmark or a folder never reached your other devices.** The rename was
  sent every time, and every device threw it away on arrival. There was no way to tell
  whose title was newer, so the safe thing was to change nothing. Renames now carry a
  timestamp and the newest one wins. Folders are renamed in place instead of a
  second folder appearing under the new name.
- **Deleted bookmarks came back.** Deleting several bookmarks at once fired several
  events, and they overwrote each other's record of the deletion, so only one was
  remembered and the rest returned from your other devices on the next sync.
- **Some bookmarks were silently never added.** When a device had fewer bookmarks in a
  folder than the device it was syncing from, the browser rejected the position Konode
  asked for and the bookmark was dropped without a word, on every sync, indefinitely.
- **Deleting all of your bookmarks never reached your other devices.** An empty tree was
  treated as "nothing to say", so the deletions never left the device.
- **A device that had been offline for a while could undo your deletions.** Its older copy
  was merged in before the newer deletion was known, and the freshly re-created bookmark
  then looked newer than the deletion, so it survived and spread to every device.
- **One data type failing stopped the rest.** Turning off Konode's optional history or
  extension permission in your browser made that part of the sync fail, which silently
  stopped your BOOKMARKS syncing too.
- **GitHub: setting up an empty repository could silently half-finish.** The first commit
  Konode writes to a new repository wasn't checked, so a token without write access failed
  there but was reported later as an unexplained upload error, once per data type, with
  nothing saying why. That commit also always went to `main`, so if you'd chosen any other
  branch, every upload afterwards failed against a branch that was never created.
- **WebDAV: "Connected" no longer appears when the sync folder couldn't be created.** The
  failure was only logged, so setup looked fine and every upload afterwards failed against
  a folder that wasn't there. Konode now checks whether the folder exists before deciding,
  which also stops it from giving up on servers that refuse the create call for a folder
  that's already present. If your server redirects the address you entered, it says so.
  That still works, but some servers drop the login across a redirect and then reject a
  correct password.
- **Google Drive: two devices set up at the same moment could end up in separate folders.**
  Both created a "Konode" folder and each kept its own, so they never saw each other.
  They now agree on one, and a device whose folder changes re-uploads into the new one.

### Fixed: privacy

- **Open tabs no longer sync local file paths or sign-in links.** Only `chrome://` pages
  were being excluded, so `file://` paths from your disk, Firefox `about:` pages, and
  sign-in pages still holding a token in their address were uploaded, and Konode refuses
  to reopen all of those anyway, so it was the most sensitive thing it handled, sent for
  no benefit. The same rule the history sync already used now applies here.
- **Restore points could have their index written back unencrypted.** A device that had
  turned end-to-end encryption off, but still had the passphrase saved, could read the
  shared restore-point index and write it back in the clear. It now leaves alone anything
  it shouldn't be reading, and never overwrites an index it couldn't read.
- **The activity log no longer records your WebDAV account name.** Every upload wrote the
  full server address, which on Nextcloud and ownCloud contains your username.

### Fixed: the interface telling you the truth

- **"No restore points yet" was shown when the list had simply failed to load.** On a
  recovery screen that is the worst possible thing to get wrong. It now tells you it
  couldn't read them, and says plainly that this does not mean you have none.
- **Save could do nothing, with no explanation.** Problems from saving were only ever
  displayed on the Storage Backend tab, including the passphrase problems, whose field
  lives on Advanced. All four tabs now show them.
- **"Test connection" now actually tests the connection.** Google Drive reported success
  from saved sign-in details without contacting Drive at all, so revoked access still
  said "Connected". GitHub never checked the branch, so a typo passed the test and then
  failed every upload, permanently and silently.
- **Sync now, Use remote and Restore no longer look like dead buttons.** When the
  background couldn't do what you asked, the reason was thrown away. It is now shown.
- **A waiting conflict is visible on the toolbar**, and the popup no longer reports
  "Synced" while one is still waiting for your decision.
- **The popup could stay stuck on "Syncing…"** with the button disabled, if a sync had
  been interrupted. It's told about the repair now.
- **The data-type icons no longer show green "synced"** before anything has ever synced,
  or right after a sync that failed. Those two states look different now.
- **Setting up GitHub: a rejected token now says so.** Continue simply stayed greyed out
  with nothing on screen. The token is also checked once you stop typing, rather than on
  every keystroke.
- **The activity log no longer shows deliberate skips as errors.** A warning and a failure
  were stored identically, so anything Konode chose not to sync appeared as a red error.
  One reported log had 176 of 188 entries flagged that way, nearly all of them harmless. It
  now distinguishes them, and the messages say what was skipped and why instead of leaving
  you to guess.
- **Restoring a session opens the tabs in the window you're in again**, and pinned tabs
  come back pinned. Since 1.0.2 a restore always opened a new window and lost the pinned
  state, as a workaround for one browser that refuses to open more than one tab at a time.
  Konode now checks whether the tabs actually opened rather than assuming, so that browser
  still gets all its tabs while everyone else gets the old behaviour back.
- **Settings now says that arriving history is stamped with the time it arrived.** On
  Chromium browsers a page from another device can only be recorded at the moment it
  reached you: the browser gives extensions no way to set the original date (Firefox
  does, and Konode uses it there). Nothing said so, which made a working sync look broken:
  you check yesterday on the other machine, find nothing, and reasonably conclude the
  history never came through.
- **A device that couldn't be read just disappeared from the sync.** If one device's file
  couldn't be downloaded (a permission problem on the server, a transient error), it was
  skipped without a word, and the sync still reported success with fewer devices than were
  really there. Konode now names the file, the error, and what it means for you.

### Fixed: other browsers

- **WebDAV passwords with accented or non-Latin characters.** A password containing `ő`,
  `ű`, Cyrillic, an emoji or `€` made every sync fail outright; one with `á`, `ö` or `ü`
  was sent in the wrong encoding, so a correct password was rejected as wrong, forever.
- **A Firefox "Bookmarks Menu" landed in Chrome's bookmarks bar** instead of Other
  bookmarks, because the fallback depended on the order a browser happens to list its
  bookmark roots.
- **Your device is no longer labelled with the wrong operating system.** A Windows 10
  machine was called Windows 11 (both send the same identifier, and they can't be told
  apart this way), an Android phone on a Chromium browser was called Linux, and an iPhone
  was called a Mac. The label names your device in Settings and names the other device
  whose tabs or extensions you're looking at, so it was wrong in the place it's most read.
- **Google sign-in failures no longer blame your browser.** Anything other than a cancel
  was reported as "Google Drive sign-in isn't available in this browser", including
  problems that had nothing to do with the browser.

### Fixed: history and extensions

- **Synced history was re-added on every single sync.** Browsers normalize a web address
  when they store it, and Konode compared the un-normalized one, so the same page was
  recorded as a new visit every cycle, inflating visit counts and your most-visited
  list. It also meant pages you only received from another device were published back out
  as your own visits.
- **History sync only carried pages your other device had never seen, so browsing the
  same sites on two machines synced nothing.** A page already in the receiving device's
  history was skipped outright, which meant a *new visit* was never transferred and the
  log read "Added 0 new history entries". If you and your other device visit a similar set
  of sites (the normal case), history sync did almost nothing. A visit newer than
  anything that device already holds now comes through.
- **History from your other devices was almost never saved on Chrome, Brave or any other
  Chromium browser.** Konode sent the original visit date along with each page, and those
  browsers reject the whole request when it is present rather than ignoring it. Since
  nearly every page carries a visit date, nearly every page from another device was turned
  away, and the reason was being discarded before anyone could see it. The date is now
  only sent to browsers that accept it, which is why pages arriving on Chromium are dated
  when they arrive.
- **The first sync is much faster, especially on Firefox.** Konode wrote incoming pages
  one at a time, waiting for each before starting the next, so a first sync of a few
  thousand pages meant a few thousand round trips end to end. They overlap now.
- **History could stop being published from a device entirely.** Konode remembers which
  pages arrived from another device so it doesn't send them back out as your own visits,
  but nothing ever left that list. Once a page had arrived from any device, this one
  stopped publishing it forever, even after you genuinely browsed there yourself. With
  three devices that had each already received most of the shared history, a full day of
  browsing familiar sites could export nothing at all. It looked exactly like history
  being filtered out. Konode now records *when* a page arrived, so your own later visit to
  it is published while the arrival itself still isn't.
- **Konode kept re-trying pages your browser had already refused, forever.** Nothing
  remembered a rejection, so every sync attempted them again and wrote a log line for each
  one. On one reported setup an idle sync still did a hundred pointless attempts a minute,
  and the activity log filled up so fast that anything useful was gone within two cycles.
  Rejections are now remembered for a week, long enough to stop the churn, short enough
  that a temporary problem still fixes itself.
- **Local files and browser-internal pages are no longer published from your history.**
  Only addresses containing a sign-in token were filtered, so `file://` paths from your
  disk and `chrome://` pages went to your storage. The tab sync already refused those for
  the same reason. They were also the pages other browsers reject, which is what kept the
  retrying going.
- **"Missing extensions" was effectively always empty.** Chrome uses the Web Store page as
  an extension's homepage when the extension doesn't provide one, so almost every
  extension looked like a match for almost every other. A store page is no longer treated
  as evidence.

### Changed

- **A device now notices when its own file has gone missing from your storage, and puts it
  back.** Konode skips an upload when nothing has changed since the last one, but it decided
  that from a record kept on the device itself, which knew nothing about the file being
  deleted at the other end. So if you tidied your sync folder by hand, or your provider lost
  a file, anything that does not change on its own was never uploaded again. The installed
  extension list is exactly that: it can sit unchanged for months. The device carried on
  syncing and silently stopped publishing. It only says so when it is actually putting the
  file back: there is one case where it cannot (a browser whose only open tab is Konode's
  own page has no session worth sending), and saying it anyway meant the same line once a
  minute in the log this release is trying to make readable.
- **You can see your devices, and forget the ones you no longer use.** Activity now lists
  every device with files in your sync folder, by name, with what it last uploaded and
  when. A device you have retired can be removed from there, which deletes its files from
  your storage. It removes no bookmarks from any browser: your other devices merged in
  whatever it contributed long ago, and all this stops is a machine that is gone from going
  on offering its old state forever. A device that is still running will upload itself again
  on its next sync, and the screen says so.
- **Devices carry their name to your other devices now**, and existing setups pick it up on
  the first sync after updating rather than showing every machine as unnamed. It used to travel only with your
  open tabs, so a device with Sessions turned off had no name anywhere but its own screen.
  Onboarding also lets you set the name during setup, which matters once you have two
  laptops the browser describes identically.
- **Statistics and Activity are one tab.** They answered the same question at different
  resolutions: how much has synced, and what happened. Encryption also moves to Storage,
  next to the provider it protects you from, instead of sitting in Advanced among the
  backups and developer options.
- **Settings has been reworked.** The panels now sit on one sheet rather than floating as
  separate cards, spacing and type follow a single scale, and the interface scales with
  your browser's font-size setting instead of ignoring it. Icons that only repeated the
  label next to them are gone. Long lists fade at the edge when there is more to scroll,
  and only then. Narrow windows and phones get a layout that fits, which matters because
  Konode does run on a phone today.
- **The activity log keeps what matters.** It used to fill with routine per-sync lines and
  turned over completely in about 17 minutes, so the "unusual deletion blocked" warning
  it points you to was usually gone before you looked. Warnings, errors and notable events
  (restore points, sign-ins, deletions recorded, recoveries) are kept; routine detail goes
  to the console only, where Debug mode already shows it.
- **A blocked mass deletion saves one restore point per incident, not one per sync.** It
  used to save one every cycle, which pushed all ten of your existing restore points out
  within about ten minutes, exactly when you'd want them.
- **The Git provider is listed as "GitHub".** It was labelled "GitHub / Gitea / GitLab",
  but only GitHub is supported; anyone following the label sent a self-hosted instance's
  token to GitHub and got a confusing "invalid token" back.
- **Firefox add-on id is now `konabe@proton.me`** (it was `konode@konode.org`, a domain
  that isn't ours). Nothing is published on Firefox Add-ons yet, so this is free to change
  now, but a Firefox test install has to be removed and re-added, and its Drive redirect
  URL changes with it.

- **Debug mode now fills the activity log, not just the console.** Verbose logging only
  ever reached the browser's developer console, so "turn on Debug mode and send us your
  activity log" couldn't produce anything. While the mode is on those lines are kept in
  Settings → Activity, where you can read and share them; turning it off stops that
  immediately.

### Upgrade notes

- **Nothing to do on Chrome.** Every device re-uploads each of its files once on the first
  sync after updating; after that it settles down. If a sync had previously got stuck,
  updating clears that too.
- **Your other devices may show "an unusual deletion was blocked"** if bookmarks you
  deleted a while ago never managed to propagate. That is the safety net doing its job.
  A restore point is saved, and nothing is lost.
- **"Test connection" may now report a problem it used to hide**. That's the fix, not a
  new fault.
- **Sensitive tab addresses that were already synced stay in the file's history** if you
  sync to GitHub, because every sync is a commit. Konode stops sending them, and
  overwrites the current file, but it can't rewrite your repository's past.
- **A Firefox test install must be removed and re-added** because of the add-on id change;
  it starts fresh, and its old files on your storage become unused.
- **Optional:** clearing the activity log (Settings → Activity) drops the old noisy
  entries, and with them the WebDAV addresses recorded before this release.

### Tooling

- The test suite went from 180 to 407 tests. Every fix was checked by putting the old
  behaviour back and confirming the new tests fail, including four places where the test
  doubles were hiding the bug and had to be made to behave like a real browser
  (bookmark position validation, alarm scheduling, history normalization and visit counts).
- `npm run build:firefox` now prints the Drive redirect URL derived from the add-on id, so
  the link between the two can't drift silently again.

## [1.1.0] - 2026-07-27

Bookmark restore points, a storage picker built around real providers, and two new
Settings tabs. Nothing about the sync format changed, so existing setups keep syncing
and map onto their new provider card without a re-sync.

### Added
- **Bookmark restore points**: timestamped copies of your bookmark tree, stored on
  your own backend. Create one by hand in Settings, Activity, or let Konode save one
  automatically when it refuses an unusual mass deletion from another device.
  Restoring adds back bookmarks missing here and never deletes anything; the newest
  10 are kept and you can delete any of them yourself. Encrypted like everything else
  when end-to-end encryption is on. The bookmark count for each restore point is held
  in a small index on your backend, encrypted with your passphrase, so every device
  shows it while the storage provider cannot read it.
- **A card per storage provider** in both Settings and first-run setup: Google Drive,
  Nextcloud/ownCloud, pCloud (EU or US), Koofr, Fastmail, GitHub/Gitea/GitLab, and
  WebDAV for anything else. Each has its real logo, inlined so nothing is fetched
  from another server. Nextcloud takes just your server host and keeps a
  subdirectory install intact; pCloud has a region switch. Picking a card no longer
  means digging through a dropdown inside a WebDAV row.
- **Activity tab**: the audit log moved out of the popup into a full-width tab,
  newest first, with an errors-only filter and Clear log. The popup keeps a link to
  it.
- **Statistics tab**: counts for this device, sync activity including how much data
  has moved, and how many other devices you are reaching. All computed locally.
- **Setup card** in Settings until a backend and a data type are configured, with
  buttons that jump to the right tab. Useful where the first-run tab never opens.
- **Feedback links** in Settings, Advanced: a GitHub issues link and a mailto.
  Both only do something when you click them. Konode still has no server, sends no
  telemetry, and pings nothing when you uninstall it.
- **Popup** shows your provider's actual name (for example "Koofr") instead of the
  underlying backend type, plus a banner when a mass deletion was blocked.

### Fixed
- **Data transferred always read 0** in the new Statistics tab: the counter was
  declared but never written. It now tallies every payload pulled and pushed.
- **Restore points were never cleaned up across devices**: retention walked a
  device-local list rather than the files actually on the backend, so two devices
  each holding fewer than ten between them pruned nothing and the folder grew
  without limit. "Newest 10 kept" is now true on every device.
- **Two restore points taken in the same millisecond** collided on their filename
  and the second silently replaced the first.
- **Button heights** across Settings were set by text metrics, so neighboring
  buttons rendered 2-3px apart (Save changes sat shorter than Test Connection).
  They now share one height.
- **Unknown Statistics values** showed a dash that read like a missing number; they
  now say "n/a", which is what an ungranted permission actually means.

### Changed
- **American English throughout**, and em and en dashes removed from everything a
  user or visitor reads, including the extension description shown in your browser's
  extensions page.
- The README now states plainly that Konode is built with AI assistance and
  human-reviewed.

## [1.0.2] - 2026-07-21

Cross-engine hardening from testing sync across Brave, Firefox, and Orion (WebKit).

### Fixed
- **Bare-origin bookmark duplication across engines**: Chromium/Firefox store a
  bare origin as `https://site/` (trailing slash) while WebKit stores `https://site`;
  the merge keyed on the raw string and re-added the peer's form every sync
  (unbounded; seen live as one bookmark multiplying). URL identity is now matched on
  a canonical key; distinct paths still stay distinct.
- **Session restore only opened the first tab on WebKit/Orion**: the per-tab
  `tabs.create` loop was cut short by the popup blocker. Restores now open all tabs
  in a single `windows.create`.
- **Orion "Favorites" bookmarks landed in the wrong root**: WebKit reuses Chrome's
  numeric root ids with different meaning (id 3 = Favorites, not mobile). A root
  titled "Favorites" now maps to the bookmarks bar.
- **History visit times & Firefox import**: the original visit time is preserved on
  Firefox (via `visitTime`, rounded to an integer since Chrome emits fractional ms);
  Chrome is unchanged (its API can't set visit times).
- **Auth tokens no longer synced in history**: history URLs carrying an OAuth/reset
  token (`…#access_token=…`, `?id_token=…`, etc.) are excluded from sync (they stay
  in the local browser history); a per-URL import failure is now a quiet host-only
  warning instead of an error logging the full URL.
- **Popup "No backend configured" flash**: the popup read settings via a message to
  a possibly-cold worker and painted its empty initial state first; it now reads
  storage directly and gates the banner on settings having loaded.

### Added
- **Cross-browser extension matching**: synced extensions are tagged with their
  source store; "installed here?" matches same-store by id and cross-store by name /
  homepage, and install links are host-pinned to the current browser's store (a Chrome
  Web Store id can't resolve on Firefox, so cross-store links go to a name search).

## [1.0.1] - 2026-07-20

First post-launch patch, from testing the published build on more browsers.

### Fixed
- **Google Drive sign-in on engines without `launchWebAuthFlow`**: on iOS WebKit
  browsers (e.g. Orion) the interactive sign-in either isn't implemented or throws an
  opaque native error (`undefined is not an object (evaluating 'parameters.length')`).
  The Drive option is now feature-gated (hidden behind a "not available in this
  browser; use GitHub or WebDAV" note when the API is absent), and any non-cancel
  sign-in failure surfaces that friendly message instead of the raw engine error.
  iOS / WebKit remains unsupported overall (onboarding also doesn't open there); this
  just keeps the Drive path from dead-ending. GitHub and WebDAV are unaffected.

## [1.0.0] - 2026-07-19

The build submitted to the Chrome Web Store for review (2026-07-19) and **published
2026-07-20** (item `mmlfiiimnpnjcjhhbldenpcmnibedkfa`): E2EE hardened end-to-end,
Firefox supported, the brand applied everywhere, store packaging + releases wired up,
and a round of pre-submission security hardening.

### Security / E2EE hardening
- **Stopped uploading the passphrase verifier**: `encrypt("konode-verify-v1")`
  on third-party storage was an offline brute-force oracle on the passphrase.
  A mismatch now surfaces via the payload's GCM decrypt failure (same loud
  `PassphraseError`); legacy peers' verifiers are still checked on download.
- **Passphrase strength floor**: a new manually-typed E2EE passphrase must be
  ≥12 characters (options + onboarding, with an honest "guessable offline"
  explanation); generated keys and already-saved passphrases are unaffected.
  PRIVACY.md and the README now document the offline-guessing threat model.
- **E2EE mixed-state self-healing**: encryption disagreements between devices
  no longer hard-abort or deadlock the group: the device uploads its own
  (correctly-encrypted) file first, mismatches are per-device warnings, an
  orphaned plaintext file is skipped silently instead of warning forever, and
  enabling/rotating E2EE forces a re-upload in the new form so a mixed group
  converges in one cycle.
- **No plaintext downgrade paths**: a device with E2EE off no longer decrypts
  encrypted peers (it gets an "enable E2EE here" nudge instead of silently
  re-publishing the group's data in plaintext), and a manual conflict-resolve
  can't import a plaintext packet into an encrypted device.
- **Passphrase UX**: double-entry confirm for new passphrases (options +
  onboarding), content-free saved-secret masking, reveal-on-demand eye,
  explicit confirmation before turning E2EE off.
- **Leaked OAuth client retired**: the Google OAuth client secret briefly
  committed to source now lives in a gitignored `.env` and is injected at build
  time (`VITE_GOOGLE_CLIENT_SECRET`); the exposed client was deleted in the
  Google Cloud Console and replaced with a fresh one.
- **Peer extension `storeUrl` rebuilt locally**: the popup/options opened a peer's
  synced `storeUrl` verbatim; with E2EE off, anyone with backend write access could
  forge it and point "Install" at a phishing page. It is now reconstructed from the
  extension id, pinning the host to the Web Store.
- **`management` is strictly read-only**: dropped the dead `SET_EXTENSION_ENABLED`
  handler (no UI ever sent it), so the code matches the read-only permission
  justification and PRIVACY.md.

### Added
- **Firefox support**: runtime APIs routed through `webextension-polyfill`,
  browser-agnostic bookmark-root resolution (Chrome `1/2/3` ⇄ Firefox
  `toolbar_____`/`menu________`/`unfiled_____` by kind), a Firefox manifest
  variant (`npm run build:firefox` → `dist-firefox/`, event-page background,
  gecko id `konode@konode.org`, `data_collection_permissions: none`), web-ext
  packaging + lint, and a per-browser OAuth redirect. Runtime-verified on
  Waterfox 140 (onboarding, Drive OAuth, sync, session restore, history).
- **Folder reorder sync**: a folder repositioned among its siblings propagates
  via a path-keyed move-log with **anchor-based** placement (lands next to the
  same neighbor on every device, not at a raw index that doesn't translate);
  cross-parent folder moves relocate their bookmarks and the emptied shell is
  pruned on the receiver.
- **Configurable mass-delete guard**: the bookmark bulk-delete safety cap is a
  setting (default 60%, 50-95% in Settings → Advanced) instead of a hard 50%,
  so a legitimate bulk cleanup propagates while a corrupt tombstone log still
  can't wipe a tree.
- **Per-device sessions & extensions everywhere**: the popup lists every peer
  device's session with per-device restore, and unions every peer's extension
  list.
- **Brand**: peer-mesh logo mark, reproducible icon generation, full UI
  re-skin (popup, options, onboarding) with system light/dark, self-hosted
  fonts, and the Proton-Pass-style top-tab settings layout.
- **Docs for launch**: marketing README with screenshot, GETTING_STARTED,
  TROUBLESHOOTING, PRIVACY.md (near-final), STORE_LISTING.md (CWS listing +
  OAuth consent copy), MPL-2.0 LICENSE, build-fingerprint verification script
  (`npm run checksum`).

### Fixed
- **Move-to-last-position convergence**: Chromium's same-parent move quirk
  (an index measured against the pre-removal array) made "move to the end"
  land one slot short forever; the corrective nudge now clamps to the child
  count so it actually reaches the last slot.
- **Cross-root move safety**: a peer root that can't be confidently mapped
  (e.g. an older build's foreign id) can no longer yank an existing bookmark
  into the default root.
- **Duplicate-URL deletion safety**: deleting one of several identical-URL
  bookmarks no longer tombstones (deletes) the URL on every peer.
- **Audit backlog cleared** (4-agent review, 2026-07-07): sticky manual
  conflict resolutions (no more re-notify loop), the sync-lock race, backend
  list errors no longer masquerade as "no peers", export works without the
  history permission, SecretField renders the generated key.
- **Onboarding permission request**: the WebDAV server origin and the optional
  data-type permissions are now requested in a single `permissions.request` call; a
  second call after an `await` could be rejected for lacking a user gesture,
  stranding WebDAV users who also enabled a data type.

### Tooling
- CI now **enforces** lint (`continue-on-error` removed), runs `npm ci` from
  the committed lockfile, and `eslint-plugin-react-hooks` is wired in
  (rules-of-hooks as an error, exhaustive-deps advisory).
- Single-source version (`scripts/sync-version.mjs` stamps the manifests from
  `package.json`).
- **Chrome Web Store packaging**: `npm run package:chrome` builds, then zips a
  staging copy of `dist/` with the manifest `key` removed (the CWS rejects `key` on
  a first upload) while `dist/` keeps it for unpacked-dev ID stability.
- **Release workflow**: pushing a `v*` tag builds and publishes a GitHub release
  with the packaged Chrome zip (source build, no client secret); v1.0.0 released.

## [0.1.0]

The first working build, hardened over a review + fix pass. Highlights:

### Added
- **End-to-end encryption (opt-in)**: AES-256-GCM + PBKDF2 (600k), wired into the
  sync engine. Toggle + passphrase in Settings → Advanced. Data is encrypted
  before it leaves the device; the storage provider can't read it.
- **WebDAV backend made functional**: requests an `optional_host_permissions`
  grant for the user's server origin at runtime (it couldn't reach arbitrary
  hosts before).
- **Bookmark deletion sync (tombstones)**: deletes now propagate across devices
  instead of resurrecting; folder hierarchy preserved; 90-day tombstone GC; a
  >50% mass-delete is refused as a safety net.
- **Conflict resolution UI**: popup banner (Keep local / Use remote) + a working
  "Manual" strategy; per-item (per-URL) resolution.
- **Session restore** and **extension re-enable** message handlers; audit log
  mounted in the popup with a Clear action.
- Onboarding requests optional permissions for the chosen data types.
- **Session-manager UI**: the popup now lists the open-tab session of **each** peer
  device (name, tab count, last-synced time) with a per-device Restore button,
  instead of a single "Restore tabs from another device" button. Remote sessions are
  stored device-keyed (`konode_remote_sessions` is now a map), so every peer's
  session survives instead of only the newest. Sessions carry the device label so
  the list is human-readable.
- **Cross-peer extension aggregation**: `konode_remote_extensions` is now device-keyed
  too; the popup unions every peer's installed-extension list (deduped by id), so
  "missing on this device" reflects extensions installed on **any** other device, not
  just the most recently synced one.

### Changed
- **Saved secrets are masked in Settings**: once a token / WebDAV password / E2EE
  passphrase is saved, the field shows a `••••••` summary (last 4 chars) instead of
  binding the raw value into the DOM; a "Replace" action re-enters edit mode. The
  reveal (eye) toggle is now per-field, so unmasking one secret no longer unmasks the
  others. (A `type="password"` field always exposes its value in the DOM; this keeps
  the saved secret out of casual inspection / screenshots / screen-sharing. Note:
  credentials are still stored in `chrome.storage.local`, the standard extension
  model, since there's no OS secret store.)
- **GitHub upload 409 fixed at the root**: GitHub sends `Cache-Control: max-age=60`
  on contents reads, so the browser HTTP cache returned a *stale* SHA for up to a
  minute after a write; every PUT (and every retry) then 409'd with "…does not
  match". All backend reads (GitHub, WebDAV, Drive) now use `cache: "no-store"` so a
  peer file / SHA is always fresh; the GitHub SHA is re-read on each attempt and a 409
  is retried with exponential backoff (up to 5 attempts).
- **No redundant uploads**: each data type now records the checksum it last uploaded
  and skips the upload when nothing changed, so a sync that finds nothing new no
  longer writes a fresh commit every interval (which also removed the main 409
  trigger). Made the bookmark payload deterministic (a missing `dateAdded`, e.g. on
  the root node, now falls back to `0` instead of `Date.now()`) so an unchanged tree
  hashes identically across syncs and devices.
- **Resilient downloads**: a single corrupt or partially-written remote file (e.g.
  trailing bytes after the JSON: "Unexpected non-whitespace character after JSON")
  no longer aborts the whole sync. Each backend skips a file it can't parse, and the
  engine skips any peer whose file fails to apply (parse / checksum / import), folding
  in the rest. The owning device rewrites its file cleanly on the next sync.
- **Forgiving GitHub repository field**: the backend now normalizes the Repository
  value to an `owner/repo` slug (`normalizeRepoSlug`), accepting a pasted
  `https://github.com/owner/repo` URL, a `.git` suffix, a trailing slash, or the
  `git@github.com:` SSH form. Previously these produced a confusing "repository not
  found" because the GitHub API 404s on a full URL or a trailing slash.
- **Sync model**: pull peer file first (excluding our own), then for additive
  data types always merge the peer in and push the merged result. Fixes "remote
  changes never arrived" under Last Write Wins.
- **Multi-device merge**: `IBackend.download` → `downloadAll`, returning every
  peer file; the engine folds them all in per sync (oldest→newest) so 3+ devices
  converge in one cycle instead of relying on slow transitive propagation.
  Per-strategy deletion handling stays inside the bookmark merge; prefer-local now
  consistently adds peers' new bookmarks while ignoring their deletions.
- **Newest-peer ordering**: the engine now sorts downloaded peer packets newest-first
  by their `timestamp` (`orderPeersByTime`) before resolving conflicts and folding
  them in. GitHub and WebDAV list files in arbitrary order, so `peers[0]` (the LWW /
  manual-conflict baseline) was previously an arbitrary peer rather than the most
  recent one. Uses the same clock LWW relies on, with no per-backend commit/mtime lookups.
- **Near-instant sync-on-change** (~1s debounced fast path) with a 30s backstop
  alarm; periodic pull floor lowered from 60s to Chrome's real 30s minimum.
- Integrity: checksums are now **SHA-256** (was a mislabeled djb2) and **verified
  on download**; payload shape validated before import.
- Retry policy: only transient failures (network, 408/429/5xx via `HttpError`)
  are retried; deterministic 4xx no longer waste attempts.
- Google Drive backend: `res.ok` checks everywhere (no more silent "success" on a
  failed upload); create path uses `multipart/related`; downloads via the
  authenticated GitHub Contents API instead of the unauthenticated `download_url`.
- Permissions: `history`/`tabs`/`management` moved to `optional_permissions`
  (requested on enable); unused `sessions` permission and dead Mega host removed;
  `api.github.com` added.
- Security/UX: fine-grained GitHub token link (single repo) instead of classic
  `repo` scope; WebDAV `http://` warning; honest Drive credential copy; external
  Google Fonts fetch removed (privacy).
- Bookmark merge preserves the remote folder structure (no longer flattened into
  "Other Bookmarks"); replace guards against an empty/malformed remote tree and
  snapshots local first; root matching uses Chrome's stable IDs.

### Fixed
- **Bookmark moves now propagate.** The URL-keyed merge ignored a bookmark's
  folder, so moving one between folders didn't sync. Added a per-URL move log
  (`konode_bm_moves`, recorded on `onMoved`) carried in the payload; the merge
  relocates a locally-present bookmark to the peer's folder with last-write-wins
  (prefer-local keeps local placement; prefer-remote always adopts the peer's).
  The merge also passes the **position/index** from the peer's tree to
  create/move, so a moved or added bookmark lands at the peer's spot instead of
  always at the end of the folder.
- **Empty folders no longer resurrect.** Folders carry no tombstone (those are
  URL-keyed), so a deleted folder's bookmarks were removed but the empty folder
  synced back from a peer. Now the merge creates folders lazily (only when a
  descendant bookmark is actually added) and empty folders are pruned from the
  synced payload, so deleting a folder propagates fully.
- `type-check` now passes (non-existent `SyncTab` type; `includes("tabs")` against
  a value no longer in `DataType`; `Uint8Array<ArrayBuffer>` for Web Crypto).
- Live popup status (the MV3 `chrome.extension.getViews` broadcast gate was dead).
- **MV3 race**: every entry point awaits `ensureInit()`, so sync works with the
  worker cold, not only while the SW DevTools console is held open.
- Multi-device: `download()` excludes the caller's own file across all backends,
  so a device stops masking its peers.
- `bufferToBase64` RangeError on large encrypted payloads (chunked encoding).

### Removed
- Unused deps (`zustand`, `webextension-polyfill`) and dead components
  (StatusBadge, SyncButton, DataTypeRow).

### Tooling
- **Vitest** suite (encryption, retry policy, conflict resolver, tombstone
  helpers, remote-session/extension normalizers, peer ordering, **bookmark merge +
  `SyncEngine.syncType`**) with an in-memory `chrome.storage` + `chrome.bookmarks`
  stub; **ESLint** flat config; **GitHub Actions CI** (type-check + test on every
  push). Scripts: `test`, `test:watch`, `lint`, `check`.

### Drive OAuth (refresh token)
- Replaced the implicit grant (token died after ~1h, silent re-auth unreliable on
  Brave) with **PKCE authorization-code + refresh token** (new shared module
  `lib/backends/gdrive-oauth.ts`). One interactive consent stores a refresh token;
  access tokens then refresh via a plain POST (no UI, no browser session), so
  background sync survives indefinitely on every Chromium browser. backend +
  options + onboarding share the one implementation.
- _Needs runtime verification (re-sign-in required to mint the first refresh
  token)._

### UI / brand re-skin
- **Popup re-skinned** to a system-following light/dark theme (new `sk-*` design
  tokens; opts in via a `.sk-body` class). Content-fit height with a pinned
  header + a single scrolling body, so the audit log grows the popup instead of
  pushing the header off the top at Chrome's ~600px ceiling; the leftover black
  strip after toggling the audit log is gone. Active streams became a 4-circle
  icon grid (green = OK, amber spinner = syncing) and the wordmark header was
  dropped (settings moved into the status row).
- **Options + onboarding re-skinned** to the same palette: accent moved from
  Google blue to the signal green, with light/dark surfaces, borders and focus
  rings retuned. Fixed green-on-green contrast where the selected-card tint and
  the icon chips were the same pale green (account avatar, Disconnect button,
  selected backend icon, sidebar/onboarding logo).
- **Self-hosted fonts**: Inter + JetBrains Mono (latin-subset woff2, OFL) bundled
  under `public/fonts`, wired via `@font-face`; the external Google Fonts fetch is
  gone for good and DM Sans is no longer referenced. Nothing leaves the device.

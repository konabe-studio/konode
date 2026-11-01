# Tab groups by hand, before 1.5.0 ships (#11)

## What is already machine-checked — don't spend hands on it

`npm run e2e:tab-groups` runs six passes with real browsers and a real sync (see
`scripts/e2e/README.md`). Between a Chromium profile and **Firefox 159**, in both
directions, it already asserts: the tabs come back together, the group's **name and colour**
survive, a **pinned** tab is never grouped, a session with no groups carries no `groups` key
at all, and a device without the `tabGroups` permission still restores membership with a
colour the browser picks.

A sixth pass runs on a real **Firefox 138** — case 4 below, now automated. That version does
not merely lack `tabGroups`, it has never heard of the permission, so asking whether it is
held *throws* instead of answering false, and one unknown permission fails the whole
request. That is the failure that could have stopped setup dead, and no Chromium profile
reproduces it. Unpack 138 into `~/.local/opt/firefox-138/` or set `E2E_FIREFOX_138`; the
pass skips itself when there is none. Fifty-one checks, about five minutes.

So the list below is only what automation cannot reach: the prompts, the pixels, and your
own storage.

## Set-up

- **Chromium side**: `npm run build`, then `chrome://extensions` → Developer mode → *Load
  unpacked* → `dist/`.
- **Firefox side**: `npm run build:firefox`, then `about:debugging#/runtime/this-firefox` →
  *Load Temporary Add-on* → `dist-firefox/manifest.json`. It is gone when Firefox closes,
  which is fine except for case 7.
- **Use your own storage** (WebDAV / Drive / Nutstore), not a local server. The automated
  pass syncs through a throwaway WebDAV server on localhost, so your real backend, your
  real latency and your real folder are untested.
- Name each device something you will recognise in the popup, and keep **Settings →
  Activity** open on both. If a case fails, *Copy log* there is the evidence to keep.
- Make a group the browser's own way: select two tabs → right-click → *Add tabs to new
  group*, then name it and pick a colour.

## The cases

**1. The prompt in the wizard (Chrome).** Fresh profile, run setup, switch **Open tabs**
on, press *Finish & Sync*.
→ Expect **one** prompt that covers tabs *and* tab groups ("View and manage your tab
groups"), never two, and never a second one later. Then do it again and **decline** it:
setup must still finish and say what is off, and must not bounce you to the extensions page
in a loop.

**2. The prompt in Settings (Chrome).** Settings → Data Types: Open tabs off, then on.
→ Same single prompt. Then the separate **tab group names** switch: off → publish from here
and check the peer gets the tabs grouped but **unnamed**; on → the names are back. Opening
the **popup** must never ask for anything.

**3. Firefox grants it quietly.** The same two steps on Firefox 139+.
→ Expect **no prompt at all** and the switch to end up on.

**4. Firefox 138 — the version with `tabs.group` and no `tabGroups`.** ~~No automated pass
covers it.~~ **Now machine-checked**: `npm run e2e:tab-groups` drives a real 138 and asserts
that the capability question throws there, that the extension settles on `membership`
instead of failing, that settings apply and a sync completes, and that a named group from
Chromium arrives **grouped but unnamed**. Nine checks.

What is left by hand is only the part that lives in browser chrome: run **setup itself** on
138 with Open tabs on, and confirm the wizard finishes and that the tab group names switch
is absent or reads as unavailable. Get 138 from
`https://ftp.mozilla.org/pub/firefox/releases/138.0/linux-x86_64/en-US/` and run it with
`-profile` on a fresh directory so it cannot touch your main profile.

**5. What you actually see.** In each direction, after a restore:
→ the group lands in **the window you were in**, not a new one; the name and colour show on
the **tab strip**; and a group that was **collapsed** on the sender arrives **expanded** —
`collapsed` is deliberately not synced, so this is correct, not a bug.

**6. Real storage with encryption on.** Turn E2EE on on both devices with the same
passphrase, publish a named group, restore it.
→ Expect it to work exactly as without. The automated pass runs with encryption **off**, so
this is the only check that groups ride inside the encrypted payload.

**7. An older Konode reads a new packet.** In a third profile, load 1.4.0 (`git stash` your
work, `git checkout v1.4.0 && npm run build`, or just use the store build) and sync it
against a device on this branch that publishes a named group.
→ Expect: the tabs restore **ungrouped**, and the Activity log says nothing alarming. The
claim being tested is that an older build ignores `groups` rather than choking on it.

**8. Chrome's saved groups.** Right-click a group → *Save group*, then close it.
→ Expect: nothing of it is published (only live groups are reachable to an extension), the
sync is quiet about it, and the groups still open travel as usual.

**9. Restore the same session twice.** Restore a peer's session; then, on the sender, add a
tab to one group and publish again; restore again on the receiver.
→ Expect: only the **new** tab opens, it joins the **right** group, and the tabs already
open stay where you had put them — including any you had moved out of a group by hand.

**10. A session with no groups at all.** Ungroup everything on both devices and sync a few
times.
→ Expect the Activity log **not** to report a change on every sync. An ungrouped session's
checksum must not have moved when groups shipped.

**11. A big session.** 20+ tabs, two of them groups, restore on the peer.
→ Expect the popup to ask before it opens them, and the groups to come out right once you
accept.

**12. Pinned plus grouped.** Pin one tab, group two others, publish, restore.
→ Expect the pinned tab back **pinned and ungrouped**, the others grouped.

## Out of reach by hand, noted so nobody hunts for it

A restore that splits across two windows (groups are then restored once per window) only
happens on an engine that blocks the second programmatic tab open — WebKit/Orion. There is
no way to force it in Chrome or Firefox, and the unit suite covers the split.

## If a case fails

Copy the Activity log on **both** devices, note which one published and which restored, and
both browser versions. If E2EE is off you can read the packet straight off the storage:
`konode_sessions_<device_id>.json`, where `groups` and each tab's `group` index are what to
compare against what you saw.

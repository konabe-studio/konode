# Tab groups by hand, before 1.5.0 ships (#11)

## What is already machine-checked — don't spend hands on it

`npm run e2e:tab-groups` runs ten passes with real browsers and a real sync (see
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
pass skips itself when there is none.

Cases 6, 7, 9 and 10 are automated too: encryption on with the same passphrase on both
devices, a built **1.4.0** reading a packet that carries groups, a session restored twice,
and an ungrouped session whose checksum does not move. The 1.4.0 pass needs a dist built
from the tag — `E2E_DIST_140=/path/to/v1.4.0/dist` — and skips itself without one. Seventy
checks, about eight minutes.

So the list below is only what automation cannot reach: the prompts, the pixels, and your
own storage. **Case 9 found a bug, and it is fixed** — see it below.

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

**6. Real storage with encryption on.** **Half machine-checked now**: a pass turns E2EE on
with the same passphrase on both devices and asserts the packet goes up encrypted, that the
group's name is nowhere in the ciphertext, and that the grouping, names and colours all
survive the round trip through it.

What is left by hand is the word *real*: your own WebDAV / Drive / Nutstore account, your
latency, your folder. The pass still syncs through a throwaway server on localhost.

**7. An older Konode reads a new packet.** **Now machine-checked.** A peer is launched from
a dist built at the v1.4.0 tag and fed a packet that carries two named groups. It accepts
it, opens all the tabs, leaves every one ungrouped, and writes nothing at error level. So
an older build ignores `groups` rather than choking on it, as claimed.

**8. Chrome's saved groups.** Right-click a group → *Save group*, then close it.
→ Expect: nothing of it is published (only live groups are reachable to an extension), the
sync is quiet about it, and the groups still open travel as usual.

**9. Restore the same session twice.** **Now machine-checked — and it found a bug.**

Only the new tab opened, as intended, and the tabs already open were left where you put
them. But the new tab did not join the group already on screen: it formed its own, and the
name and colour were applied to that one too, so the receiver ended up with **two groups
called Work side by side**. Confirmed against two real browsers before anything was
changed.

`restoreGroups` groups only the tabs that restore opened, deliberately, so a tab you have
since moved is left alone — but nothing about that rule required a second group.
`tabs.group` takes a `groupId`, which adds to an existing group without touching its other
members. It now joins the group that already holds a tab from the same session group in
that window, matched by the tab rather than by the group's name, and a joined group keeps
the title and colour it has, since it is yours and you may have renamed it. Two unit tests
hold it, so CI guards it even though the e2e pass does not run there.

**10. A session with no groups at all.** **Now machine-checked.** An ungrouped session
carries no `groups` key at all, and a second sync with nothing changed leaves the checksum
exactly where it was — so a device that never groups a tab publishes nothing new and the
Activity log has nothing to report.

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

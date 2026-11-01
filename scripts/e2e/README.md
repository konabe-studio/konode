# End-to-end passes

Real browsers, the extension loaded in each, and a sync between them that actually happens.
These are not the unit suite: nothing here is mocked, and nothing here runs in CI. They
exist for the claims a mock cannot check — that what one browser publishes is what another
one gets.

```bash
npm run build && npm run build:firefox   # the passes load dist/ and dist-firefox/
npm run e2e:tab-groups
```

- `E2E_HEADFUL=1` runs the browsers on screen, which is how you watch one fail.
- `E2E_KEEP=1` leaves the profiles and the patched builds behind for a look.
- `E2E_FIREFOX=/path/to/firefox` picks the Firefox to use. When it is set and the path is
  not there, the Firefox passes skip, which is also how you ask for the Chromium half
  alone. Unset, it looks for a Firefox unpacked under `~/.local/opt`, then in
  `/usr/lib/firefox` and the other usual places.

## tab-groups.mjs (#11)

Five passes. A group is made in one browser with the browser's own API, published, and read
back out of the other one after a restore; the packet is asserted as it sat on the server.
Three run between two Chromium profiles, including both sides of the `tabGroups` permission,
and two run between Chromium and a real Firefox, in each direction. The file's header says
what each pass is for and what none of them covers.

The short version of why the permission matters as much as the engine: `tabGroupSupport()`
answers `membership` without `tabGroups` and `full` with it, and Firefox 138 is a browser
that has `tabs.group` and no `tabGroups` at all — so a Chromium profile that was never
granted the permission takes the same branch that version does.

A sixth pass runs on a real Firefox 138, which is not the same thing as reproducing its
branch. There the permission is UNKNOWN, so `permissions.contains({permissions:
["tabGroups"]})` throws rather than answering false, and one unknown permission fails the
whole request — the failure that could have stopped the setup wizard. Unpack 138 into
`~/.local/opt/firefox-138/` (so the binary is at `firefox/firefox` inside it) or point
`E2E_FIREFOX_138` at one; the pass skips itself when there is none.

## How each engine is driven

**Chromium** comes with Playwright (`playwright-core`, already a dependency): a persistent
context with `--load-extension`, and the extension's own service worker is reachable from
the harness, so the pass drives it from outside (`lib/peer.mjs`).

**Firefox** cannot be driven that way. Playwright has no API for loading an extension into
it, and a WebDriver session cannot reach `browser.*` from a content page, so there is
nothing to drive from outside. Instead `web-ext` installs the build as a temporary add-on
over Firefox's remote debugging protocol — the one way an unsigned build runs in a release
Firefox — and the driver lives *inside* the extension (`lib/driver/`), posting what the
browser ended up holding back to `lib/reporter.mjs`. `MOZ_HEADLESS` is how that run goes
headless; web-ext has no flag for it.

Both halves load a **copy** of the build with `tabs` and `tabGroups` promoted from optional
to required, because the permission dialog is drawn in browser chrome where no automation
can click it. `dist/` and `dist-firefox/` are never modified.

## The WebDAV server

`lib/webdav-server.mjs` answers the five requests `src/lib/backends/webdav-backend.ts`
makes, in memory, and takes any credentials. The promo pipeline (PR #68) carries the same
file at `scripts/promo/lib/webdav-server.mjs`; whichever of the two lands second should fold
them into one shared helper rather than keep both.

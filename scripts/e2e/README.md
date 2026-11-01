# End-to-end passes

Two throwaway browser profiles, the extension loaded in both, and a sync between them that
really happens. These are not the unit suite: nothing here is mocked, and nothing here runs
in CI. They exist for the claims a mock cannot check — that what one browser publishes is
what another one gets.

```bash
npm run build          # the passes load dist/, they do not build it
npm run e2e:tab-groups
```

`E2E_HEADFUL=1` runs the browsers on screen, which is how you watch one fail.
`E2E_KEEP=1` leaves the profiles and the patched builds behind for a look.

## tab-groups.mjs (#11)

A group is made in one browser with the browser's own API, published, and read back out of
the other after a restore. The file's header says what each of the three passes is for and
what none of them covers; the short version is that the line that matters for groups is not
Chromium against Gecko but whether `tabGroups` is held, and a Chromium profile without the
permission takes the same branch Firefox 138 does.

Two things this cannot reach, both named in the file: **Firefox**, because Playwright has no
way to load an extension into it (`web-ext run` is how that would be added), and the
**permission prompt**, because Chrome draws it in browser chrome where no automation can
click it.

## The WebDAV server

`lib/webdav-server.mjs` answers the five requests `src/lib/backends/webdav-backend.ts`
makes, in memory, and takes any credentials. The promo pipeline (PR #68) carries the same
file at `scripts/promo/lib/webdav-server.mjs`; whichever of the two lands second should fold
them into one shared helper rather than keep both.

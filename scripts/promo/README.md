# Promo video pipeline

Shoots and cuts the promo described in [`docs/promo/shot-list.md`](../../docs/promo/shot-list.md).
Eight shots, about a minute. Five are kinetic type, three are the real extension running
in a real browser.

The point of building it as a pipeline rather than editing a video by hand is that the
same film can be re-shot in every language Konode ships in, with the same cuts, the same
timing and the same frames. Only the words change.

```bash
npm run build                                    # the capture loads dist/
node scripts/promo/capture.mjs --lang=en         # frames into promo-out/en/
node scripts/promo/assemble.mjs --lang=en        # frames into a video
```

## What you need

- **Chrome for Testing**, once: `npx playwright install chromium`. Not the Chrome on
  your machine: stable Chrome no longer honours `--load-extension` at all, so the
  extension never loads and every `chrome-extension://` page answers
  `ERR_BLOCKED_BY_CLIENT`. Pinning the testing build also means the shoot does not change
  under you when Chrome updates. On a distribution Playwright does not recognise, the
  download needs `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64` in front of it;
  running needs nothing.
- **ffmpeg** for the cutting step: `sudo apt install ffmpeg`. The capture step does not
  need it.
- A font covering the language you are shooting. Inter carries no CJK glyphs, so a
  Chinese cut on a machine without a CJK font renders empty boxes. `capture.mjs` warns,
  it cannot fix it.

## Adding a language

Copy `text/en.json`, translate it, name it after the locale. The file holds both the
words that appear on screen and the narration for that language, so one file is the whole
translation job.

```bash
node scripts/promo/capture.mjs --lang=de
node scripts/promo/assemble.mjs --lang=de
```

The narration is not generated here. Paste the `narration` block into whatever voice tool
you use, save the result per shot as `promo-out/<lang>/audio/shot-1.mp3` and so on, and
the cut picks them up. One file per shot rather than one long track is deliberate: shot
lengths are fixed across languages, so a line that runs long has to be caught at the cut,
and `assemble.mjs` says which shot and by how much. Shortening a line is the fix. Moving
the cut is not, because it moves it for one language only and the films stop matching.

Music, if any, goes in the same folder as `music.mp3` and is mixed low under everything.

## What is repeatable and what is not

The kinetic shots are drawn by `kinetic/`, which animates nothing by itself. The capture
asks it for one instant at a time, so the frames do not depend on the machine's speed and
a re-shoot years from now is identical. Design them by hand at
`/kinetic/?lang=hu&shot=3&t=1240` while the capture server is up.

The product shots drive a real browser, which cannot be seeked. Each beat gets a fixed
frame budget instead, so the timeline holds even when the browser is half a second slower
than last time.

## The product shots

Shots 4, 5 and 6 show the extension itself. The pieces they need are built and proven;
what is left is the choreography, which wants an eye rather than more plumbing.

**The sync in shot 4 is real.** `lib/webdav-server.mjs` is a small WebDAV server, enough
of one for the five requests `src/lib/backends/webdav-backend.ts` makes, holding
everything in memory. Two throwaway profiles sync through it with no account, no network
and no secrets, which is what keeps the shoot repeatable on anyone's machine.
`lib/webdav-server.test.ts` points the shipped WebDAV client at it and checks that a
packet written by one device is what the other one reads back, so the server cannot
quietly drift away from what the extension expects.

**The capture runs a patched copy of `dist/`.** Konode asks for loopback access only when
you point it at a WebDAV server, and that request is a Chrome dialog, which is browser UI
that no script can click. So `capture.mjs` copies the build into `promo-out/.dist` and
moves `http://127.0.0.1/*` from `optional_host_permissions` into `host_permissions`,
where loading unpacked grants it silently. Same code, same pixels, one permission
pre-granted instead of clicked. `dist/` itself is never touched.

**What still has to be decided.** Playwright records the page, never the browser around
it, so the bookmarks bar and the toolbar icon cannot appear in frame. Chrome's own
bookmark manager can: `chrome://bookmarks` screenshots cleanly, which makes
"device A's bookmarks beside device B's, and the new one lands on B" shootable with real
browser UI rather than a drawn mock-up. It renders light, so either the shot owns that or
the context is forced dark.

The other open end is that `src/` carries no `data-testid`, so anything that clicks
through onboarding leans on button text. `node scripts/promo/capture.mjs --probe` loads
the extension and writes every button and heading of `popup.html`, `onboarding.html` and
`options.html` to `promo-out/probe.json`, with a screenshot of each. Read that before
deciding whether the video pins selectors that may rot or the UI gains a few stable hooks.

## Output

`assemble.mjs` writes, per language:

| File | For |
|------|-----|
| `konode-promo-<lang>.mp4` | 1920x1080 master |
| `konode-promo-<lang>-1270.mp4` | 1270x714, silent, for a Product Hunt gallery |
| `konode-promo-<lang>-poster.png` | still from the moment the wordmark lands |

Everything under `promo-out/` is generated and git-ignored.

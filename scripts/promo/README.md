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

- **Google Chrome**, installed normally. `playwright-core` drives the copy already on the
  machine, so nothing downloads a second browser.
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

## Still open: the product shots

Shots 4, 5 and 6 are the ones that show the extension itself, and they are not wired up
yet. Two things stand in the way, and both want a decision rather than more code:

**The UI has no test hooks.** There is not a single `data-testid` in `src/`, so a script
that clicks through onboarding has to rely on text or class names, which break the next
time either changes. `node scripts/promo/capture.mjs --probe` loads the extension, dumps
every button and heading of `popup.html`, `onboarding.html` and `options.html` into
`promo-out/probe.json`, and screenshots each one. Read that first and decide whether the
video pins selectors that may rot, or the UI gains a few stable hooks.

**Shot 4 needs a backend.** It shows a bookmark made in one browser arriving in another,
which is not something that can be faked without the video becoming a lie. Three ways to
get a real sync between two throwaway profiles:

- A local WebDAV server, written for this. Needs no credentials and no network, and it
  would be reusable for manual QA. The backend speaks `MKCOL`, `PROPFIND`, `PUT`, `GET`
  and `DELETE`, so it is a small server rather than a full WebDAV implementation.
- A private GitHub repository and a fine-grained token, kept out of the repo.
- Google Drive, which means a real sign-in inside the capture and is the worst of the
  three to automate.

The local server is the one that keeps the shoot reproducible by anyone, on any machine,
without secrets.

## Output

`assemble.mjs` writes, per language:

| File | For |
|------|-----|
| `konode-promo-<lang>.mp4` | 1920x1080 master |
| `konode-promo-<lang>-1270.mp4` | 1270x714, silent, for a Product Hunt gallery |
| `konode-promo-<lang>-poster.png` | still from the moment the wordmark lands |

Everything under `promo-out/` is generated and git-ignored.

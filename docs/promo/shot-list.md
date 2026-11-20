# Promo video, shot list and narration

A 60-second promo for the stores, the README and social. Three movements: a kinetic
opening that states the problem, real product footage that proves the claim, a kinetic
close that carries the call to action.

The product footage is the spine. Everything else is framing. A sync tool is sold by
showing that the thing actually arrives on the other machine.

## Shot list

| # | Time | Type | On screen | Captured how |
|---|------|------|-----------|--------------|
| 1 | 0:00–0:05 | Kinetic | Black. "Your bookmarks. Your tabs. Your history." then, smaller, "Who else has a copy?" | HTML + CSS |
| 2 | 0:05–0:12 | Kinetic | The word SYNC, arrows from two browsers routed through a nameless box in the middle. The box lights up as everything passes through it. | HTML + CSS |
| 3 | 0:12–0:18 | Kinetic | Box dissolves, arrows redraw straight to a drive icon. Konode wordmark forms. Line: "Sync to storage you already own." | HTML + CSS, wordmark from `public/icons/wordmark.svg` |
| 4 | 0:18–0:32 | **Product** | Two browser windows side by side. Left: a bookmark is added, the Konode popup shows the sync. Right: the same bookmark lands in the bar. Zoom on the moment it appears. | Playwright, two profiles, real `dist/` build |
| 5 | 0:32–0:40 | **Product** | The backend picker in onboarding: Google Drive, GitHub, WebDAV. Cursor settles on one. | Playwright, `onboarding.html` |
| 6 | 0:40–0:48 | **Product** | The popup: four data streams active, a restored session from another device, the missing-extensions list. | Playwright, `popup.html` |
| 7 | 0:48–0:56 | Kinetic | Three lines snap in: "No account." / "No Konode server." / "Optional end-to-end encryption." Then, small: "Open source, MPL-2.0." | HTML + CSS |
| 8 | 0:56–1:02 | Kinetic | Wordmark, store badges, repository URL. | HTML + CSS |

## Narration

Written to be pasted into a voice generator as one block. Roughly 115 words, which lands
near 60 seconds with the pauses the visuals need. The shot numbers are not spoken.

> (1) Every sync tool asks you to trust a server.
>
> (2) Your bookmarks, your tabs, your history, all of it through a company's machines,
> and you take their word for what happens there.
>
> (3) Konode syncs the same things. It just doesn't route them through anyone.
>
> (4) Add a bookmark on one browser, and it's on the other. Not because we copied it,
> because your own Drive did.
>
> (5) You pick where it lands. Your Google Drive, a private GitHub repository, or any
> WebDAV server.
>
> (6) Bookmarks, open tabs, history, and which extensions are missing on the machine
> you're sitting at.
>
> (7) No account to create. No Konode server to trust. End-to-end encryption if you
> want it.
>
> (8) Konode. Open source, and yours.

## Production notes

**Localization.** The spoken track is English. Every word that appears on screen comes
from a per-language file, so a Hungarian or Chinese cut is a re-render of the same HTML
with a different text file, not a new edit. Konode already ships in eight languages and
most of its users are not native English speakers, so this is a starting constraint
rather than a later refinement.

**No competitor names.** The comparison table in the README is fair and stays fair.
A video that punches at other tools invites an argument it cannot win in sixty seconds.
Shot 2 shows a nameless box.

**Claims that have to stay accurate.** Data does leave the browser, it goes to the
backend the user picked, so nothing in the video may suggest otherwise. Encryption is
optional and off until chosen, so shot 7 says "if you want it" rather than implying it
is always on.

**Generated video.** None in this cut. Generated footage cannot render the real popup,
and for a tool sold on trust, generic atmospheric b-roll reads as stock and works
against the product. If an opener with more atmosphere is wanted later, shots 1 and 2
are where it would go.

**Music.** Not chosen. The edit leaves room for a bed under the whole run and a small
accent at 0:32, where the bookmark arrives.

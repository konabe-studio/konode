# BRAND.md — Konode brand system

The single source for how Konode looks and sounds. The functional UI already uses
these tokens (`src/theme.css`, `src/index.css`); this file is the *why* behind them
and the rules for the pre-launch assets (logo, store listing, website).

> Konode is an independent, open-source project (publisher: **Kōnabe Studio**). It is
> not affiliated with any employer's products — keep its identity its own.

---

## 1. Positioning

**Konode syncs your browser to storage you already own — no server, no telemetry.**

Bookmarks, history, open tabs and your extension list, kept in step across every
Chromium browser, stored in *your* Google Drive / WebDAV / GitHub, optionally
end-to-end encrypted. Nothing ever touches a Konode server, because there isn't one.

- **Category:** browser sync utility (MV3 extension).
- **For:** privacy-conscious people and developers who distrust vendor cloud sync and
  want their data on infrastructure they control.
- **Against:** built-in browser sync (opaque, vendor-locked) and paid sync services
  (another server holding your data).
- **One-liner:** *Your browser, everywhere — on storage you own.*
- **Proof points:** no server · no telemetry · open source · optional E2EE (AES-256-GCM)
  · credentials stay in `chrome.storage.local` on the device.

## 2. Personality

Trustworthy, technical, calm. A quiet utility that does one thing exactly right and
gets out of the way — not a hyped consumer app.

| We are | We are not |
|---|---|
| Precise, plain-spoken | Salesy, buzzwordy |
| Calm, confident | Loud, urgent, gamified |
| Developer-literate | Condescending or dumbed-down |
| Restrained, intentional | Decorated, trend-chasing |

## 3. Anti-"AI-slop" principles

The whole point of the pre-launch pass is that the product must *not* read as generic
or auto-generated. Rules:

1. **One idea, executed fully.** A single brand concept (the mark) applied
   consistently beats five clever flourishes.
2. **No decoration for its own sake** — no gradients, glows, noise textures, drop
   shadows as style, faux-3D, or emoji. Flat, deliberate surfaces. (Matches the UI:
   the earlier re-skin already stripped noise/glow/gradients.)
3. **Restraint in color** — one green, used as a signal, on a near-neutral canvas.
   Green is an accent, never a flood-fill of whole screens.
4. **Real copy, specific** — say exactly what happens ("stored in your Google Drive"),
   never vague benefit-speak ("seamless cloud experience").
5. **System type, no novelty fonts.** Inter + JetBrains Mono, self-hosted.
6. **Sharp at every size.** The mark must survive a 16px favicon and a monochrome
   one-color print.

## 4. Logo

**Direction (see the 3 concepts reviewed in-session):**
- **A — Signal pulse:** a dot with radiating arcs. Ties directly to the product's
  existing "pulse / active-streams" motif in the popup. Most on-brand with the UI.
- **B — Sync loop:** two arrowed arcs forming a bidirectional loop. The clearest
  literal "sync" metaphor, but closest to a generic refresh glyph.
- **C — S monogram:** a bold rounded "S". The most ownable and wordmark-friendly;
  scales cleanest to a 16px favicon.

**Chosen mark: the Konode glyph** — a bold white mark on the brand-green rounded-square
tile. Assets: master `public/icons/icon.svg`, app icons `icon{16,32,48,128}.png` (run
`npm run icons` to regenerate them from the master SVG), horizontal lockup
`public/icons/wordmark.svg`. In-app it renders as the `BrandMark` glyph (white, on the
green tile) in the options top bar and the onboarding header.

**Construction rules (whichever mark wins):**
- Mark sits on the brand-green rounded-square app tile (radius ≈ 22% of the tile),
  white (or negative-space) glyph. Corner radius and padding scale with the tile.
- Wordmark: "Konode" set in Inter, weight 500–600, tight tracking (≈ -0.02em),
  sentence-case (capital S only). Mark + wordmark lockup with the mark's height ≈
  cap-height × 1.4, gap ≈ 0.4× mark width.
- Minimum clear space around the lockup = the mark's corner radius on all sides.
- **Don't:** recolor the mark arbitrarily, add effects, stretch, rotate, place the
  green tile on a busy photo, or set the wordmark in a different typeface.

## 5. Color

The green is `#12b76a` — a confident "signal" green (also the toggle-on / active
accent). Neutrals do the heavy lifting; green marks state and action only.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--accent` | `#12b76a` | `#34d399` | Toggles, links, focus ring, active tab, brand tile |
| `--accent-solid` | `#0b8348` | `#34d399` | Solid fills **under text** (buttons, badge) |
| `--on-accent` | `#ffffff` | `#05271c` | Text/icons on `--accent-solid` |
| `--bg` | `#f7f8fa` | `#0f1216` | Page |
| `--bg-card` | `#ffffff` | `#161a20` | Cards / surfaces |
| `--text-primary` | `#11151a` | `#e6e9ee` | Body |
| `--text-secondary` | `#5b6470` | `#97a0ad` | Descriptions |
| `--warn` | `#b7791f` / `#f5a524` | — | Warnings |
| `--danger` | `#dc2626` | `#f87171` | Destructive |

Accessibility (a first-class concern for a privacy tool): **white on the brand green
is too low-contrast (~2.6:1)** — that's why solid text surfaces use `--accent-solid`
(≈4.8:1 in light) and dark mode flips to near-black text on the bright mint (~8:1).
Target WCAG AA (4.5:1) for all text. Full palette + dark-mode values live in
`src/theme.css`; the popup mirrors them as `--sk-*` in `src/index.css`.

## 6. Typography

- **UI / wordmark:** Inter (400 regular, 500 medium, 600 for the wordmark).
- **Technical / mono:** JetBrains Mono (device IDs, checksums, tokens, code).
- **Self-hosted** in `public/fonts` (`@font-face`) — a privacy-first extension must
  not fetch Google Fonts on every open. System-UI fallback.
- Scale is an even 8pt-ish rhythm: body 14, secondary 12, small 12, page title 20,
  wordmark/H1 24. Icons 12 / 14 / 16 / 20. No odd sizes.

## 7. Voice & tone

American English. Clear, plain, friendly-but-not-cute. Short sentences. Say what the
software does and what it does *not* do (no server, no telemetry) — that restraint is
the pitch.

- **Do:** "Konode stores your data in your own Google Drive. We never see it."
- **Don't:** "Experience seamless, next-gen synchronization in the cloud!"
- Buttons are verbs ("Save changes", "Test connection"). Errors are specific and
  actionable ("Your encryption passphrase doesn't match your other devices").

## 8. Assets checklist (pre-launch)

- [x] Pick the mark and lock the master SVG.
- [ ] App icons: 16 / 32 / 48 / 128 PNG from the master SVG → `public/icons/`.
- [ ] Wordmark lockup SVG (horizontal + stacked) for the site / store header.
- [ ] OAuth consent-screen logo (120×120, on-brand tile).
- [ ] Chrome Web Store: 128 icon, screenshots, small promo tile (440×280).
- [ ] Favicon for the website.

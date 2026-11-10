# storehouse brand kit

These are the assets and rules for storehouse's one-page marketing site. storehouse is a command-line tool for Google Secret Manager that keeps a manifest in the repo. The site's job is to explain it and get it installed.

This file sets the look: color, type, logo use, visual language and the page's order. The repo's README and the CLI itself are the source for what storehouse does and what to say about it, and they win wherever this file's copy differs.

**This brand is for the marketing site only.** It doesn't change the CLI: not its output, its messages, its help text, the README or the docs in the repo.

Open `preview.html` to see every asset.

## The idea

The look comes from a records office: green-bar printer paper, carbon-copy forms, typewriter text and an official seal. It suits a tool whose work is keeping an exact record of every secret, every env and every version. The visuals carry the theme. The words don't.

## Files

| Path | What it is |
| --- | --- |
| `logo/lockup-horizontal-{ink,paper}.svg` | The main logo: the seal and the wordmark side by side. Use it in the site header. |
| `logo/lockup-stacked-{ink,paper}.svg` | The seal above the wordmark, for square or centered spots. |
| `logo/wordmark-{ink,paper}.svg` | The word STOREHOUSE alone. |
| `logo/mark-{ink,paper,red}.svg` | The full seal, with STOREHOUSE and RECORDS KEPT around the ring. Use it at 96px and up. |
| `logo/mark-small-{ink,paper,red}.svg` | The ring and the S only, for 16 to 95px. |
| `logo/png/` | PNG exports of the above, for places that can't take SVG. |
| `favicon/` | `favicon.ico` (16, 32, 48), `favicon.svg`, `apple-touch-icon.png` (180), `icon-192.png`, `icon-512.png` (safe for maskable crops) and `site.webmanifest`. |
| `social/og-image.png` | The 1200×630 link preview, with its SVG source. It also works as the GitHub social preview. Its install line is set in `build.mjs`; keep it the README's. |
| `tokens/colors.css`, `tokens/tokens.json` | Colors and font stacks as CSS custom properties and JSON. |
| `fonts/` | Self-hosted woff2 files (Latin subset) with `fonts.css` and the OFL licenses. |
| `build.mjs` | The script that generated everything here. To rebuild: `npm i @resvg/resvg-js@2.6.2 opentype.js@1.3.4 @fontsource/marcellus-sc @fontsource/courier-prime @fontsource/ibm-plex-sans`, then `node build.mjs <out-dir>`. |

All text in the SVGs is converted to outlines, so the logos don't need any fonts installed.

## Color

| Token | Hex | Use |
| --- | --- | --- |
| `--sh-paper` | `#FAFAF5` | Page background. |
| `--sh-ink` | `#26335C` | Text, logo, rules. Carbon-copy blue, not black. |
| `--sh-muted` | `#5D6580` | Labels, captions, secondary text. |
| `--sh-greenbar` | `#DCEBD6` | The stripes behind terminal output. |
| `--sh-canary` | `#F4E39C` | At most one callout or section ground. |
| `--sh-pink` | `#F3CDD3` | At most one callout or section ground. |
| `--sh-red` | `#B2393A` | Small accents only: links, the primary button, list markers. Never large areas. |

Contrast (WCAG):

| Text on background | Ratio | OK for |
| --- | --- | --- |
| ink on paper | 11.7 | All text |
| muted on paper | 5.5 | All text |
| red on paper | 5.7 | All text, links |
| paper on red | 5.7 | Button text |
| paper on ink | 11.7 | All text |
| ink on green bar | 9.9 | Terminal output |
| muted on green bar | 4.6 | Normal text, just above AA |
| ink on canary | 9.5 | All text |
| ink on pink | 8.5 | All text |
| red on pink | 4.1 | Large text (24px+) only |

The site is light only, like paper.

## Type

- **Marcellus SC** for headings and the wordmark. It is a small-caps face, so it sets everything in capitals. Headings use tracking `0.02em`; short labels set in it use `0.12em`.
- **Courier Prime** for body text, commands and terminal output. Body at 17px, line height 1.6, measure about 64 characters. Use 700 for bold.
- **IBM Plex Sans** 500, 11 to 12px, uppercase, tracked `0.1em`, in muted, for small field labels: table headers, captions, the label above a code block.
- Load `fonts/fonts.css`. Fallbacks are in `tokens/colors.css`.

## Logo

- Use ink on paper, green bar, canary or pink. Use paper on ink. Red is for single-color uses like a print stamp, not for the site header.
- Leave clear space around the logo equal to half the seal's diameter.
- Minimum sizes: the horizontal lockup at 160px wide. Use the full seal at 96px and up and `mark-small` below that.
- Don't recolor outside these pairs, stretch, rotate, add shadows or retype the wordmark.

## Visual language

- **Green-bar paper for terminal output.** Code and terminal blocks are white with alternating green-bar stripes two lines tall, a fixed line height (20px works with 13 to 14px type), and tractor-feed margins: a column of punched holes on each side behind a dashed perforation line. `social/og-image.svg` shows the exact construction. Make the blocks scroll horizontally.
- **Double rules.** Two 3px ink lines, 4px apart, under the hero heading and at the top of the footer. Use 1px muted lines between rows elsewhere.
- **Forms for structured content.** Set the commands list and the exit-code table like a printed form: a small Plex Sans label above each value and a 1px rule under each row, with no boxes or cards.
- **Carbon colors sparingly.** Canary or pink can fill one callout. A good candidate is the protected-environments section.
- Square corners. No shadows, gradients or rounded cards.
- No mock forms, rubber stamps, ledgers or other props. Real terminal output is the only picture.

## Copy

Write plainly and factually, the way the README does. No scripture, church, clerk or records puns, and no jokes. Don't use "There shall be a record kept."

The words themselves aren't kept here. They come from the repo's README and the CLI: the site renders the README's sections and the CLI's own `--help` and output (`site/scripts/cli-docs.ts`), and its headline, subhead and buttons live in `site/src/pages/index.astro`. Never invent flags or output.

## Suggested page

One page, in this order. Take every claim from the README.

1. Header: horizontal lockup, then links to Docs and GitHub.
2. Hero: headline, subhead, the README's install command with a copy button, the two buttons, then the double rule.
3. `storehouse status` output on green-bar paper, with one sentence on what it shows.
4. Quickstart: the README's Quickstart.
5. Commands, set as a form: every command the CLI's `--help` lists, one line each.
6. Working with coding agents: the README's section.
7. Protected environments (the one canary or pink callout): the README's section, with its table of what each layer stops.
8. Exit codes, as a form table.
9. Why: the README's opening paragraph and comparison table.
10. Footer: double rule, install command, GitHub link, license.

## Head tags

```html
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<meta name="theme-color" content="#26335C">
<meta property="og:title" content="storehouse">
<meta property="og:description" content="(the page's description)">
<meta property="og:image" content="https://storehouse.osroc.io/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
```

The site serves the contents of `favicon/` and `social/og-image.png` from its root, through symlinks in `site/public/`.

## Licensing

Marcellus SC, Courier Prime and IBM Plex Sans are under the SIL Open Font License; the license files are in `fonts/`. The seal and the lockups are original artwork for storehouse.

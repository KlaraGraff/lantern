# Bundled reading fonts

Ten reading faces shipped with the app and offered under **Built-in** in the
reader's font picker. Every one is **SIL Open Font License 1.1**, which permits
bundling, embedding and redistribution inside an application — the licence
texts in `licenses/` ship with the build because the OFL requires it.

| Family | Files | Notes |
| --- | --- | --- |
| Literata | variable | Google Play Books' reading face; `opsz` + `wght` axes |
| Libre Baskerville | variable | Screen-tuned Baskerville, large x-height |
| EB Garamond | variable | Claude Garamond revival |
| Source Serif 4 | variable | Adobe; `opsz` + `wght` axes |
| Crimson Pro | variable | Old-style, Minion-inspired |
| Newsreader | variable | Screen-first; `opsz` + `wght` axes |
| Spectral | static 400/700 | No variable version published |
| Vollkorn | variable | Warm body serif |
| Atkinson Hyperlegible | static 400/700 | Braille Institute; accessibility |
| Lexend | variable | Sans; **no italic published** — obliqued by the engine |

## What the files are

The `latin` and `latin-ext` subsets Google Fonts serves, in woff2. Naming is
`<slug>-<style>-<weight>-<subset>.woff2`, where weight is either a variable
range (`400-700`) or a static instance (`400`, `700`).

`latin` + `latin-ext` covers English plus the accented characters that turn up
in names, loanwords and European-language quotations. Greek, Cyrillic and
Vietnamese subsets are deliberately excluded — they would roughly double the
payload for text these fonts are not being chosen to render. CJK falls through
to the fallback chain in `src/components/builtin-fonts.ts`.

## Refetching

`@font-face` declarations are generated at runtime from the table in
`src/components/builtin-fonts.ts` — the unicode-ranges are shared constants
there, verified identical across all ten families. To add or update a family,
pull the subsets from the Google Fonts CSS API, e.g.:

```
https://fonts.googleapis.com/css2?family=Literata:ital,opsz,wght@0,7..72,400..700;1,7..72,400..700&display=swap
```

Request it with a current-browser User-Agent (otherwise the API serves ttf
instead of woff2), keep only the `latin` and `latin-ext` blocks, save each file
under the naming scheme above, and add a row to `builtinFonts`. The licence
comes from `https://github.com/google/fonts/blob/main/ofl/<family>/OFL.txt`.

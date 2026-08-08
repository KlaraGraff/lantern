// Lantern-only: a bridge that hands app code the Foliate modules it needs.
//
// App source cannot `import()` these directly. Everything under /public is
// served as-is and never goes through Vite's plugin transforms, so Vite's dev
// server rewrites a dynamic import with a non-literal specifier into a
// `?import` request and then refuses to serve it ("This file is in /public …
// It can only be referenced via HTML tags"). The app's CSP is `script-src
// 'self'`, which rules out the usual escapes — inline scripts, `new Function`,
// and blob: URLs are all blocked.
//
// A same-origin `<script type="module" src>` is the one path that satisfies
// both: the browser resolves the literal specifiers below itself, and it is
// exactly how `view.js` already loads. See `loadFoliateModules()` in
// `src/pages/reader/foliate-modules.ts` for the loader side.
import { FootnoteHandler } from './footnotes.js'
import * as epubcfi from './epubcfi.js'
import { textWalker } from './text-walker.js'

globalThis.__lanternFoliateModules = { FootnoteHandler, epubcfi, textWalker }

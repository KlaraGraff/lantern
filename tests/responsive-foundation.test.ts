import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The responsive foundation is four lines of CSS and one meta attribute, and
// every one of them fails silently. A `touch` variant quietly redefined in
// terms of width still compiles, still passes lint, and still renders fine on
// the machine of whoever changed it — the damage only shows up under a mouse in
// a narrow window, which is the one configuration nobody opens on purpose.
// These assertions guard the rule in `docs/impls/responsive-foundation.md`,
// not the formatting.

const repoFile = (path: string) => new URL(`../${path}`, import.meta.url);
const readRepo = (path: string) => readFile(repoFile(path), "utf8");

test("the viewport opts into the safe area without taking zoom away", async () => {
  const html = await readRepo("index.html");
  const viewport = /<meta name="viewport" content="([^"]+)"/.exec(html);

  assert.ok(viewport, "index.html must declare a viewport meta tag");
  const content = viewport[1];

  // Without this, `env(safe-area-inset-*)` reports 0px even on a notched phone
  // and every inset in `src/index.css` is decoration.
  assert.match(content, /viewport-fit=cover/);

  // Pinch-zoom is the last resort of anyone who cannot read the text, and a
  // reading app is the worst possible place to remove it. The two problems
  // that tempt people into these flags have better fixes: the tap delay is
  // handled by `touch-action: manipulation`, and focus-zoom by 16px inputs.
  assert.doesNotMatch(content, /user-scalable\s*=\s*no/);
  assert.doesNotMatch(content, /maximum-scale/);
});

test("the touch variant asks the input device, never the width", async () => {
  const css = await readRepo("src/index.css");
  const variant = /@custom-variant\s+touch\s*\(([^;]+)\);/.exec(css);

  assert.ok(variant, "src/index.css must define the `touch` variant");
  const definition = variant[1];

  assert.match(definition, /pointer:\s*coarse/);
  // The whole point of the variant. Width decides layout; it must never be
  // allowed to decide that something is a finger — a macOS window dragged
  // narrow is still driven by a mouse.
  assert.doesNotMatch(definition, /width/);
});

test("the width breakpoints stay Tailwind's defaults", async () => {
  const css = await readRepo("src/index.css");

  // `md:` means 768px because nothing here overrides it. A project-local
  // breakpoint name is a permanent tax on every component author, so it has to
  // be an argued decision rather than something that drifts in.
  assert.doesNotMatch(css, /--breakpoint-/);
});

test("touch-action stays scoped to controls", async () => {
  const css = await readRepo("src/index.css");

  // `touch-action` intersects down the ancestor chain, so a value on the root
  // is a ceiling no descendant can raise again. Setting it there would reach
  // into the reader body and the book's iframe and take P3's gestures and the
  // PDF view's defaults with it.
  assert.doesNotMatch(css, /(^|[\s,{])(html|body|\*)\s*\{[^}]*touch-action/m);
  assert.match(css, /touch-action:\s*manipulation/);
});

test("touch text fields clear the 16px floor iOS zooms below", async () => {
  const css = await readRepo("src/index.css");
  const rule =
    /@media \(pointer: coarse\) \{\s*(input[^{]*|[^{}]*)\{\s*font-size:\s*16px;/.exec(
      css,
    );

  assert.ok(rule, "a `pointer: coarse` rule must set text fields to 16px");
  // Range, checkbox and radio have no text to zoom for and do have layouts
  // that a font size can push around.
  for (const type of ["range", "checkbox", "radio"]) {
    assert.match(rule[1], new RegExp(`:not\\(\\[type="${type}"\\]\\)`));
  }

  // The rule has to outrank the `text-[13px]` utility on the element, so
  // unlike everything else in this file it must stay out of `@layer base`.
  // If someone tidies it in there it stops working and nothing else notices.
  const base = /@layer base\s*\{([\s\S]*?)\n\}/.exec(css);
  assert.ok(base, "src/index.css must still have an `@layer base` block");
  assert.doesNotMatch(base[1], /pointer:\s*coarse/);
});

test("the safe-area insets survive with no consumer", async () => {
  const css = await readRepo("src/index.css");
  const block = /@theme static\s*\{([^}]*)\}/.exec(css);

  // Tailwind drops theme variables no utility references. These have to be
  // readable from places its scanner cannot see — inline styles, runtime
  // `calc()`, the CSS injected into the book iframe — so they are pinned.
  assert.ok(block, "safe-area insets must live in a `@theme static` block");

  for (const edge of ["top", "right", "bottom", "left"]) {
    assert.match(
      block[1],
      new RegExp(
        `--spacing-safe-${edge}:\\s*env\\(safe-area-inset-${edge},\\s*0px\\)`,
      ),
      `--spacing-safe-${edge} must fall back to 0px`,
    );
  }
});

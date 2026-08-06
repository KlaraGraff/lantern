# Mobile P2.1 — The responsive foundation

Status: implemented. This is a convention doc, not a plan — the code it describes is four
declarations and one meta attribute, and the reason it needs a page of prose is that all of
it is invisible until someone gets it wrong.

Item 1 of [P2](../roadmap/mobile-ios.md#p2--mobile-ui-185-days). It adds capability and
restyles nothing: every screen at desktop width renders exactly as it did before.

## The rule

**Layout follows width. Interaction follows input type.**

Columns, drawers, sheets, gutters, and how wide a panel is allowed to get — all of that keys
off width breakpoints. How big a tap target has to be, whether hover states mean anything,
whether the edges of the page are live for a page turn — all of that keys off
`pointer: coarse`, and never off width.

The two are constantly conflated because on the two devices anyone actually tests, they
correlate: a phone is narrow and touched, a desktop is wide and moused. The configuration
that breaks the correlation is a macOS window dragged narrow, and it is not exotic — it is
how anyone will check the phone layout without booting the Simulator. If tap zones were
gated on width, that window would silently arm the reader's edge zones, and a mouse click
anywhere near the margin would turn the page instead of placing a cursor or starting a
selection. The reader would look correct and be unusable, and the bug would only reproduce
for someone who had resized their window.

Reading the rule the other way is just as wrong but less dramatic: gating layout on
`pointer: coarse` would mean an iPad with a keyboard and trackpad gets the phone's
single-column shelf forever, and a phone in landscape at 956pt keeps a layout built for
390pt. Width is the honest question to ask about layout, and it has the useful side effect
that the phone layout is verifiable in a browser.

## The vocabulary

Four things, and nothing else was added.

**Phone layout is the unprefixed base; `md:` and up is the desktop.** Tailwind's defaults
are untouched, so `md:` is 48rem — 768px at the root font size, which nothing in this app
changes (`--app-zoom` goes through `webview.setZoom()`, so the engine rescales media queries
rather than the root font). Write components mobile-first: base classes describe the phone,
`md:` restores what the desktop has today. No project-local breakpoint name was introduced,
because a name like `phone:` is a permanent cost paid by every future component author for
the rest of the project, and nothing here needs a boundary that `md:` cannot express.

**`touch:` is the touch-only prefix.** `touch:min-h-11` gives a control a 44pt minimum on a
finger-driven device and leaves it alone under a mouse. It is defined as
`@media (pointer: coarse)` and it is exactly Tailwind 4's built-in `pointer-coarse:` — the
minifier merges the two into one rule, which is as literal a proof of equivalence as there
is. It exists under a second name only because the name states the intent; `pointer-coarse:`
names the mechanism, and at a glance in a class list it reads like a sibling of `md:` rather
than its opposite. Both work; prefer `touch:`.

There is deliberately **no complement**. Tailwind 4 already gates plain `hover:` behind
`(hover: hover)`, so hover styles are self-suppressing on a phone with no help from us — the
compiled stylesheet carries `@media (hover:hover)` on every one of them today. For the
genuinely rare rule that must apply only under a mouse, `pointer-fine:` already ships. A
third name would have bought nothing.

**Safe-area insets are spacing utilities.** `pt-safe-top`, `pb-safe-bottom`, `pl-safe-left`,
`pr-safe-right` — and, because they are real theme variables, anything that needs to add its
own padding on top can compose them:
`pb-[calc(var(--spacing-safe-bottom)+var(--spacing-page))]`. They were put in the spacing
namespace rather than left as loose custom properties so that they read like
`pt-titlebar` and `px-page`, which is the same problem this file already solved for the
macOS traffic lights. One name serves the utility and the `calc()`.

They are pinned with `@theme static` because Tailwind drops theme variables that no utility
references, and these must be legible from places its scanner cannot reach — an inline
style, a `calc()` assembled at runtime, the stylesheet the reader injects into the book's
iframe. Four declarations of overhead against a variable that vanishes depending on whether
someone happened to write the matching class.

All four fall back to `0px`, so a rule that uses them is inert everywhere except a device
that reports a real inset. That is what makes them safe to add now, ahead of the components
that will consume them.

**`touch-action: manipulation` is already on the controls.** Native interactive elements and
the common ARIA roles get it in `@layer base`; you do not need to think about it. On a
clickable `div` that is really a button, add Tailwind's `touch-manipulation` yourself.

## What was deliberately not done

**Page scaling was left on.** `user-scalable=no` and `maximum-scale=1` are the reflex
addition to a mobile viewport tag, and both were rejected. WKWebView honours them — unlike
mobile Safari, which ignores `user-scalable=no` — so adding them would genuinely remove
pinch-zoom from a reading app, which is the worst category of app to remove it from. The two
problems people reach for those flags to solve both have better answers: the double-tap-zoom
delay is what `touch-action: manipulation` handles, and the other, iOS zooming the page when
you focus an input whose font is under 16px, is a font-size fix in the input component.
Lantern's shared input is `text-[14px]` and will trip that threshold — see below.

**`touch-action` was not set on the root.** A blanket `html { touch-action: manipulation }`
is the one-liner that covers every clickable `div` without enumerating anything, and it was
rejected because `touch-action` intersects down the ancestor chain: a value on the root is a
ceiling that no descendant can raise again. It would reach into the reader body and into the
book's own iframe, and those are precisely where
[P3](../roadmap/mobile-ios.md#p3--reader-touch-interaction-10-days) needs the browser's
defaults intact to build its gesture arena, and where the PDF view needs its own zoom
behaviour. The enumerated list is more to maintain and keeps the reader body free. Selection
is untouched either way — `touch-action` does not govern it — which matters because word
lookup depends on it.

**`-webkit-tap-highlight-color` was left alone.** Suppressing the grey flash iOS paints on
tap is a normal global to add, but only alongside `:active` states that replace the feedback
it was providing. Removing it now, before any component has one, would make every tap in the
app feel dead. It belongs with item 2, next to the components that will need the pressed
states.

**Nothing was added to `src/services/platform.ts`.** The capability layer answers "can this
platform do X" for TypeScript; this file answers "what is the user holding" for CSS. They
are complementary, and `hasSafeAreaInset` remains the flag a component checks when it needs
to *branch*, not merely to *inset* — an inset of zero costs nothing and needs no flag.

**The scanner reads this file.** Noted rather than fixed: Tailwind 4's default source
detection covers the whole repo, so the class names quoted in the section above are compiled
into the shipped stylesheet even though no component uses them yet — `touch:min-h-11` and
`touch:text-base` appear in `dist` and exist nowhere else in the project. It is about 120
bytes of rules that are inert outside `(pointer: coarse)`, and the accident is a useful one
here, since it proves the variant compiles from ordinary project text. Narrowing the scan
with `@source not` would be a global build change made to tidy a rounding error, so it was
left alone. Worth knowing before quoting a class name in a doc that is genuinely expensive.

**Base rules were placed in `@layer base`.** Worth stating because it is easy to undo by
accident: plain CSS written after `@import "tailwindcss"` is unlayered, and unlayered rules
outrank everything Tailwind emits. A bare `button { touch-action: manipulation }` at the end
of the file would beat a `touch-pan-y` utility written on that same button — which is
exactly the override P3 will need. Inside `base`, utilities win, which is the right way
round. The pre-existing rules further down the file are unlayered and were left as they are;
that is a live inconsistency, not an endorsement.

## What is not verified

**No safe-area inset was observed to be non-zero.** `env(safe-area-inset-*)` returns 0 in
every desktop browser and in a macOS WKWebView, and turns non-zero only in an iOS WKWebView
whose page carries `viewport-fit=cover`. What was checked is that the four variables reach
the compiled stylesheet unconditionally, that the utilities generate the expected
declarations, and that the fallback is `0px`. That the numbers become 44/34pt on a notched
device is the documented behaviour of the meta attribute, not something measured here. The
first component to actually inset itself should be looked at on the Simulator, and until one
exists there is nothing to look at.

**The tap-delay claim is inherited, not measured.** `touch-action: manipulation` removing
the double-tap-zoom wait in WebKit is documented behaviour; no before/after timing was taken
on a device.

**Two things the foundation does not fix, and cannot from these files.** Neither blocks item
1, both will bite item 2. The app shell is `h-screen` — `100vh` — on every route, which on
iOS measures the *largest* viewport and so runs the bottom of the layout underneath the
browser chrome and the home indicator; `100dvh` is the fix, and it lives in `src/pages/` and
`src/components/`, which this change was not permitted to touch.

And the shared input primitive is `text-[14px]` (`../../src/components/ui/Input.tsx:21`),
under the 16px floor below which iOS zooms the page on focus. Because page scaling was
deliberately left on, that zoom will happen, and it does not zoom back out when the field
blurs. Raising the input to 16px on coarse pointers — `touch:text-base`, which is what the
variant is for — fixes it without touching the desktop's type scale, but it is a change to
`src/components/ui/`, so it belongs to item 2.

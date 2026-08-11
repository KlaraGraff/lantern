import { platform } from "../services/platform";

/**
 * How much room the top of a full-height screen has to leave empty, as a
 * Tailwind class.
 *
 * Two unrelated things want that room and never both at once. On macOS it is
 * the traffic lights, which sit at a fixed 44px inside the window whatever the
 * screen is; on a phone it is the status bar and the notch, which
 * `env(safe-area-inset-top)` reports and which is 59pt on the current iPhones.
 * Everywhere else — Windows, Linux, a browser tab — it is nothing, and both
 * branches resolve to zero.
 *
 * This lived as an identical `const` in four page files, and the three record
 * screens (笔记 / 生词 / 问答) plus the profile and chat headers each hardcoded
 * `pt-titlebar` instead. On iOS that is 44px against the shelf's 59 — the same
 * app with two different top margins depending on which tab you are on, and
 * titles sitting about 15pt higher than they should, close enough to the status
 * bar to read as a mistake. One name so the two cannot drift again.
 *
 * A platform question, not a width one: a macOS window dragged to phone width
 * still has traffic lights.
 */
export const TOP_INSET = platform.hasTitleBarInset ? "pt-titlebar" : "pt-safe-top";

/**
 * The reader's variant. Its toolbar is shorter than a normal page header and
 * tucks under the traffic lights rather than clearing them, so on macOS it
 * reserves 32px instead of 44 — but a notch is a notch, and the phone branch is
 * the same inset as everywhere else.
 */
export const TOP_INSET_SLIM = platform.hasTitleBarInset ? "pt-titlebar-slim" : "pt-safe-top";

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The drawer's gesture kernel has its own tests. What this file guards is the
// wiring around it, which is where the failures are silent: a desktop layout
// that shifts by two pixels, a pointer captured one event too early, a titlebar
// strip keyed to the wrong question. None of those break a build, and none of
// them are visible on the machine of whoever introduced them — the reviewer is
// on a Mac at 1440px, and the damage is on a phone, or the other way around.
// The rules being pinned are in `docs/impls/mobile-home-drawer.md`.

const readRepo = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("the desktop sidebar shell is the string it was before the drawer existed", async () => {
  const sidebar = await readRepo("src/components/Sidebar.tsx");

  // Acceptance criterion 3, first bullet: at >=768px the `<aside>` renders the
  // same class string it rendered before, character for character. Written out
  // in full rather than matched loosely, because the whole point is that a
  // reordering or a "harmless" extra utility has to fail here rather than in a
  // screenshot nobody takes.
  assert.ok(
    sidebar.includes(
      '"shrink-0 bg-bg-muted border-r border-border h-full flex flex-col gap-6 px-4 relative select-none overflow-hidden"',
    ),
    "the non-drawer <aside> must keep its original class string verbatim",
  );

  // Same for the one inline style it carries.
  assert.match(sidebar, /style=\{inDrawer \? undefined : \{ width: sidebarWidth \}\}/);
});

test("row height is the only thing the drawer changes about a row", async () => {
  const sidebar = await readRepo("src/components/Sidebar.tsx");

  // 44px under a finger, and the `md:` half restates today's 36px so the
  // desktop computed value is unchanged rather than merely similar.
  assert.match(sidebar, /const ROW_HEIGHT = "h-11 md:h-9";/);

  // No row may keep a bare `h-9`: an unprefixed height is a row that stayed
  // 36px on a phone, which is the failure this constant exists to prevent.
  const strays = sidebar.split("\n").filter((line) => /\bh-9\b/.test(line) && !line.includes("ROW_HEIGHT"));
  assert.deepEqual(strays, [], "every row height must go through ROW_HEIGHT");
});

test("the drawer captures a pointer only after the gesture claims it", async () => {
  const home = await readRepo("src/pages/Home.tsx");

  const calls = home.split("setPointerCapture").slice(0, -1);
  assert.ok(calls.length > 0, "Home must capture the pointer somewhere");
  for (const before of calls) {
    // Capturing on pointerdown retargets the following `click` to the capturing
    // element, and every row inside an open drawer goes dead. The lock has to
    // have opened first.
    assert.match(
      before.slice(-240),
      /getState\(\)\.dragging/,
      "setPointerCapture must be guarded by the gesture having claimed the pointer",
    );
  }
});

test("nothing on the pointer path is prevented", async () => {
  const home = await readRepo("src/pages/Home.tsx");

  const start = home.indexOf("const drawerPointer = {");
  assert.ok(start > 0, "Home must wire the drawer's pointer handlers");
  const body = home.slice(start, home.indexOf("\n  };", start));

  // The handlers sit on the page root, so they see every pointer on the shelf.
  // Calling `preventDefault` there — including on a pointer the controller
  // rejected — is how a drawer stops the page from scrolling.
  assert.doesNotMatch(body, /preventDefault/);
});

test("the titlebar strip asks the platform, never the width", async () => {
  for (const path of ["src/pages/Home.tsx", "src/components/Sidebar.tsx"]) {
    const source = await readRepo(path);

    // A macOS window dragged down to 400px still has traffic lights. Gating
    // this on `md:` would put the title under the close button.
    assert.match(source, /platform\.hasTitleBarInset && <div data-tauri-drag-region/);
    assert.doesNotMatch(source, /md:(h|pt)-titlebar/);
  }
});

test("the page is measured against the visible viewport", async () => {
  const home = await readRepo("src/pages/Home.tsx");

  // `100vh` on iOS is the *largest* viewport, so the bottom of the layout ends
  // up under the browser chrome and the home indicator.
  assert.match(home, /className="relative flex h-dvh bg-bg-surface"/);
});

test("the drawer is a dialog the keyboard can leave", async () => {
  const home = await readRepo("src/pages/Home.tsx");

  assert.match(home, /role="dialog"/);
  assert.match(home, /aria-modal="true"/);
  // An iPad with a keyboard is an ordinary configuration, so Escape and the
  // tab trap are not optional extras.
  assert.match(home, /event\.key === "Escape"/);
  assert.match(home, /event\.key !== "Tab"/);
});

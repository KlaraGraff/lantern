import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { opensInNewWindow, wantsNewWindow } from "../src/utils/reader-open-mode.ts";

const desktopLibrary = { hasWindow: true, inStandaloneReader: false };
const desktopReaderWindow = { hasWindow: true, inStandaloneReader: true };
const phone = { hasWindow: false, inStandaloneReader: false };

test("the library window opens books in place unless a new window is asked for", () => {
  assert.equal(opensInNewWindow(desktopLibrary), false);
  assert.equal(opensInNewWindow(desktopLibrary, false), false);
  assert.equal(opensInNewWindow(desktopLibrary, true), true);
});

test("a standalone reader window keeps opening books in windows of their own", () => {
  assert.equal(opensInNewWindow(desktopReaderWindow), true);
  assert.equal(opensInNewWindow(desktopReaderWindow, true), true);
});

test("where no second window can exist, a request for one opens in place", () => {
  assert.equal(opensInNewWindow(phone), false);
  assert.equal(opensInNewWindow(phone, true), false);
});

test("the new-window gesture is ⌘ on a Mac and Ctrl elsewhere", () => {
  assert.equal(wantsNewWindow({ metaKey: true, ctrlKey: false }, true), true);
  assert.equal(wantsNewWindow({ metaKey: false, ctrlKey: true }, true), false);
  assert.equal(wantsNewWindow({ metaKey: false, ctrlKey: true }, false), true);
  assert.equal(wantsNewWindow({ metaKey: true, ctrlKey: false }, false), false);
  assert.equal(wantsNewWindow({ metaKey: false, ctrlKey: false }, true), false);
});

test("every book-open path goes through useOpenBook, not straight to a window", () => {
  // `openReaderWindow` is the new-window half of `useOpenBook`; calling it
  // directly would skip the in-place default and the cover transition.
  for (const file of ["src/App.tsx", "src/components/BookOpenGateProvider.tsx", "src/pages/home/HomeDashboard.tsx"]) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /openReaderWindow\(/, `${file} opens a window directly`);
  }
});

test("the reader route reports its first commit to the cover transition", () => {
  const reader = readFileSync("src/pages/Reader.tsx", "utf8");
  const app = readFileSync("src/App.tsx", "utf8");
  assert.match(reader, /useLayoutEffect\(\(\) => \{ readerRouteCommitted\(\); \}, \[\]\)/);
  assert.match(app, /useLayoutEffect\(\(\) => \{ readerRouteCommitted\(\); \}, \[\]\)/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { avatarInitials } from "../src/utils/avatar-initials.ts";

/**
 * With no display name set, the avatar showed a hard-coded "R" even in the
 * Chinese interface, where the name beside it reads 「读者」. The avatar now
 * takes its letter from the same localized default name.
 */
test("the avatar letter follows the localized default name", () => {
  assert.equal(avatarInitials("读者"), "读");
  assert.equal(avatarInitials("Reader"), "R");
});

test("a chosen name still gives up to two initials", () => {
  assert.equal(avatarInitials("mia chen"), "MC");
  assert.equal(avatarInitials("Ann Bea Cy"), "AB");
  assert.equal(avatarInitials("  Mia  "), "M");
  assert.equal(avatarInitials("😀 Smile"), "😀S");
});

const read = (file: string) => readFileSync(path.join(import.meta.dirname, "..", file), "utf8");
for (const file of ["src/components/NavRail.tsx", "src/components/Sidebar.tsx"]) {
  test(`${file} has no hard-coded "R" avatar`, () => {
    const source = read(file);
    assert.doesNotMatch(source, /:\s*"R"/);
    assert.match(source, /avatarInitials\(userName \|\| t\("settings\.general\.displayNameDefault"\)\)/);
  });
}

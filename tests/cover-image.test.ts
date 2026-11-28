import test from "node:test";
import assert from "node:assert/strict";
import { COVER_IMAGE_EXTENSIONS, isHeicPath } from "../src/utils/cover-image.ts";

test("the cover picker offers HEIC beside the formats it already took", () => {
  for (const ext of ["jpg", "jpeg", "png", "webp", "heic", "heif"]) {
    assert.ok(COVER_IMAGE_EXTENSIONS.includes(ext), ext);
  }
});

test("HEIC is recognised whatever the case, and only by its extension", () => {
  assert.equal(isHeicPath("/Users/a/Pictures/IMG_0111.HEIC"), true);
  assert.equal(isHeicPath("C:\\Photos\\IMG_0111.heif"), true);
  assert.equal(isHeicPath("/tmp/cover.jpeg"), false);
  assert.equal(isHeicPath("/tmp/heic-notes.png"), false);
});

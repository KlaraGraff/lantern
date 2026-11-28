import test from "node:test";
import assert from "node:assert/strict";
import { COVER_IMAGE_EXTENSIONS, needsConvertedPreview } from "../src/utils/cover-image.ts";

test("the cover picker offers every format the backend converts", () => {
  for (const ext of ["jpg", "jpeg", "png", "webp", "gif", "bmp", "tif", "tiff", "heic", "heif"]) {
    assert.ok(COVER_IMAGE_EXTENSIONS.includes(ext), ext);
  }
});

test("only a JPEG is previewed straight from the file, whatever the case", () => {
  assert.equal(needsConvertedPreview("/tmp/cover.jpeg"), false);
  assert.equal(needsConvertedPreview("C:\\Photos\\COVER.JPG"), false);
  assert.equal(needsConvertedPreview("/Users/a/Pictures/IMG_0111.HEIC"), true);
  assert.equal(needsConvertedPreview("C:\\Scans\\page.TIF"), true);
  assert.equal(needsConvertedPreview("/tmp/jpg-notes.png"), true);
});

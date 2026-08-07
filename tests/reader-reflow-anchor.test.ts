import test from "node:test";
import assert from "node:assert/strict";
import { cfiStart, movedDuringReflow } from "../src/pages/reader/reader-reflow-anchor.ts";

test("a range CFI reduces to its parent plus its start", () => {
  assert.equal(cfiStart("epubcfi(/6/4!/4/2,/1:0,/3:24)"), "/6/4!/4/2/1:0");
});

test("a collapsed CFI is returned unchanged apart from its wrapper", () => {
  assert.equal(cfiStart("epubcfi(/6/4!/4/2/1:0)"), "/6/4!/4/2/1:0");
});

test("commas inside a text-location assertion do not split the CFI", () => {
  assert.equal(
    cfiStart("epubcfi(/6/4!/4/2,/1:0[pre,post],/3:24)"),
    "/6/4!/4/2/1:0[pre,post]",
  );
});

test("an escaped comma is part of the step, not a separator", () => {
  assert.equal(cfiStart("epubcfi(/6/4!/4/2^,x,/1:0,/3:24)"), "/6/4!/4/2^,x/1:0");
});

test("the same page after a reflow is not a move even though its end shifted", () => {
  assert.equal(
    movedDuringReflow("epubcfi(/6/4!/4/2,/1:0,/3:24)", "epubcfi(/6/4!/4/2,/1:0,/9:12)"),
    false,
  );
});

test("a page that now starts elsewhere is a move", () => {
  assert.equal(
    movedDuringReflow("epubcfi(/6/4!/4/2,/1:0,/3:24)", "epubcfi(/6/4!/4/8,/1:0,/3:24)"),
    true,
  );
});

test("a missing reading on either side is never reported as a move", () => {
  assert.equal(movedDuringReflow(null, "epubcfi(/6/4!/4/2,/1:0,/3:24)"), false);
  assert.equal(movedDuringReflow("epubcfi(/6/4!/4/2,/1:0,/3:24)", null), false);
  assert.equal(movedDuringReflow(undefined, undefined), false);
});

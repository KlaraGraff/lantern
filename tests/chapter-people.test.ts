import assert from "node:assert/strict";
import test from "node:test";
import { chapterPeople, type PersonSoFar } from "../src/pages/reader/chapter-traces.ts";

const person = (canonical: string, first_section: number): PersonSoFar => ({ canonical, first_section, mentions_in_section: 0 });

test("people first met in this chapter lead, earlier ones follow, both in arrival order", () => {
  const people = [person("Mr. Bennet", 2), person("Elizabeth", 2), person("Mr. Bingley", 3), person("Mr. Darcy", 4)];
  const { newcomers, earlier } = chapterPeople(people, { start: 3, end: 4 });
  assert.deepEqual(newcomers.map((p) => p.canonical), ["Mr. Bingley", "Mr. Darcy"]);
  assert.deepEqual(earlier.map((p) => p.canonical), ["Mr. Bennet", "Elizabeth"]);
});

test("with no known chapter start nobody is called new", () => {
  const { newcomers, earlier } = chapterPeople([person("Jane", 0)], {});
  assert.equal(newcomers.length, 0);
  assert.equal(earlier.length, 1);
});

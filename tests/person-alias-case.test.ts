import assert from "node:assert/strict";
import test from "node:test";

import {
  aliasAmbiguities,
  ambiguousAliasSet,
  personAliasRows,
  type AliasEntryView,
  type AliasGroupView,
} from "../src/components/person-aliases.ts";

let nextId = 0;

function entry(alias: string, mentions: number): AliasEntryView {
  nextId += 1;
  return {
    id: `e${nextId}`,
    alias,
    source: "auto",
    mentions,
    kind: "name",
    sourceQuery: null,
  };
}

/** A group as `list_person_aliases` returns it: every row carries the
 *  canonical's mention count, not the alias's. */
function group(canonical: string, mentions: number, aliases: string[]): AliasGroupView {
  return { canonical, entries: aliases.map((alias) => entry(alias, mentions)) };
}

test("case-differing spellings under two people are one ambiguous alias", () => {
  const rows = personAliasRows([
    group("Elizabeth Bennet", 40, ["Lizzy"]),
    group("Charlotte Lucas", 12, ["lizzy"]),
  ]);
  const ambiguities = aliasAmbiguities(rows);

  assert.equal(ambiguities.length, 1, "one alias text, one group");
  assert.equal(ambiguities[0].alias, "Lizzy", "reports the first-seen spelling");
  assert.deepEqual(
    ambiguities[0].candidates.map((candidate) => [candidate.canonical, candidate.mentions]),
    [
      ["Elizabeth Bennet", 40],
      ["Charlotte Lucas", 12],
    ],
  );
});

test("case-differing spellings of one person are not ambiguous", () => {
  // Matching lowercases, so these two rows are one alias pointing at one
  // person. Two candidates would send the reader to a bridge card offering a
  // choice that does not exist.
  const rows = personAliasRows([
    group("Elizabeth Bennet", 40, ["Lizzy"]),
    group("Elizabeth Bennet", 7, ["lizzy"]),
  ]);
  assert.deepEqual(aliasAmbiguities(rows), []);
});

test("both spellings badge, because the set is keyed lowercased", () => {
  const rows = personAliasRows([
    group("Elizabeth Bennet", 40, ["Lizzy"]),
    group("Charlotte Lucas", 12, ["lizzy"]),
  ]);
  const flagged = ambiguousAliasSet(aliasAmbiguities(rows));

  assert.ok(flagged.has("Lizzy".toLowerCase()), "the LIZZY chip badges too");
  assert.ok(flagged.has("lizzy"), "the lowercase chip badges");
  assert.equal(flagged.size, 1, "one ambiguous alias, not one per spelling");
});

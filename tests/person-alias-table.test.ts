import assert from "node:assert/strict";
import test from "node:test";

import {
  ALIAS_TABLE_VISIBLE_PEOPLE,
  aliasAmbiguities,
  aliasSourceCounts,
  aliasTableSections,
  ambiguousAliasSet,
  canonicalCandidates,
  filterAliasRows,
  isKnownCanonical,
  personAliasRows,
  rowMentions,
  type AliasEntryView,
  type AliasGroupView,
} from "../src/components/person-aliases.ts";

let nextId = 0;

function entry(alias: string, overrides: Partial<AliasEntryView> = {}): AliasEntryView {
  nextId += 1;
  return {
    id: overrides.id ?? `e${nextId}`,
    alias,
    source: overrides.source ?? "auto",
    mentions: overrides.mentions ?? 0,
    kind: overrides.kind ?? "name",
    sourceQuery: overrides.sourceQuery ?? null,
  };
}

/** A group as `list_person_aliases` returns it: every row carries the
 *  canonical's mention count, not the alias's. */
function group(canonical: string, mentions: number, aliases: (string | AliasEntryView)[]): AliasGroupView {
  return {
    canonical,
    entries: aliases.map((alias) =>
      typeof alias === "string" ? entry(alias, { mentions }) : { ...alias, mentions },
    ),
  };
}

// --- mentions -------------------------------------------------------------

test("a row's mention count comes off whichever entry it has", () => {
  const rows = personAliasRows([group("Mr. Darcy", 418, ["达西", "Darcy"])]);
  assert.equal(rowMentions(rows[0]), 418);
});

test("a person known only by a taught description still reports mentions", () => {
  const rows = personAliasRows([
    group("Mr. Collins", 108, [entry("那个总在拍马屁的牧师", { kind: "description", source: "user" })]),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rowMentions(rows[0]), 108);
});

// --- ambiguity ------------------------------------------------------------

test("one alias under two canonicals is an ambiguity, most-mentioned first", () => {
  const rows = personAliasRows([
    group("Elizabeth", 634, ["伊丽莎白", "班内特小姐"]),
    group("Jane", 292, ["简", "班内特小姐"]),
  ]);
  const ambiguities = aliasAmbiguities(rows);

  assert.equal(ambiguities.length, 1);
  assert.equal(ambiguities[0].alias, "班内特小姐");
  assert.deepEqual(
    ambiguities[0].candidates.map((candidate) => [candidate.canonical, candidate.mentions]),
    [["Elizabeth", 634], ["Jane", 292]],
  );
});

test("the leading candidate is the one resolve() would default to", () => {
  // resolve() picks max(mentions) as default_canonical, so the bridge card can
  // only claim "默认按他找" if it orders candidates the same way — regardless
  // of the order the rows arrive in.
  const rows = personAliasRows([
    group("Elly Frankl", 11, ["Frankl"]),
    group("Viktor E. Frankl", 142, ["Frankl"]),
  ]);
  assert.equal(aliasAmbiguities(rows)[0].candidates[0].canonical, "Viktor E. Frankl");
});

test("an unambiguous alias is not flagged", () => {
  const rows = personAliasRows([
    group("Mr. Darcy", 418, ["达西"]),
    group("Mr. Bingley", 148, ["宾利"]),
  ]);
  assert.deepEqual(aliasAmbiguities(rows), []);
});

test("descriptions never raise an ambiguity", () => {
  // resolve()'s exact-match scan reads kind = 'name' only, so two people
  // sharing a taught phrase is not something anything acts on. Flagging it
  // would send the reader to delete a row that was never in the way.
  const rows = personAliasRows([
    group("Mr. Collins", 108, [entry("那个牧师", { kind: "description", source: "user" })]),
    group("Mr. Bennet", 183, [entry("那个牧师", { kind: "description", source: "user" })]),
  ]);
  assert.deepEqual(aliasAmbiguities(rows), []);
});

test("two ambiguities are ordered by their busiest candidate", () => {
  const rows = personAliasRows([
    group("Viktor E. Frankl", 142, ["Frankl"]),
    group("Alexander Vesely-Frankl", 23, ["Vesely-Frankl"]),
    group("Elly Frankl", 11, ["Frankl"]),
    group("Franz Vesely-Frankl", 6, ["Vesely-Frankl"]),
  ]);
  assert.deepEqual(
    aliasAmbiguities(rows).map((ambiguity) => ambiguity.alias),
    ["Frankl", "Vesely-Frankl"],
  );
});

test("each candidate carries the row id that deleting it would remove", () => {
  const rows = personAliasRows([
    group("Elizabeth", 634, [entry("班内特小姐", { id: "keep" })]),
    group("Jane", 292, [entry("班内特小姐", { id: "drop" })]),
  ]);
  const [ambiguity] = aliasAmbiguities(rows);
  // "改成只指 Elizabeth" is a delete of every other candidate's row.
  assert.deepEqual(
    ambiguity.candidates
      .filter((candidate) => candidate.canonical !== "Elizabeth")
      .map((candidate) => candidate.entryId),
    ["drop"],
  );
});

test("the chip badge set names only the ambiguous alias texts", () => {
  const rows = personAliasRows([
    group("Elizabeth", 634, ["伊丽莎白", "班内特小姐"]),
    group("Jane", 292, ["简", "班内特小姐"]),
  ]);
  const flagged = ambiguousAliasSet(aliasAmbiguities(rows));
  assert.ok(flagged.has("班内特小姐"));
  assert.ok(!flagged.has("伊丽莎白"));
});

// --- folding --------------------------------------------------------------

function ranked(count: number, from = 100): AliasGroupView[] {
  return Array.from({ length: count }, (_unused, index) =>
    group(`P${index}`, from - index, [`a${index}`]),
  );
}

test("nothing folds while the table fits", () => {
  const rows = personAliasRows(ranked(ALIAS_TABLE_VISIBLE_PEOPLE));
  const sections = aliasTableSections(rows, []);
  assert.equal(sections.visible.length, ALIAS_TABLE_VISIBLE_PEOPLE);
  assert.deepEqual(sections.folded, []);
  assert.equal(sections.foldedBelowMentions, null);
});

test("the tail folds and the fold line can say what is behind it", () => {
  const rows = personAliasRows(ranked(39));
  const sections = aliasTableSections(rows, []);
  assert.equal(sections.visible.length, 8);
  assert.equal(sections.folded.length, 31);
  // The busiest folded person occurs 92 times, so "都在 93 次以下" holds.
  assert.equal(sections.foldedBelowMentions, 93);
});

test("the backend's mentions ordering survives the cut", () => {
  const rows = personAliasRows(ranked(12));
  const sections = aliasTableSections(rows, []);
  assert.deepEqual(sections.visible.map(rowMentions), [100, 99, 98, 97, 96, 95, 94, 93]);
  assert.deepEqual(sections.folded.map(rowMentions), [92, 91, 90, 89]);
});

test("an ambiguous straggler is never folded away", () => {
  // Franz appears six times and would rank last — and he is the entire reason
  // the reader opened this table.
  const rows = personAliasRows([
    ...ranked(20),
    group("Alexander Vesely-Frankl", 23, ["Vesely-Frankl"]),
    group("Franz Vesely-Frankl", 6, ["Vesely-Frankl"]),
  ]);
  const sections = aliasTableSections(rows, aliasAmbiguities(rows));

  assert.ok(sections.visible.some((row) => row.canonical === "Franz Vesely-Frankl"));
  assert.ok(!sections.folded.some((row) => row.canonical === "Franz Vesely-Frankl"));
  // Pulling him up must not cost an ordinary row its slot.
  assert.equal(sections.visible.filter((row) => row.canonical.startsWith("P")).length, 8);
});

test("the fold bound stays true of every folded row, not of the last visible one", () => {
  // With Franz (6 mentions) pulled up, the least-mentioned visible row is 6 —
  // but rows mentioning 81 times are still folded, so 6 would be a lie.
  const rows = personAliasRows([
    ...ranked(20),
    group("Alexander Vesely-Frankl", 23, ["Vesely-Frankl"]),
    group("Franz Vesely-Frankl", 6, ["Vesely-Frankl"]),
  ]);
  const sections = aliasTableSections(rows, aliasAmbiguities(rows));
  const busiestFolded = Math.max(...sections.folded.map(rowMentions));
  assert.ok(sections.foldedBelowMentions! > busiestFolded);
  assert.equal(sections.foldedBelowMentions, 93);
});

// --- search and filter ----------------------------------------------------

const library = () =>
  personAliasRows([
    group("Elizabeth", 634, ["伊丽莎白", "班内特小姐"]),
    group("Mr. Darcy", 418, [entry("彭伯里的主人", { source: "user" }), entry("达西")]),
    group("Jane", 292, ["简", "班内特小姐"]),
  ]);

test("search reads the canonical column", () => {
  const rows = filterAliasRows(library(), [], "darcy", "all");
  assert.deepEqual(rows.map((row) => row.canonical), ["Mr. Darcy"]);
});

test("search reads the alias column too", () => {
  const rows = filterAliasRows(library(), [], "彭伯里", "all");
  assert.deepEqual(rows.map((row) => row.canonical), ["Mr. Darcy"]);
});

test("an empty query keeps everything", () => {
  assert.equal(filterAliasRows(library(), [], "   ", "all").length, 3);
});

test("the taught filter keeps rows the reader touched", () => {
  const rows = filterAliasRows(library(), [], "", "taught");
  assert.deepEqual(rows.map((row) => row.canonical), ["Mr. Darcy"]);
});

test("the flagged filter keeps only the people an ambiguity names", () => {
  const rows = library();
  const kept = filterAliasRows(rows, aliasAmbiguities(rows), "", "flagged");
  assert.deepEqual(kept.map((row) => row.canonical), ["Elizabeth", "Jane"]);
});

test("filter and search compose", () => {
  const rows = library();
  const kept = filterAliasRows(rows, aliasAmbiguities(rows), "jane", "flagged");
  assert.deepEqual(kept.map((row) => row.canonical), ["Jane"]);
});

// --- canonical completion -------------------------------------------------

const gardiners = () =>
  personAliasRows([
    group("Mrs. Gardiner", 19, ["嘉丁纳舅妈"]),
    group("Mr. Gardiner", 12, ["嘉丁纳舅舅"]),
    group("Mr. Darcy", 418, ["达西"]),
  ]);

test("completion offers the book's own names", () => {
  assert.deepEqual(
    canonicalCandidates(gardiners(), "Mrs. Gard").map((candidate) => candidate.canonical),
    ["Mrs. Gardiner"],
  );
});

test("a prefix match outranks a busier substring match", () => {
  // Mr. Darcy is mentioned 418 times but only contains "ar"; someone typing
  // "Gard" means a Gardiner.
  assert.deepEqual(
    canonicalCandidates(gardiners(), "Gard").map((candidate) => candidate.canonical),
    ["Mrs. Gardiner", "Mr. Gardiner"],
  );
});

test("completion carries the mention count the picker shows", () => {
  assert.deepEqual(canonicalCandidates(gardiners(), "Mrs."), [
    { canonical: "Mrs. Gardiner", mentions: 19 },
  ]);
});

test("an empty query offers nothing rather than the whole book", () => {
  assert.deepEqual(canonicalCandidates(gardiners(), "  "), []);
});

test("completion is capped", () => {
  const rows = personAliasRows(ranked(30));
  assert.equal(canonicalCandidates(rows, "P", 6).length, 6);
});

test("an exact name is recognised, a near miss is not", () => {
  assert.equal(isKnownCanonical(gardiners(), "Mrs. Gardiner"), true);
  assert.equal(isKnownCanonical(gardiners(), "Mrs. Gard"), false);
  assert.equal(isKnownCanonical(gardiners(), ""), false);
});

// --- rebuild confirmation counts ------------------------------------------

test("source counts split the table the way a rebuild does", () => {
  const rows = personAliasRows([
    group("Mr. Darcy", 418, [entry("达西"), entry("彭伯里的主人", { source: "user" })]),
    group("Mr. Collins", 108, [
      entry("柯林斯"),
      entry("那个总在拍马屁的牧师", { kind: "description", source: "user" }),
    ]),
  ]);
  // A taught description counts as taught: clear_auto_aliases leaves it, and
  // a rebuild cannot reconstruct it.
  assert.deepEqual(aliasSourceCounts(rows), { auto: 2, user: 2 });
});

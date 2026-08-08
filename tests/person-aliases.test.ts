import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  aliasTableCounts,
  descriptionMatching,
  personAliasRows,
  rowSource,
  type AliasEntryView,
  type AliasGroupView,
} from "../src/components/person-aliases.ts";

const entry = (over: Partial<AliasEntryView> = {}): AliasEntryView => ({
  id: "e1",
  alias: "柯林斯",
  source: "auto",
  mentions: 12,
  kind: "name",
  sourceQuery: null,
  ...over,
});

const collins = (): AliasGroupView => ({
  canonical: "Mr. Collins",
  entries: [
    entry({ id: "a", alias: "柯林斯" }),
    entry({ id: "b", alias: "那个牧师", source: "user" }),
    entry({
      id: "c",
      alias: "那个总在拍马屁的牧师",
      source: "user",
      kind: "description",
      sourceQuery: "那个总在拍马屁的牧师后来怎么样了？",
    }),
  ],
});

describe("personAliasRows", () => {
  it("keeps a person's descriptions in that person's own row", () => {
    const [row] = personAliasRows([collins()]);
    assert.equal(row.canonical, "Mr. Collins");
    assert.deepEqual(row.names.map((one) => one.id), ["a", "b"]);
    assert.deepEqual(row.descriptions.map((one) => one.id), ["c"]);
  });

  it("still renders a person whose only entries are descriptions", () => {
    // The bug this replaces: filtering to kind === "name" dropped these rows
    // entirely, which made the one kind of alias a rebuild cannot recreate
    // both invisible and undeletable.
    const rows = personAliasRows([
      {
        canonical: "Mrs. Bennet",
        entries: [entry({ id: "d", kind: "description", source: "user", sourceQuery: "…最后如愿了吗？" })],
      },
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].names.length, 0);
    assert.equal(rows[0].descriptions.length, 1);
  });

  it("treats an unrecognised kind as a name rather than dropping it", () => {
    const rows = personAliasRows([
      { canonical: "X", entries: [entry({ id: "e", kind: "epithet" as AliasEntryView["kind"] })] },
    ]);
    assert.deepEqual(rows[0].names.map((one) => one.id), ["e"]);
    assert.equal(rows[0].descriptions.length, 0);
  });

  it("drops a group that carries no entries at all", () => {
    assert.deepEqual(personAliasRows([{ canonical: "Ghost", entries: [] }]), []);
  });
});

describe("aliasTableCounts", () => {
  it("counts names and descriptions apart, so the count line can name both", () => {
    const rows = personAliasRows([
      collins(),
      {
        canonical: "Elizabeth Bennet",
        entries: [entry({ id: "f", alias: "伊丽莎白" }), entry({ id: "g", alias: "Lizzy" })],
      },
    ]);
    assert.deepEqual(aliasTableCounts(rows), { people: 2, aliases: 4, descriptions: 1 });
  });

  it("reports zero descriptions for a book that has only names", () => {
    const rows = personAliasRows([{ canonical: "Mr. Darcy", entries: [entry({ id: "h", alias: "达西" })] }]);
    assert.deepEqual(aliasTableCounts(rows), { people: 1, aliases: 1, descriptions: 0 });
  });
});

describe("rowSource", () => {
  it("counts a taught description toward the row's source", () => {
    const [row] = personAliasRows([
      {
        canonical: "Mrs. Bennet",
        entries: [
          entry({ id: "i", alias: "班纳特太太" }),
          entry({ id: "j", kind: "description", source: "user" }),
        ],
      },
    ]);
    assert.equal(rowSource(row), "both");
  });

  it("reads a names-only auto row as auto", () => {
    const [row] = personAliasRows([{ canonical: "Mr. Darcy", entries: [entry({ id: "k" })] }]);
    assert.equal(rowSource(row), "auto");
  });

  it("reads a row taught entirely by the reader as theirs", () => {
    const [row] = personAliasRows([
      { canonical: "Mrs. Bennet", entries: [entry({ id: "l", kind: "description", source: "user" })] },
    ]);
    assert.equal(rowSource(row), "user");
  });
});

describe("descriptionMatching", () => {
  const on = { available: true };
  const missing = { available: false };

  it("is on only when a model exists and the switch is on", () => {
    assert.equal(descriptionMatching({ ai_vector_retrieval: "true" }, false, on), "on");
  });

  it("blames the switch when a model exists but retrieval is off", () => {
    assert.equal(descriptionMatching({ ai_vector_retrieval: "false" }, false, on), "off");
    assert.equal(descriptionMatching({}, false, on), "off");
  });

  it("blames the missing model first, since the switch is unusable without one", () => {
    assert.equal(descriptionMatching({ ai_vector_retrieval: "true" }, false, missing), "unavailable");
    assert.equal(descriptionMatching({}, false, missing), "unavailable");
  });

  it("says nothing until both answers are in", () => {
    // An unloaded settings map reads as every switch off; warning on it would
    // flash a message the next render retracts.
    assert.equal(descriptionMatching({}, true, on), "on");
    assert.equal(descriptionMatching({ ai_vector_retrieval: "true" }, false, null), "on");
    assert.equal(descriptionMatching({}, true, null), "on");
  });
});

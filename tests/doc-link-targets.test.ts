import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// @ts-expect-error — plain .mjs script, no type declarations
import { checkDocLinks, splitTarget } from "../scripts/check-doc-links.mjs";

test("local links resolve absolute and relative targets and reject missing files", async () => {
  const root = await mkdtemp(join(tmpdir(), "lantern-doc-links-"));
  try {
    const docDir = join(root, "docs");
    await mkdir(docDir);
    const existing = join(root, "evidence.jsonl");
    await writeFile(existing, "{}\n");
    const missing = join(root, "missing.jsonl");
    const doc = join(docDir, "report.md");
    await writeFile(doc, [
      `[absolute](${existing}:12#entry)`,
      "[relative](../evidence.jsonl:1)",
      `[missing absolute](${missing})`,
      "[missing relative](../missing.jsonl)",
    ].join("\n"));

    const result = await checkDocLinks({ files: [doc] });
    assert.deepEqual(result.broken.map((link: { target: string }) => link.target), [
      missing, "../missing.jsonl",
    ]);
    assert.equal(result.fixed, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a bare path has no suffix to put back", () => {
  assert.deepEqual(splitTarget("../../src/pages/Reader.tsx"), {
    path: "../../src/pages/Reader.tsx",
    suffix: "",
  });
});

test("a line reference is a place inside the file, not part of its path", () => {
  assert.deepEqual(splitTarget("../../src-tauri/src/ai/router.rs:236"), {
    path: "../../src-tauri/src/ai/router.rs",
    suffix: ":236",
  });
  assert.deepEqual(splitTarget("../../src-tauri/src/ai/router.rs:236-241"), {
    path: "../../src-tauri/src/ai/router.rs",
    suffix: ":236-241",
  });
});

test("a heading anchor survives alongside a line reference", () => {
  assert.deepEqual(splitTarget("guide.md#setup"), {
    path: "guide.md",
    suffix: "#setup",
  });
  assert.deepEqual(splitTarget("guide.md:12#setup"), {
    path: "guide.md",
    suffix: ":12#setup",
  });
});

// Without this the fix would eat real path segments: a directory named `v2`
// or a file whose name ends in digits after a colon is still just a path.
test("only a trailing all-digit segment counts as a line reference", () => {
  assert.deepEqual(splitTarget("notes/2026-08-04.md"), {
    path: "notes/2026-08-04.md",
    suffix: "",
  });
  assert.deepEqual(splitTarget("router.rs:236a"), {
    path: "router.rs:236a",
    suffix: "",
  });
});

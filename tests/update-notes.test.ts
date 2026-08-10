import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  notesForUpdater,
  patchLatestJson,
  stripDownloadSections,
} from "../scripts/update-notes.mjs";
import { extractLocaleNotes } from "../src/services/updateNotes.ts";

// The two halves of the "the update prompt never said what changed" bug.
//
// `latest.json` is written by `tauri-action` during the build, long before
// anyone writes the changelog, so its `notes` field carried a placeholder
// ("the installers are ready") through v2.15.2 — the fixture below is that
// exact published asset. Everything downstream edited the *release body* and
// never the asset. `scripts/update-notes.mjs` re-uploads the asset once the
// body is final; `extractLocaleNotes` is what the toast then renders.
//
// The fixtures are real: the published v2.15.2 release body and the
// `latest.json` that shipped alongside it.
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/update-notes/${name}`, import.meta.url), "utf8");

const RELEASE_BODY = fixture("release-body-v2.15.2.md");
const LATEST_JSON = fixture("latest-v2.15.2.json");

// ---------------------------------------------------------------------------
// Release side: rewriting latest.json
// ---------------------------------------------------------------------------

test("the shipped v2.15.2 asset really did carry the placeholder", () => {
  // If this ever stops being true the bug was fixed some other way and the
  // rest of this file is guarding a problem that no longer exists.
  const shipped = JSON.parse(LATEST_JSON);
  assert.match(shipped.notes, /安装包已准备完成/);
  assert.doesNotMatch(shipped.notes, /免费词典查词/);
});

test("download sections are dropped in both languages", () => {
  const notes = stripDownloadSections(RELEASE_BODY);
  assert.doesNotMatch(notes, /### 下载与兼容/);
  assert.doesNotMatch(notes, /### Download and compatibility/);
  // The dmg/exe filenames were the point of dropping it — a reader being
  // offered an in-place update never downloads either file by hand.
  assert.doesNotMatch(notes, /Lantern_2\.15\.2_aarch64\.dmg/);
  assert.doesNotMatch(notes, /Lantern_2\.15\.2_x64-setup\.exe/);
});

test("dropping the download section leaves the changelog and both anchors intact", () => {
  const notes = stripDownloadSections(RELEASE_BODY);
  // The anchors are load-bearing: the client splits on them to pick a language.
  assert.match(notes, /<a id="chinese"><\/a>/);
  assert.match(notes, /<a id="english"><\/a>/);
  assert.match(notes, /### 修复/);
  assert.match(notes, /### 改进/);
  assert.match(notes, /### Bug Fixes/);
  assert.match(notes, /### Improvements/);
  assert.match(notes, /免费词典查词，此前对整套学习系统完全隐形/);
  assert.match(notes, /Free dictionary lookups were invisible to the whole learning system/);
});

test("the English download heading is matched in the variants that have shipped", () => {
  for (const heading of [
    "### Download and compatibility",
    "### Downloads & Compatibility",
    "## Downloads",
    "### 下载与兼容",
  ]) {
    const body = `### Fixes\n\n- something\n\n${heading}\n\n- a dmg\n`;
    assert.equal(stripDownloadSections(body), "### Fixes\n\n- something", heading);
  }
});

test("a body with nothing left is reported as no notes at all", () => {
  // Better a stale placeholder than an empty update prompt.
  assert.equal(notesForUpdater("### Downloads\n\n- a dmg\n"), null);
  assert.equal(notesForUpdater("   \n\n  "), null);
  assert.equal(notesForUpdater(null), null);
  assert.equal(notesForUpdater(undefined), null);
});

test("patching latest.json replaces the notes with the real changelog", () => {
  const patched = JSON.parse(patchLatestJson(LATEST_JSON, notesForUpdater(RELEASE_BODY)!));
  assert.match(patched.notes, /免费词典查词，此前对整套学习系统完全隐形/);
  assert.doesNotMatch(patched.notes, /安装包已准备完成/);
});

test("patching latest.json preserves every signature and url byte for byte", () => {
  // The signatures are the updater's entire integrity check. A mangled one
  // does not degrade the prompt, it stops every client on every platform from
  // updating at all — and it would ship green, because nothing else reads it.
  const before = JSON.parse(LATEST_JSON);
  const after = JSON.parse(patchLatestJson(LATEST_JSON, "rewritten"));

  assert.deepEqual(Object.keys(after), Object.keys(before));
  assert.equal(after.version, before.version);
  assert.equal(after.pub_date, before.pub_date);
  assert.deepEqual(Object.keys(after.platforms), Object.keys(before.platforms));
  for (const [name, platform] of Object.entries<{ signature: string; url: string }>(
    before.platforms,
  )) {
    assert.equal(after.platforms[name].signature, platform.signature, name);
    assert.equal(after.platforms[name].url, platform.url, name);
  }
  // Non-empty, so the assertions above are comparing something real.
  assert.ok(Object.keys(before.platforms).length >= 4);
});

test("patching is idempotent — re-running on a finished release changes nothing", () => {
  const notes = notesForUpdater(RELEASE_BODY)!;
  const once = patchLatestJson(LATEST_JSON, notes);
  assert.equal(patchLatestJson(once, notes), once);
});

test("an unknown field in a future latest.json survives the rewrite", () => {
  const source = JSON.stringify({ ...JSON.parse(LATEST_JSON), someFutureField: { a: 1 } });
  const patched = JSON.parse(patchLatestJson(source, "notes"));
  assert.deepEqual(patched.someFutureField, { a: 1 });
});

test("a latest.json without platforms is refused rather than rewritten", () => {
  // A truncated or wrong-asset download must not be uploaded back over a good
  // one with the platform map missing.
  assert.throws(() => patchLatestJson(JSON.stringify({ version: "1.0.0" }), "notes"), /platforms/);
  assert.throws(() => patchLatestJson("[]", "notes"), /JSON object/);
});

// ---------------------------------------------------------------------------
// Wiring: the script only helps if something actually runs it
// ---------------------------------------------------------------------------

const repoFile = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the release workflow runs the sync after it rewrites the body", () => {
  const workflow = repoFile(".github/workflows/release.yml");
  assert.match(workflow, /node scripts\/update-notes\.mjs/);
  // The script reads the body back, so it is worthless before the body is
  // written. Order in the job is order of execution.
  assert.ok(
    workflow.indexOf("gh release edit \"$TAG\" --notes-file notes.md")
      < workflow.indexOf("node scripts/update-notes.mjs"),
    "the sync step must come after the body is written",
  );
  // Without a checkout the job has no scripts/ directory to run.
  const job = workflow.slice(workflow.indexOf("  release-notes:"));
  assert.match(job, /uses: actions\/checkout@v4/);
});

test("the release skill syncs the asset after it publishes the changelog", () => {
  // The workflow's own run can only carry the neutral notes -- the changelog
  // does not exist until a human writes it -- so this is the run that puts the
  // real thing in front of readers. If the skill stops calling it, the bug is
  // back and nothing else would notice.
  // The real file. `.claude/skills/release` is a symlink to this directory.
  const skill = repoFile(".agents/skills/release/SKILL.md");
  assert.match(skill, /node scripts\/update-notes\.mjs/);
  assert.ok(
    skill.indexOf("gh release edit v{version} --draft=false")
      < skill.indexOf("node scripts/update-notes.mjs"),
    "the sync step must come after the release notes are published",
  );
});

// ---------------------------------------------------------------------------
// Client side: picking one language out of the notes
// ---------------------------------------------------------------------------

const NOTES = notesForUpdater(RELEASE_BODY)!;

test("a Chinese interface gets the Chinese block and none of the English one", () => {
  const notes = extractLocaleNotes(NOTES, "zh")!;
  assert.match(notes, /免费词典查词，此前对整套学习系统完全隐形/);
  assert.match(notes, /### 修复/);
  assert.doesNotMatch(notes, /Free dictionary lookups/);
  assert.doesNotMatch(notes, /### Bug Fixes/);
});

test("an English interface gets the English block and none of the Chinese one", () => {
  const notes = extractLocaleNotes(NOTES, "en")!;
  assert.match(notes, /Free dictionary lookups were invisible to the whole learning system/);
  assert.match(notes, /### Bug Fixes/);
  assert.doesNotMatch(notes, /免费词典查词/);
  assert.doesNotMatch(notes, /### 修复/);
});

test("regional Chinese tags resolve to the Chinese block", () => {
  for (const tag of ["zh-CN", "zh-Hans", "zh-Hans-CN", "ZH"]) {
    assert.match(extractLocaleNotes(NOTES, tag)!, /### 修复/, tag);
  }
});

test("the extracted block keeps no anchors, link row or language heading", () => {
  for (const language of ["zh", "en"]) {
    const notes = extractLocaleNotes(NOTES, language)!;
    // These are in-page navigation for the GitHub release page; in a toast the
    // links point nowhere and the heading repeats a language already chosen.
    assert.doesNotMatch(notes, /<a id=/, language);
    assert.doesNotMatch(notes, /\(#chinese\)/, language);
    assert.doesNotMatch(notes, /\(#english\)/, language);
    assert.doesNotMatch(notes, /^#{1,3} (中文|English)\s*$/m, language);
    // …and still opens on real content rather than a run of blank lines.
    assert.match(notes, /^#{1,4} \S/);
  }
});

test("an unknown interface language falls back to English rather than to nothing", () => {
  assert.match(extractLocaleNotes(NOTES, "de")!, /### Bug Fixes/);
});

test("a single-language body with no anchors is shown whole", () => {
  // A release published without the bilingual scaffolding still says more than
  // the bare version line does.
  const notes = extractLocaleNotes("### Fixes\n\n- fixed the thing\n", "zh")!;
  assert.equal(notes, "### Fixes\n\n- fixed the thing");
});

test("an empty or missing body means no changelog, not an empty panel", () => {
  // The toast falls back to the bare "vX.Y.Z is available" line on null.
  assert.equal(extractLocaleNotes("", "zh"), null);
  assert.equal(extractLocaleNotes(null, "zh"), null);
  assert.equal(extractLocaleNotes(undefined, "en"), null);
  assert.equal(extractLocaleNotes("[简体中文](#chinese) · [English](#english)", "zh"), null);
  assert.equal(
    extractLocaleNotes('<a id="chinese"></a>\n## 中文\n\n<a id="english"></a>\n## English', "zh"),
    null,
  );
});

test("the placeholder that shipped through v2.15.2 still renders per language", () => {
  // Not a happy path, but if a release ever goes out without the sync step the
  // toast should degrade to the old text, not to a broken panel.
  const shipped = JSON.parse(LATEST_JSON).notes;
  assert.match(extractLocaleNotes(shipped, "zh")!, /安装包已准备完成/);
  assert.match(extractLocaleNotes(shipped, "en")!, /installers are ready/);
});

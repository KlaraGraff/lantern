#!/usr/bin/env node
/**
 * Put the real changelog into `latest.json`.
 *
 * The updater reads `notes` out of the `latest.json` asset, not out of the
 * GitHub release body. `tauri-action` writes that asset during the build, and
 * it fills `notes` with whatever `releaseBody` the workflow handed it — which
 * at build time is a placeholder ("the installers are ready"), because nobody
 * has written the changelog yet. Everything that happens later (`release-notes`
 * rewriting the body, a human publishing the real bilingual changelog with
 * `gh release edit --notes-file`) edits the *release body* and never touches
 * the already-uploaded asset. So through v2.15.2 every reader who was offered
 * an update was told only that installers existed.
 *
 * This script closes that gap: read the release body back once it is final,
 * strip the parts that only make sense to someone who has not installed the
 * app yet, and re-upload `latest.json` with `notes` replaced and *nothing else
 * touched*. The per-platform `signature` values are the updater's whole
 * integrity check — corrupt one and every client refuses the update — so the
 * patch is deliberately narrow and `assertOnlyNotesChanged` proves it.
 *
 * Idempotent: running it twice on a finished release is a no-op re-upload.
 *
 *   node scripts/update-notes.mjs <tag> [--repo owner/name] [--dry-run]
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Headings that open the "which file do I download, and will it run on my
 * machine" section. It is the right way to end a release page and the wrong
 * way to open an update prompt: the reader being prompted already has Lantern
 * installed and is about to update in place, so dmg/exe filenames and "Apple
 * Silicon only" are noise pushing the actual changes out of view.
 *
 * Matched loosely on purpose — the English heading has been both "Download and
 * compatibility" and "Downloads & Compatibility" across releases, and a
 * heading that stops matching would silently reinstate the noise.
 */
const DOWNLOAD_HEADING = /^#{2,4}\s*(下载|下載|downloads?\b)/i;

/** A `## ...` / `### ...` heading, or one of the language anchors. */
const SECTION_BOUNDARY = /^(#{1,4}\s|<a\s+id=)/i;

/**
 * Drop every download/compatibility section from a release body, leaving the
 * rest — anchors, language headings, section order — byte-identical, because
 * the client splits the result by those anchors to pick its language.
 */
export function stripDownloadSections(body) {
  const lines = body.split("\n");
  const kept = [];
  let skipping = false;

  for (const line of lines) {
    if (skipping) {
      // A download section runs until the next heading or language anchor.
      if (!SECTION_BOUNDARY.test(line)) continue;
      skipping = false;
    }
    if (DOWNLOAD_HEADING.test(line)) {
      skipping = true;
      continue;
    }
    kept.push(line);
  }

  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * The exact string to store in `latest.json`'s `notes`.
 *
 * Returns `null` when the body has nothing left worth showing, so the caller
 * can leave the asset alone rather than overwrite a real changelog with "".
 */
export function notesForUpdater(body) {
  if (typeof body !== "string") return null;
  const notes = stripDownloadSections(body);
  return notes.length > 0 ? notes : null;
}

/**
 * Replace `notes` and only `notes`.
 *
 * Rebuilt key by key from the original rather than mutated in place, so a
 * future field this script has never heard of survives untouched instead of
 * being dropped by a hand-written schema.
 */
export function patchLatestJson(latestJsonText, notes) {
  const original = JSON.parse(latestJsonText);
  if (!original || typeof original !== "object" || Array.isArray(original)) {
    throw new Error("latest.json is not a JSON object");
  }
  if (!original.platforms || typeof original.platforms !== "object") {
    throw new Error("latest.json has no platforms map — refusing to rewrite it");
  }

  const patched = {};
  for (const [key, value] of Object.entries(original)) {
    patched[key] = key === "notes" ? notes : value;
  }
  // A `latest.json` that somehow arrived without a `notes` key still gets one.
  if (!("notes" in patched)) patched.notes = notes;

  assertOnlyNotesChanged(original, patched);
  return `${JSON.stringify(patched, null, 2)}\n`;
}

/**
 * Fail loudly if anything but `notes` moved.
 *
 * This is the guard that matters. `signature` and `url` are what the updater
 * verifies the download against; a mangled signature does not degrade the
 * update experience, it breaks updating entirely for every client on every
 * platform, and it would ship green because nothing else in the pipeline reads
 * these values.
 */
export function assertOnlyNotesChanged(original, patched) {
  const blank = (value) => {
    const { notes: _dropped, ...rest } = value;
    return rest;
  };
  const before = JSON.stringify(blank(original));
  const after = JSON.stringify(blank(patched));
  if (before !== after) {
    throw new Error(
      `latest.json changed outside "notes"\n  before: ${before}\n  after:  ${after}`,
    );
  }
  return true;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function gh(args, { repo }) {
  const result = spawnSync("gh", repo ? [...args, "--repo", repo] : args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`gh ${args.join(" ")} failed (${result.status}): ${result.stderr.trim()}`);
  }
  return result.stdout;
}

async function main(argv) {
  const repoFlag = argv.indexOf("--repo");
  const repo = repoFlag === -1 ? process.env.GH_REPO : argv[repoFlag + 1];
  const dryRun = argv.includes("--dry-run");
  // `--repo`'s value is not a flag, so skip it explicitly rather than let
  // `update-notes.mjs --repo owner/name v1.2.3` mistake the owner for the tag.
  const repoValue = repoFlag === -1 ? -1 : repoFlag + 1;
  const tag = argv.find((arg, index) => !arg.startsWith("--") && index !== repoValue);
  if (!tag) {
    console.error("usage: node scripts/update-notes.mjs <tag> [--repo owner/name] [--dry-run]");
    process.exit(2);
  }

  const body = JSON.parse(gh(["release", "view", tag, "--json", "body"], { repo })).body;
  const notes = notesForUpdater(body);
  if (!notes) {
    // Better a stale placeholder than an empty prompt: leave the asset alone.
    console.error(`release ${tag} has no usable body — leaving latest.json untouched`);
    return;
  }

  const dir = await mkdtemp(path.join(tmpdir(), "lantern-update-notes-"));
  const file = path.join(dir, "latest.json");
  gh(["release", "download", tag, "--pattern", "latest.json", "--dir", dir, "--clobber"], { repo });

  const patched = patchLatestJson(await readFile(file, "utf8"), notes);
  await writeFile(file, patched, "utf8");

  console.log(`notes for ${tag}: ${notes.length} chars`);
  if (dryRun) {
    console.log(patched);
    return;
  }

  gh(["release", "upload", tag, file, "--clobber"], { repo });
  console.log(`uploaded latest.json for ${tag}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message ?? error);
    process.exit(1);
  });
}

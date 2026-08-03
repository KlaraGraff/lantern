import { readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Markdown links rot silently: nothing builds, nothing fails, so a doc moved
// into `archive/` can leave dead links behind for a year. This is the check
// that makes that visible, and `--fix` repairs the mechanical cases.

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");

// Only prose is scanned. A path inside a code fence, an inline code span, or a
// commented-out block is an example or a placeholder, not a reference — the
// README's unshot screenshots live in HTML comments, and reporting those would
// train everyone to ignore this check.
const MASKED = [
  /```[\s\S]*?(?:```|$)/g,
  /~~~[\s\S]*?(?:~~~|$)/g,
  /<!--[\s\S]*?(?:-->|$)/g,
  /`[^`\n]*`/g,
];

export function maskNonProse(text) {
  let masked = text;
  for (const pattern of MASKED) {
    masked = masked.replace(pattern, (match) =>
      match.replace(/[^\n]/g, " "));
  }
  return masked;
}

/** Rewrites to try, most likely first. Each is only accepted if it resolves. */
function candidates(fileDir, target) {
  const hash = target.indexOf("#");
  const path = hash === -1 ? target : target.slice(0, hash);
  const anchor = hash === -1 ? "" : target.slice(hash);
  const parent = posix.dirname(path);
  const name = posix.basename(path);
  const tries = [];
  // The doc itself moved one level deeper, so its own `../` counts short.
  if (path.startsWith("../")) tries.push(`../${path}`);
  // The target moved into `archive/`.
  const archived = parent === "." ? `archive/${name}` : `${parent}/archive/${name}`;
  tries.push(archived);
  if (path.startsWith("../")) tries.push(`../${archived}`);
  // The mirror case: the doc itself moved into `archive/`, so a link that
  // reached for an already-archived sibling now points one level too deep.
  if (parent === "archive") tries.push(name);
  // The repo was renamed, dropping the `quill/` root prefix these paths carry.
  if (path.startsWith("quill/")) {
    const up = "../".repeat(relative(ROOT, fileDir).split("/").length);
    tries.push(up + path.slice("quill/".length));
  }
  return tries.map((try_) => ({ path: try_, target: try_ + anchor }));
}

async function markdownFiles() {
  const found = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".md")) found.push(full);
    }
  };
  await walk(join(ROOT, "docs"));
  for (const entry of await readdir(ROOT, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md")) found.push(join(ROOT, entry.name));
  }
  return found.sort();
}

export async function checkDocLinks({ fix = false } = {}) {
  const broken = [];
  let fixed = 0;
  for (const file of await markdownFiles()) {
    const original = await readFile(file, "utf8");
    const masked = maskNonProse(original);
    const dir = dirname(file);
    let text = original;
    let drift = 0;
    for (const match of masked.matchAll(/\[([^\]]*)\]\(([^)\s]+)\)/g)) {
      const [, label, target] = match;
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const path = target.split("#")[0];
      if (!path || existsSync(join(dir, path))) continue;
      const line = masked.slice(0, match.index).split("\n").length;
      const where = `${relative(ROOT, file)}:${line}`;
      // Always take the label from the source: masking blanks out any code
      // span inside it, and writing that back would erase the label.
      const sourceLabel = original.substr(match.index + 1, label.length);
      const hit = fix
        ? candidates(dir, target).find((c) => existsSync(join(dir, c.path)))
        : undefined;
      if (!hit) {
        broken.push({ where, label: sourceLabel, target });
        continue;
      }
      const at = match.index + drift;
      const replacement = `[${sourceLabel}](${hit.target})`;
      text = text.slice(0, at) + replacement + text.slice(at + match[0].length);
      drift += replacement.length - match[0].length;
      fixed += 1;
    }
    if (text !== original) await writeFile(file, text);
  }
  return { broken, fixed };
}

const isMain = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  const fix = process.argv.includes("--fix");
  const { broken, fixed } = await checkDocLinks({ fix });
  if (fixed) console.log(`Repointed ${fixed} link${fixed === 1 ? "" : "s"}.`);
  if (broken.length) {
    console.error(`Broken documentation links (${broken.length}):`);
    for (const { where, label, target } of broken) {
      console.error(`  ${where}  [${label}](${target})`);
    }
    console.error(
      fix
        ? "\nNo verified target exists for these. Repoint or delink them by hand."
        : "\nRun `npm run check:docs -- --fix` to repoint the ones that resolve.",
    );
    process.exitCode = 1;
  } else {
    console.log("Documentation links: all relative links resolve.");
  }
}

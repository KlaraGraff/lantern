/**
 * "What should an unstubbed command return?"
 *
 * `virtual:harness-rust-shapes` is a `{ command: "AppResult<Vec<Book>>" }` map
 * scraped out of the Rust sources by `vite.config.harness.ts`. Turning that
 * string into a JS value gets a default stub much closer to right than a blanket
 * `null`: a list command answers `[]`, a map command `{}`, a counter `0`. That
 * matters because most crashes in this app are `x.map is not a function` on a
 * value the caller assumed was a list.
 *
 * A bare struct return (`AppResult<SyncStatus>`) can only be guessed as `{}`.
 * That is honest — the caller reads `undefined` fields rather than exploding on
 * the wrong primitive — and any command where `{}` is not good enough gets a
 * hand-written fixture in `invoke-fixtures.ts` instead.
 */
import rustShapes from "virtual:harness-rust-shapes";

const SHAPES: Record<string, string> = rustShapes as Record<string, string>;

const INT = /^(u|i)(8|16|32|64|128|size)$/;
const FLOAT = /^f(32|64)$/;

/** Strip one layer of `Wrapper<...>`, returning the inner text, or null. */
function unwrap(type: string, wrapper: string): string | null {
  const prefix = `${wrapper}<`;
  const at = type.indexOf(prefix);
  if (at === -1) return null;
  // Only unwrap when the wrapper is the outermost constructor (allowing a
  // module path in front of it, e.g. `crate::ai::Foo` never matches `Vec`).
  const head = type.slice(0, at);
  if (head && !/^[\w:]*$/.test(head)) return null;
  if (head && !head.endsWith("::") && head !== "") return null;
  let depth = 0;
  for (let i = at + prefix.length - 1; i < type.length; i++) {
    if (type[i] === "<") depth++;
    else if (type[i] === ">" && --depth === 0) return type.slice(at + prefix.length, i);
  }
  return null;
}

function defaultForRustType(raw: string): unknown {
  const type = raw.trim();
  if (type === "" || type === "()") return null;

  for (const wrapper of ["AppResult", "Result", "tauri::Result", "anyhow::Result"]) {
    const inner = unwrap(type, wrapper);
    // `Result<T, E>` — take T only.
    if (inner !== null) return defaultForRustType(splitTop(inner)[0]);
  }
  if (unwrap(type, "Option") !== null) return null;
  if (unwrap(type, "Vec") !== null || unwrap(type, "VecDeque") !== null) return [];
  for (const map of ["HashMap", "BTreeMap", "IndexMap"]) {
    if (unwrap(type, map) !== null) return {};
  }
  for (const set of ["HashSet", "BTreeSet"]) {
    if (unwrap(type, set) !== null) return [];
  }

  const bare = type.split("::").pop() ?? type;
  if (bare === "bool") return false;
  if (INT.test(bare) || FLOAT.test(bare)) return 0;
  if (bare === "String" || bare === "str" || bare === "&str" || bare === "PathBuf") return "";
  if (type.startsWith("(")) return null; // tuple — no sane guess
  // Named struct / enum. `{}` keeps property reads harmless.
  return {};
}

/** Split `A, B` at top level (ignoring nested generics). */
function splitTop(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "<" || c === "(") depth++;
    else if (c === ">" || c === ")") depth--;
    else if (c === "," && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(inner.slice(start));
  return parts;
}

const cache = new Map<string, unknown>();

/**
 * The stub value for a command with no hand-written fixture. Returns a fresh
 * array/object each call so a caller mutating the result can't poison the next.
 */
export function stubValueFor(command: string): unknown {
  if (!cache.has(command)) {
    const shape = SHAPES[command];
    cache.set(command, shape === undefined ? null : defaultForRustType(shape));
  }
  const value = cache.get(command);
  if (Array.isArray(value)) return [];
  if (value && typeof value === "object") return {};
  return value ?? null;
}

/** The scraped Rust return type, for the harness report. */
export function rustShapeFor(command: string): string | undefined {
  return SHAPES[command];
}

export const knownCommandCount = Object.keys(SHAPES).length;

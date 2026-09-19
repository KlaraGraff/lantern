import type {
  LearningContentItem,
  LearningExample,
  LearningModuleContent,
  LearningModuleId,
} from "./types";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const textList = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [value]).flatMap((entry) => {
    const parsed = text(entry);
    return parsed ? [parsed] : [];
  });

function parseExample(value: unknown): LearningExample | null {
  const source = text(isObject(value) ? value.source : value);
  if (!source) return null;
  return { source, target: isObject(value) ? text(value.target) : undefined };
}

function parseItem(value: unknown): LearningContentItem | null {
  if (typeof value === "string") return text(value) ? { title: text(value)! } : null;
  if (!isObject(value)) return null;
  const title = text(value.title) ?? text(value.text);
  if (!title) return null;
  return {
    title,
    text: text(value.text),
    meta: textList(value.meta),
    examples: Array.isArray(value.examples)
      ? value.examples.flatMap((entry) => {
        const example = parseExample(entry);
        return example ? [example] : [];
      })
      : [],
  };
}

// Match the backend's salvage rules so one malformed module cannot block the
// valid modules after it in either the reader or the settings preview.
function parseModuleContent(value: unknown): LearningModuleContent | null {
  if (typeof value === "string") return text(value) ? { summary: text(value)! } : null;
  if (Array.isArray(value)) return { details: textList(value) };
  if (!isObject(value)) return null;
  return {
    heading: text(value.heading),
    summary: text(value.summary),
    quote: text(value.quote),
    meta: textList(value.meta),
    details: textList(value.details),
    items: Array.isArray(value.items)
      ? value.items.flatMap((entry) => {
        const item = parseItem(entry);
        return item ? [item] : [];
      })
      : [],
  };
}

/**
 * Extracts readable modules from the streamed card JSON. The
 * backend's fully parsed response remains authoritative; this parser exists
 * solely to reveal validated modules while that response is still arriving.
 */
export class LearningCardStreamParser {
  private buffer = "";
  private modulesKeyIndex: number | null = null;
  private seekFrom = 0;
  private cursor = 0;
  private pendingKey: LearningModuleId | null = null;
  private valueStart = -1;
  private depth = 0;
  private inString = false;
  private escaped = false;
  private done = false;

  private readonly allowedIds: ReadonlySet<LearningModuleId>;

  constructor(allowedIds: ReadonlySet<LearningModuleId>) {
    this.allowedIds = allowedIds;
  }

  push(delta: string): Partial<Record<LearningModuleId, LearningModuleContent>> {
    const completed: Partial<Record<LearningModuleId, LearningModuleContent>> = {};
    if (!delta || this.done) return completed;
    this.buffer += delta;

    if (!this.seekModulesObject()) return completed;

    while (this.cursor < this.buffer.length && !this.done) {
      if (this.valueStart >= 0) {
        this.scanValue(completed);
        if (this.valueStart >= 0) break;
        continue;
      }

      this.skipWhitespaceAndCommas();
      if (this.cursor >= this.buffer.length) break;
      if (this.buffer[this.cursor] === "}") {
        this.done = true;
        break;
      }

      const key = this.readString(this.cursor);
      if (!key) break;
      let next = this.skipWhitespaceFrom(key.end);
      if (next >= this.buffer.length) break;
      if (this.buffer[next] !== ":") {
        this.done = true;
        break;
      }
      next = this.skipWhitespaceFrom(next + 1);
      if (next >= this.buffer.length) break;
      this.pendingKey = this.allowedIds.has(key.value as LearningModuleId)
        ? key.value as LearningModuleId
        : null;
      this.valueStart = next;
      this.cursor = next;
      this.depth = 0;
      this.inString = false;
      this.escaped = false;
    }

    return completed;
  }

  private seekModulesObject(): boolean {
    if (this.cursor > 0) return true;
    while (true) {
      if (this.modulesKeyIndex === null) {
        const index = this.buffer.indexOf('"modules"', this.seekFrom);
        if (index < 0) {
          this.seekFrom = Math.max(0, this.buffer.length - '"modules"'.length + 1);
          return false;
        }
        this.modulesKeyIndex = index;
      }

      let next = this.skipWhitespaceFrom(this.modulesKeyIndex + '"modules"'.length);
      if (next >= this.buffer.length) return false;
      if (this.buffer[next] !== ":") {
        this.seekFrom = this.modulesKeyIndex + 1;
        this.modulesKeyIndex = null;
        continue;
      }
      next = this.skipWhitespaceFrom(next + 1);
      if (next >= this.buffer.length) return false;
      if (this.buffer[next] !== "{") {
        this.seekFrom = this.modulesKeyIndex + 1;
        this.modulesKeyIndex = null;
        continue;
      }
      this.cursor = next + 1;
      return true;
    }
  }

  private scanValue(completed: Partial<Record<LearningModuleId, LearningModuleContent>>) {
    while (this.cursor < this.buffer.length) {
      const char = this.buffer[this.cursor];
      // A delimiter at depth zero belongs to the enclosing modules object.
      // Waiting for it also handles primitive values split across chunks.
      if (!this.inString && this.depth === 0 && (char === "," || char === "}")) {
        const raw = this.buffer.slice(this.valueStart, this.cursor);
        this.finishValue(raw, completed);
        return;
      }
      this.cursor += 1;
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (char === "\\") this.escaped = true;
        else if (char === '"') this.inString = false;
        continue;
      }
      if (char === '"') this.inString = true;
      else if (char === "{" || char === "[") this.depth += 1;
      else if (char === "}" || char === "]") {
        this.depth -= 1;
        if (this.depth === 0) {
          this.finishValue(this.buffer.slice(this.valueStart, this.cursor), completed);
          return;
        }
      }
    }
  }

  private finishValue(raw: string, completed: Partial<Record<LearningModuleId, LearningModuleContent>>) {
    if (this.pendingKey) {
      try {
        const content = parseModuleContent(JSON.parse(raw));
        if (content && (
          content.heading || content.summary || content.quote
          || content.meta?.length || content.details?.length || content.items?.length
        )) completed[this.pendingKey] = content;
      } catch {
        // The final backend parse reports damaged content.
      }
    }
    this.pendingKey = null;
    this.valueStart = -1;
  }

  private readString(start: number): { value: string; end: number } | null {
    if (this.buffer[start] !== '"') {
      this.done = true;
      return null;
    }
    let escaped = false;
    for (let index = start + 1; index < this.buffer.length; index += 1) {
      const char = this.buffer[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char !== '"') continue;
      try {
        return {
          value: JSON.parse(this.buffer.slice(start, index + 1)) as string,
          end: index + 1,
        };
      } catch {
        this.done = true;
        return null;
      }
    }
    return null;
  }

  private skipWhitespaceFrom(start: number): number {
    let index = start;
    while (index < this.buffer.length && /\s/.test(this.buffer[index])) {
      index += 1;
    }
    return index;
  }

  private skipWhitespaceAndCommas() {
    while (
      this.cursor < this.buffer.length
      && (this.buffer[this.cursor] === "," || /\s/.test(this.buffer[this.cursor]))
    ) {
      this.cursor += 1;
    }
  }
}

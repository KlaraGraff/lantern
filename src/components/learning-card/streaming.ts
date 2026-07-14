import type {
  LearningContentItem,
  LearningExample,
  LearningModuleContent,
  LearningModuleId,
} from "./types";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isOptionalString = (value: unknown) => value === undefined || typeof value === "string";

const isOptionalStringArray = (value: unknown) => (
  value === undefined
  || (Array.isArray(value) && value.every((item) => typeof item === "string"))
);

function parseExample(value: unknown): LearningExample | null {
  if (!isObject(value) || typeof value.source !== "string" || !isOptionalString(value.target)) {
    return null;
  }
  return {
    source: value.source,
    ...(typeof value.target === "string" ? { target: value.target } : {}),
  };
}

function parseItem(value: unknown): LearningContentItem | null {
  if (
    !isObject(value)
    || typeof value.title !== "string"
    || !isOptionalString(value.text)
    || !isOptionalStringArray(value.meta)
    || (value.examples !== undefined && !Array.isArray(value.examples))
  ) {
    return null;
  }
  const rawExamples = Array.isArray(value.examples) ? value.examples : undefined;
  const examples = rawExamples?.map(parseExample) ?? [];
  if (examples.some((example) => example === null)) return null;
  return {
    title: value.title,
    ...(typeof value.text === "string" ? { text: value.text } : {}),
    ...(Array.isArray(value.meta) ? { meta: value.meta } : {}),
    ...(rawExamples ? { examples: examples as LearningExample[] } : {}),
  };
}

function parseModuleContent(value: unknown): LearningModuleContent | null {
  if (
    !isObject(value)
    || !isOptionalString(value.heading)
    || !isOptionalString(value.summary)
    || !isOptionalString(value.quote)
    || !isOptionalStringArray(value.meta)
    || !isOptionalStringArray(value.details)
    || (value.items !== undefined && !Array.isArray(value.items))
  ) {
    return null;
  }
  const rawItems = Array.isArray(value.items) ? value.items : undefined;
  const items = rawItems?.map(parseItem) ?? [];
  if (items.some((item) => item === null)) return null;
  return {
    ...(typeof value.heading === "string" ? { heading: value.heading } : {}),
    ...(typeof value.summary === "string" ? { summary: value.summary } : {}),
    ...(Array.isArray(value.meta) ? { meta: value.meta } : {}),
    ...(Array.isArray(value.details) ? { details: value.details } : {}),
    ...(rawItems ? { items: items as LearningContentItem[] } : {}),
    ...(typeof value.quote === "string" ? { quote: value.quote } : {}),
  };
}

/**
 * Extracts only complete module objects from the streamed card JSON. The
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

  constructor(private readonly allowedIds: ReadonlySet<LearningModuleId>) {}

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
      if (this.buffer[next] !== "{") {
        this.done = true;
        break;
      }

      this.pendingKey = this.allowedIds.has(key.value as LearningModuleId)
        ? key.value as LearningModuleId
        : null;
      this.valueStart = next;
      this.cursor = next + 1;
      this.depth = 1;
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
      this.cursor += 1;

      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (char === "\\") this.escaped = true;
        else if (char === '"') this.inString = false;
        continue;
      }
      if (char === '"') {
        this.inString = true;
        continue;
      }
      if (char === "{" || char === "[") this.depth += 1;
      else if (char === "}" || char === "]") this.depth -= 1;

      if (this.depth !== 0) continue;
      const raw = this.buffer.slice(this.valueStart, this.cursor);
      if (this.pendingKey) {
        try {
          const content = parseModuleContent(JSON.parse(raw));
          if (content) completed[this.pendingKey] = content;
        } catch {
          // The final backend parse will surface protocol errors.
        }
      }
      this.pendingKey = null;
      this.valueStart = -1;
      return;
    }
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

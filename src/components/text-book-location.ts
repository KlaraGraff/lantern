export type TextBookBlockKind = "heading" | "paragraph";

export interface TextBookSourceSpan {
  rendered_start: number;
  source_start: number;
  length: number;
}

export interface TextBookBlock {
  kind: TextBookBlockKind;
  text: string;
  source_start: number;
  source_end: number;
  source_spans: TextBookSourceSpan[];
  depth?: number;
  starts_page?: boolean;
}

export interface TextBookChunk {
  blocks: TextBookBlock[];
}

export interface TextBookTocEntry {
  title: string;
  depth: number;
  source_offset: number;
}

export interface TextBookDocument {
  version: number;
  source_sha256: string | null;
  coordinate_space: "normalized_utf16";
  chunks: TextBookChunk[];
  toc: TextBookTocEntry[];
}

export interface AbsoluteTextLocation {
  version: 2;
  start: number;
  end: number;
}

export function textLocation(start: number, end = start): string {
  return `textloc:v2:${start}:${end}`;
}

export function parseTextLocation(value: string | null | undefined): AbsoluteTextLocation | null {
  if (!value?.startsWith("textloc:v2:")) return null;
  const match = /^textloc:v2:(\d+):(\d+)$/.exec(value);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return null;
  return { version: 2, start, end };
}

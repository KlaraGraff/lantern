import type { CitedSource } from "../hooks/useAiChat.ts";

export type XrayScope = "safe" | "wholeBook";
export type XrayKind = "person" | "term" | "unknown";

export interface XrayCardResult {
  kind: XrayKind;
  title: string;
  subtitle: string;
  summary: string;
  facts: Array<{ label: string; value: string }>;
  relations: Array<{ name: string; description: string }>;
  relationPaths: Array<{ target: string; label: string; explanation: string }>;
  sources: CitedSource[];
  scope: XrayScope;
  progress: number;
}

export function xrayCacheKey(bookId: string, entity: string): string {
  return `${bookId}\u0000${entity.trim().toLocaleLowerCase()}`;
}

export function canReuseXrayCache(cachedLocation: string, currentLocation: string): boolean {
  return cachedLocation === currentLocation;
}

export function canApplyXrayLoad(
  activeGeneration: number,
  completedGeneration: number,
): boolean {
  return activeGeneration === completedGeneration;
}

/** Navigation callbacks must explicitly acknowledge a completed jump. */
export function didXrayNavigationSucceed(value: unknown): value is true {
  return value === true;
}

export function shouldOfferXrayUpdate(
  result: Pick<XrayCardResult, "scope" | "progress">,
  currentProgress: number,
): boolean {
  return result.scope === "safe" && currentProgress > result.progress;
}

export function isEmptyXrayResult(
  result: Pick<XrayCardResult, "kind" | "summary" | "facts" | "relations" | "relationPaths">,
): boolean {
  return result.kind === "unknown"
    && !result.summary.trim()
    && result.facts.length === 0
    && result.relations.length === 0
    && result.relationPaths.length === 0;
}

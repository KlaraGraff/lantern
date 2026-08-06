import type { CitedSource } from "../hooks/useAiChat.ts";
import { getAiErrorCode, type AiErrorCode } from "../utils/aiError.ts";

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

/**
 * Inserts a key into a Map with a bounded insertion-order LRU eviction: the
 * key is moved to the most-recently-used end, and the oldest entries are
 * dropped once the map exceeds `limit`. Maps preserve insertion order, so no
 * separate LRU data structure is needed.
 */
export function setBoundedCacheEntry<K, V>(cache: Map<K, V>, key: K, value: V, limit: number): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
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

export type XrayLoadErrorKind = "ai" | "indexBuilding" | "indexFailed" | "indexUnsupported" | "generic";

export interface XrayLoadErrorPresentation {
  kind: XrayLoadErrorKind;
  /** Set only when `kind` is "ai", so the caller can render the shared
   * `ai.*` copy (and settings/retry affordances) instead of duplicating it
   * under `readerXray.*`. */
  aiErrorCode: AiErrorCode | null;
}

/**
 * `ai_xray` fails for reasons that need different UI: a missing/disabled AI
 * provider (or a cooling-down key) needs a settings link, a still-building
 * index needs a wait-and-retry, a failed or unsupported index needs neither.
 * Collapsing all of these into one generic "try again later" message (as the
 * card used to) actively misleads whichever case isn't "the index wasn't
 * ready yet" — most visibly when no AI provider is configured at all, where
 * retrying can never help.
 */
export function classifyXrayLoadError(raw: string): XrayLoadErrorPresentation {
  const aiErrorCode = getAiErrorCode(raw);
  if (aiErrorCode) return { kind: "ai", aiErrorCode };
  if (raw.includes("XRAY_INDEX_BUILDING")) return { kind: "indexBuilding", aiErrorCode: null };
  if (raw.includes("XRAY_INDEX_FAILED")) return { kind: "indexFailed", aiErrorCode: null };
  if (raw.includes("XRAY_INDEX_UNSUPPORTED")) return { kind: "indexUnsupported", aiErrorCode: null };
  return { kind: "generic", aiErrorCode: null };
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

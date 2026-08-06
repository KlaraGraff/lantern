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

/**
 * Auto-retry cadence for the "index still building" state: poll every 5s,
 * capped at 12 attempts (60s total). Long enough to ride out most mid-size
 * book indexing runs without the user having to notice and click retry
 * themselves; short enough that a genuinely stalled index falls back to the
 * existing manual retry affordance instead of polling forever.
 */
export const XRAY_INDEX_BUILDING_POLL_INTERVAL_MS = 5000;
export const XRAY_INDEX_BUILDING_POLL_MAX_ATTEMPTS = 12;

/**
 * Whether the "index still building" auto-retry loop should schedule another
 * attempt. Polling only makes sense while the classification stays
 * `indexBuilding` — a different kind (including no error at all, meaning the
 * load just succeeded) means the situation changed and the loop must stop
 * rather than plowing ahead with a stale reason. The attempt cap exists so a
 * genuinely stalled index doesn't poll forever.
 */
export function shouldContinueXrayIndexBuildingPoll(
  kind: XrayLoadErrorKind | null,
  attemptsSoFar: number,
): boolean {
  return kind === "indexBuilding" && attemptsSoFar < XRAY_INDEX_BUILDING_POLL_MAX_ATTEMPTS;
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

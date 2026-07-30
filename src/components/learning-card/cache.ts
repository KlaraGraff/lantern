import type { CardKindConfig, LearningCardKind, LearningCardResult } from "./types";

interface CachedLearningCard extends LearningCardResult {
  cacheSignature?: string;
}

// Bump when the learning-card prompt changes, so cards written by the old
// prompt stop being reused.
const CACHE_REVISION = 2;

/**
 * Everything that changes what the model is asked for. A stored card is only
 * reusable when the card design that produced it still matches today's.
 */
export function learningCardCacheSignature(card: CardKindConfig): string {
  const modules = card.modules
    .filter((module) => module.enabled)
    .map((module) => `${module.id}:${module.density}`)
    .sort()
    .join(",");
  const customModules = Object.entries(card.customModules)
    .map(([id, definition]) => `${id}:${definition?.updatedAt ?? 0}`)
    .sort()
    .join(",");
  return [
    CACHE_REVISION,
    card.defaultDensity,
    card.exampleCount,
    card.keyTermCount,
    modules,
    customModules,
  ].join("|");
}

export function cachedLearningCardResult(
  resultJson: string | null | undefined,
  kind: LearningCardKind,
  signature: string,
): LearningCardResult | null {
  if (!resultJson) return null;
  let parsed: CachedLearningCard;
  try {
    parsed = JSON.parse(resultJson) as CachedLearningCard;
  } catch {
    return null;
  }
  if (parsed?.cacheSignature !== signature || parsed.kind !== kind) return null;
  return parsed.modules && Object.keys(parsed.modules).length > 0 ? parsed : null;
}

export function learningCardCacheEnvelope(
  result: LearningCardResult,
  signature: string,
): string {
  const envelope: CachedLearningCard = { ...result, cacheSignature: signature };
  return JSON.stringify(envelope);
}

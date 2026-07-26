/**
 * Find the assistant turn immediately before the latest user turn.
 *
 * Scope metadata belongs to the adjacent turn. Looking farther back when the
 * adjacent assistant has no metadata can silently apply an unrelated scope.
 */
export function previousAssistantBeforeLatestUser<
  T extends { role: "user" | "assistant" },
>(messages: readonly T[]): T | undefined {
  let latestUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") {
      latestUserIndex = index;
      break;
    }
  }
  if (latestUserIndex <= 0) return undefined;
  const candidate = messages[latestUserIndex - 1];
  return candidate?.role === "assistant" ? candidate : undefined;
}

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

export interface PassageRoutingPreferences {
  newPassageStartsNewChat: boolean;
  newPassageStartsNewChatWhileOpen: boolean;
}

export type PassageRoute = "current" | "new" | "resume";

/**
 * Chooses a conversation for one externally quoted book range. Text is not an
 * input: two identical words at different locations must never share a route.
 */
export function passageRoute(
  panelWasActive: boolean,
  currentChatId: string | null,
  matchedChatId: string | undefined,
  preferences: PassageRoutingPreferences,
): PassageRoute {
  if (matchedChatId) {
    return matchedChatId === currentChatId ? "current" : "resume";
  }
  if (!preferences.newPassageStartsNewChat) return "current";
  if (panelWasActive && !preferences.newPassageStartsNewChatWhileOpen) return "current";
  return "new";
}

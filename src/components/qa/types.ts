import type { ChatSummary } from "../../hooks/useChats";
import type { Explanation } from "../../hooks/useExplanations";

/**
 * "对话" and "解释" are the same idea at two lengths — a question about a
 * passage, answered once or answered over several turns — but the two
 * backend rows are not shape-compatible: `ChatSummary` is a multi-turn
 * thread (`title` / `message_count` / `last_message`, no anchored passage);
 * `Explanation` is a single answer pinned to one CFI (`passage` / `cfi` /
 * `context_sentence`, no thread). The only fields both carry are
 * `id` / `book_id` / `model` / `created_at` / `updated_at`.
 *
 * This discriminated union is what lets one sorted timeline hold both
 * without losing either shape — the renderer switches on `kind` and reads
 * the original record off `chat` / `explanation` for anything type-specific.
 */
export interface QaEntryBase {
  id: string;
  book_id: string;
  model: string | null;
  created_at: number;
  updated_at: number;
}

export interface ChatQaEntry extends QaEntryBase {
  kind: "chat";
  chat: ChatSummary;
}

export interface ExplanationQaEntry extends QaEntryBase {
  kind: "explanation";
  explanation: Explanation;
}

export type QaEntry = ChatQaEntry | ExplanationQaEntry;

export function toChatEntry(chat: ChatSummary): ChatQaEntry {
  return {
    kind: "chat",
    id: chat.id,
    book_id: chat.book_id,
    model: chat.model,
    created_at: chat.created_at,
    updated_at: chat.updated_at,
    chat,
  };
}

export function toExplanationEntry(explanation: Explanation): ExplanationQaEntry {
  return {
    kind: "explanation",
    id: explanation.id,
    book_id: explanation.book_id,
    model: explanation.model,
    created_at: explanation.created_at,
    updated_at: explanation.updated_at,
    explanation,
  };
}

/** A thread only earns the "继续问了 N 轮" line once there's a real second
 * round to point at — a lone Q+A reads the same as a saved explanation. */
export function chatRounds(chat: ChatSummary): number {
  return Math.max(1, Math.ceil((chat.message_count ?? 0) / 2));
}

export function isMultiRoundChat(chat: ChatSummary): boolean {
  return (chat.message_count ?? 0) > 2;
}

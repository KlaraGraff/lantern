import type { LearningCardKind } from "./types.ts";

/**
 * The receipt line (design §12). It names only what the request in
 * `ai_learning_card` actually carries: the selection and its context, the book
 * and chapter titles when there is a book, the level settings, and — for a
 * word — any record of looking it up before. A cached answer sent nothing this
 * time, and says so.
 */
export interface LearningCardReceipt {
  model?: string | null;
  cached: boolean;
  withBook: boolean;
}

/** The i18n keys the line is made of, in order, and the model to lead with. */
export function receiptParts(receipt: LearningCardReceipt, kind: LearningCardKind): { model: string | null; keys: string[] } {
  if (receipt.cached) return { model: null, keys: ["learningCard.receipt.cached"] };
  const keys = [receipt.withBook ? "learningCard.receipt.sent" : "learningCard.receipt.sentBookless"];
  if (kind === "word") keys.push("learningCard.receipt.wordMemory");
  return { model: receipt.model || null, keys };
}

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

/** Breathing room above a pinned question — matches the list's top padding,
 *  so a question that already sits at the top does not shift when pinned. */
const PIN_TOP_GAP = 16;

/**
 * Scroll behaviour for a streaming chat transcript.
 *
 * Following the bottom means every streamed token drags the text the reader is
 * looking at upwards. Instead this pins the newest question to the top of the
 * view once — on send, and when a chat is opened — and reserves a screenful
 * below it for the answer to grow into. The reservation shrinks by exactly what
 * the answer gains, so the scrollable height stays put and nothing moves while
 * the answer streams; past a screenful the answer simply continues below the
 * fold, where the reader reaches it in their own time.
 *
 * Wire the returned refs to: the scroll container, the message list (the spacer
 * must sit outside it, or the reservation feeds on itself), the element holding
 * the message at `lastQuestionIndex`, and a trailing spacer element.
 */
export function usePinnedQuestionScroll(
  chatId: string | null | undefined,
  messages: readonly { role: string }[],
) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const questionAnchorRef = useRef<HTMLDivElement>(null);
  const tailSpacerRef = useRef<HTMLDivElement>(null);
  const pinQuestionRef = useRef(true);

  const lastQuestionIndex = messages.reduce(
    (found, message, index) => (message.role === "user" ? index : found),
    -1,
  );

  /** Call when sending: the question being asked becomes the pinned one. */
  const pinLatestQuestion = useCallback(() => {
    pinQuestionRef.current = true;
  }, []);

  // Opening a chat starts the reader at its newest question.
  useEffect(() => {
    pinQuestionRef.current = true;
  }, [chatId]);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const list = listRef.current;
    const spacer = tailSpacerRef.current;
    const anchor = questionAnchorRef.current;
    if (!scroller || !list || !spacer) return;
    const anchorTop = anchor?.getBoundingClientRect().top;
    const reserved = anchorTop === undefined
      ? 0
      : Math.max(0, Math.round(scroller.clientHeight - PIN_TOP_GAP - (list.getBoundingClientRect().bottom - anchorTop)));
    spacer.style.height = `${reserved}px`;
    // Left armed until a question exists to pin — a chat's messages arrive
    // after the chat id changes, and a fresh chat has nothing to pin at all.
    if (pinQuestionRef.current && anchor) {
      pinQuestionRef.current = false;
      scroller.scrollTop += anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top - PIN_TOP_GAP;
    }
  }, [messages, chatId]);

  return { scrollerRef, listRef, questionAnchorRef, tailSpacerRef, lastQuestionIndex, pinLatestQuestion };
}

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefCallback,
} from "react";

import {
  EdgeBackGestureController,
  EDGE_BACK_SETTLE_MS,
  type EdgeBackGestureState,
} from "./edge-back-gesture";

export interface UseEdgeSwipeBackOptions {
  /**
   * Off outside the narrow, touch layout this gesture belongs to. Left to the
   * caller rather than decided in here — `useIsNarrow` is a page-level
   * question and this hook has no opinion on what "narrow" means, only on
   * what a claimed drag does.
   */
  enabled: boolean;
  /**
   * Fired once the slide-out has visually finished, not the instant the
   * finger lifts. Swapping the route out from under a card that is still
   * mid-slide would read as a jump cut instead of a dismissal.
   */
  onBack: () => void;
}

export interface UseEdgeSwipeBackResult<T extends HTMLElement> {
  /** Attach to the page's own root element — the transform and the pointer
   *  handlers both live there, not on `window`, so a modal portaled above the
   *  router (see SettingsHost) never sees these touches in the first place.
   *  A callback ref, not a ref object: the page may mount this element on a
   *  later render than the hook's first run (BookDetails commits a bare
   *  placeholder until the book loads), and only a state-backed callback ref
   *  re-runs the wiring effect when the element finally appears. */
  ref: RefCallback<T>;
  pointerHandlers: {
    onPointerDown: (event: ReactPointerEvent<T>) => void;
    onPointerMove: (event: ReactPointerEvent<T>) => void;
    onPointerUp: (event: ReactPointerEvent<T>) => void;
    onPointerCancel: (event: ReactPointerEvent<T>) => void;
    onLostPointerCapture: (event: ReactPointerEvent<T>) => void;
  };
}

/**
 * The same faint left-edge shadow SettingsModal's slide-in panel casts
 * (`shadow-[-12px_0_30px_rgba(0,0,0,0.12)]`), written by hand instead of as a
 * Tailwind class because it has to switch on and off every frame of the drag,
 * and a className toggle would mean a re-render per pointermove.
 */
const DRAG_SHADOW = "-12px 0 30px rgba(0,0,0,0.12)";

/**
 * Wires `EdgeBackGestureController` to one page element: the pointer handlers
 * go on it, and so does the live transform. The split — and the "read
 * `fractionRef` off a subscription, write straight to `style`" wiring — is
 * copied from `useDrawerGesture` plus Home.tsx's paint effect, because that
 * is the proven answer in this codebase to a gesture that must track a finger
 * at 60fps on a phone: a `setState` per pointermove would re-render the whole
 * page underneath the drag that is the reason this hook exists.
 */
export function useEdgeSwipeBack<T extends HTMLElement>({
  enabled,
  onBack,
}: UseEdgeSwipeBackOptions): UseEdgeSwipeBackResult<T> {
  // The page element is tracked twice on purpose. Its arrival must re-run the
  // wiring effect below — BookDetails renders a placeholder until the book has
  // loaded, so on the hook's first run there is no element yet, and a plain
  // ref mutation on a later render never wakes an effect — which is what the
  // state copy is for. But the effect writes to the element's `style`, and
  // mutating a state-held value is exactly what the immutability rule
  // forbids, so the writes go through the ref copy instead.
  const pageRef = useRef<T | null>(null);
  const [pageNode, setPageNode] = useState<T | null>(null);
  // The gesture never measures the DOM itself, so the travel distance is read
  // here and cached: reading `offsetWidth` inside a pointermove would force a
  // synchronous layout on every frame of the drag.
  const travelRef = useRef(1);
  const onBackRef = useRef(onBack);
  const settleTimerRef = useRef<number | null>(null);
  // Set by the wiring effect; lets the pointerdown handler (a stable memo
  // that cannot see the effect's `node`) force a pending back to finish
  // before a new gesture registers with the controller.
  const flushSettleRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    onBackRef.current = onBack;
  }, [onBack]);

  // The constructor gets a placeholder — anything reading `travelRef.current`
  // here, even through a named closure, is a ref read reachable from render
  // (`useState`'s initializer runs synchronously during render), which the
  // ref lint rule rejects outright. `configure()` below hands over the real
  // closure from inside an effect instead, the same deferral
  // `useDrawerGesture` uses to let a re-rendered component pass in fresh
  // closures without constructing a new controller.
  const [controller] = useState(() => new EdgeBackGestureController({ width: () => 1 }));

  useLayoutEffect(() => {
    // `pageNode` gates and re-arms the effect; the same element is read back
    // out of the ref for the style writes below.
    if (!enabled || pageNode === null) return;
    const node = pageRef.current;
    if (node === null) return;

    controller.configure({ width: () => travelRef.current });

    const measure = () => {
      travelRef.current = node.offsetWidth || window.innerWidth || 1;
    };
    const paint = (state: EdgeBackGestureState) => {
      const offset = state.fraction * travelRef.current;
      node.style.transition = state.dragging
        ? "none"
        : `transform ${EDGE_BACK_SETTLE_MS}ms ease-out, box-shadow ${EDGE_BACK_SETTLE_MS}ms ease-out`;
      node.style.transform = offset > 0 ? `translate3d(${offset}px, 0, 0)` : "";
      // Only present while there is something to cast it onto — at rest the
      // shadow would bleed to negative x with nothing there to clip it, which
      // on a page flush against the viewport edge means unwanted horizontal
      // overflow rather than an invisible shadow.
      node.style.boxShadow = offset > 0 ? DRAG_SHADOW : "";
    };

    measure();
    paint(controller.getState());
    const unsubscribeFrame = controller.subscribe(paint);
    // The visual slide is CSS's job; this only decides when the route is
    // allowed to change under it. `onBack` fires after the same duration the
    // transition above animates over, so the card is fully off-screen — not
    // mid-slide — by the time BookDetails unmounts.
    const finishSettledBack = () => {
      settleTimerRef.current = null;
      onBackRef.current();
      // "Back" does not always unmount this element: the settings surfaces
      // pop one level and keep the same node, which would otherwise stay
      // parked at fraction 1, fully off-screen. Rewinding in the same task
      // as onBack means React flushes the level change before the next
      // paint, so the parent level appears at rest with no visible snap —
      // and on a page that does unmount, these writes land on a node that
      // is already gone.
      controller.cancel();
      node.style.transition = "";
      node.style.transform = "";
      node.style.boxShadow = "";
    };
    const unsubscribeSettled = controller.subscribeSettled((outcome) => {
      if (outcome !== "back") return;
      settleTimerRef.current = window.setTimeout(finishSettledBack, EDGE_BACK_SETTLE_MS);
    });
    // A second swipe can begin inside the settle window on a surface that
    // stays mounted (the settings levels, a reader panel closing into
    // another). Left pending, the timer's `cancel()` would fire after that
    // gesture's pointerdown and null its claim on the controller, eating the
    // swipe — so the pointerdown handler runs the pending back first.
    flushSettleRef.current = () => {
      if (settleTimerRef.current === null) return;
      window.clearTimeout(settleTimerRef.current);
      finishSettledBack();
    };
    window.addEventListener("resize", measure);

    return () => {
      unsubscribeFrame();
      unsubscribeSettled();
      flushSettleRef.current = null;
      window.removeEventListener("resize", measure);
      if (settleTimerRef.current !== null) {
        window.clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
      }
      // Drop any gesture in flight, not just its visuals. Without this, a
      // disable mid-drag leaves the controller's fraction where the finger
      // was, and the next enable's `paint(getState())` above would restore a
      // page frozen half off-screen.
      controller.cancel();
      node.style.transition = "";
      node.style.transform = "";
      node.style.boxShadow = "";
    };
  }, [enabled, controller, pageNode]);

  const pointerHandlers = useMemo(
    () => ({
      onPointerDown: (event: ReactPointerEvent<T>) => {
        // Touch only — a mouse drag from the edge is a text selection or a
        // window-manager gesture on every platform this app ships to, and
        // `enabled` already keeps this off the wide layout.
        if (!enabled || event.pointerType !== "touch") return;
        // A back that settled but hasn't fired yet finishes now, so this
        // touch starts on the surface the back reveals instead of the one
        // sliding away — and so the pending cleanup can't null this
        // gesture's controller claim from under it.
        flushSettleRef.current?.();
        // A touch that starts on a control that owns horizontal drags itself
        // stays that control's gesture even inside the edge zone — a range
        // slider's thumb parked at its minimum sits within 20px of the left
        // edge, and claiming that drag would slide the page while the finger
        // is setting a value.
        if ((event.target as Element | null)?.closest?.("input, textarea, select, [contenteditable]")) return;
        controller.pointerDown({ pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY });
      },
      // The `enabled` guard is on all five handlers, not just the entry
      // point: a disable mid-drag (a modal opening under the finger) swaps
      // in these guarded closures, and the rest of that gesture's events
      // must fall through to the modal's world rather than keep steering a
      // controller whose cleanup has already cancelled the drag.
      onPointerMove: (event: ReactPointerEvent<T>) => {
        if (!enabled) return;
        controller.pointerMove({ pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY });
        // Capture only once the direction lock has opened. Capturing on
        // pointerdown would retarget the following `click` to this element,
        // and every button on the page would go dead for that tap.
        if (controller.getState().dragging && !event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.setPointerCapture(event.pointerId);
        }
      },
      onPointerUp: (event: ReactPointerEvent<T>) => {
        if (!enabled) return;
        controller.pointerUp({ pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY });
      },
      onPointerCancel: (event: ReactPointerEvent<T>) => {
        if (!enabled) return;
        controller.pointerCancel({ pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY });
      },
      onLostPointerCapture: (event: ReactPointerEvent<T>) => {
        if (!enabled) return;
        // A touch pointer is implicitly captured by the child under the
        // finger, so claiming the drag (`setPointerCapture` in the move
        // handler above) makes that child fire a `lostpointercapture` that
        // bubbles up here. That event is the capture arriving, not leaving —
        // treating it as a cancel is what would kill every drag two frames
        // in, since a full page's touches always start on a descendant. Only
        // this element itself losing capture means the gesture was taken.
        if (event.target !== event.currentTarget) return;
        controller.pointerCancel({ pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY });
      },
    }),
    [enabled, controller],
  );

  const attachPage = useCallback<RefCallback<T>>((node) => {
    pageRef.current = node;
    setPageNode(node);
  }, []);

  return { ref: attachPage, pointerHandlers };
}

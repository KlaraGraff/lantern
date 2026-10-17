import { useCallback, useEffect, useRef, useState } from "react";
import { CHROME_SHOWN, chromeFade } from "./chrome-fade.ts";

/**
 * The top bar's fade on a wide screen (`chrome-fade.ts`). `held` keeps it up
 * whatever the count; `noteTurn` goes in the page-turn path, and the pointer
 * handlers go on a wrapper around the bar — the bar itself is `inert` while
 * faded, so pointer events fall through to whatever is under it.
 */
export function useChromeFade(held: boolean) {
  const [state, setState] = useState(CHROME_SHOWN);
  const heldRef = useRef(held);
  useEffect(() => {
    heldRef.current = held;
  }, [held]);
  const hoverRef = useRef(false);

  const noteTurn = useCallback(() => {
    setState((current) => chromeFade(current, "turn", heldRef.current || hoverRef.current));
  }, []);
  const wake = useCallback(() => {
    setState((current) => chromeFade(current, "wake", true));
  }, []);
  const onPointerEnter = useCallback(() => {
    hoverRef.current = true;
    wake();
  }, [wake]);
  const onPointerLeave = useCallback(() => {
    hoverRef.current = false;
  }, []);

  return {
    faded: state.faded && !held,
    noteTurn,
    hoverHandlers: { onPointerEnter, onPointerMove: wake, onPointerLeave },
  };
}

import { useEffect, useState } from "react";

/**
 * True while `open`, and for `ms` after it turns false: how long a card that
 * is closing keeps its content, so it slides away full rather than as an
 * empty frame.
 */
export function useLingering(open: boolean, ms: number): boolean {
  const [lingering, setLingering] = useState(open);
  useEffect(() => {
    if (open) {
      setLingering(true);
      return;
    }
    const timer = window.setTimeout(() => setLingering(false), ms);
    return () => window.clearTimeout(timer);
  }, [open, ms]);
  return open || lingering;
}

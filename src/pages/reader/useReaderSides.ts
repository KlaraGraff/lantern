import { useCallback, useEffect, useMemo, useState, type SetStateAction } from "react";
import type { SidePanel } from "./side-panel";
import type { ReaderPanelState } from "./narrow-panels";
import {
  INITIAL_SIDES,
  dismissFloat,
  endPeek,
  legacyPanels,
  peekLeft,
  togglePin,
  withLegacy,
  type ReaderSides,
  type SidePins,
} from "./reader-sides";

/**
 * Which sides open pinned. A layout preference of this screen, not of the
 * library, so it stays on the device rather than in the synced settings.
 */
const PINS_KEY = "reader-side-pins";

function readPins(): SidePins {
  try {
    const parsed = JSON.parse(localStorage.getItem(PINS_KEY) ?? "null") as Partial<SidePins> | null;
    return { left: parsed?.left === true, right: parsed?.right === true };
  } catch {
    return { left: false, right: false };
  }
}

function writePins(pins: SidePins): void {
  try {
    localStorage.setItem(PINS_KEY, JSON.stringify(pins));
  } catch { /* a convenience; losing it means the next card opens floating */ }
}

function resolve<T>(value: SetStateAction<T>, previous: T): T {
  return typeof value === "function" ? (value as (previous: T) => T)(previous) : value;
}

interface SidesState {
  sides: ReaderSides;
  pins: SidePins;
}

function sidesUpdate(state: SidesState, sides: ReaderSides): SidesState {
  return sides === state.sides ? state : { ...state, sides };
}

/**
 * The reader's two sides (`reader-sides.ts`), with setters in the old
 * vocabulary so the code that opens and closes panels keeps working unchanged.
 * Every setter has one identity for the life of the reader, as the `useState`
 * setters it replaces did; the reader threads them into memoized callbacks.
 */
export function useReaderSides() {
  const [state, setState] = useState<SidesState>(() => ({ sides: INITIAL_SIDES, pins: readPins() }));
  const { sides, pins } = state;

  useEffect(() => { writePins(pins); }, [pins]);

  const legacy = useMemo(() => legacyPanels(sides), [sides]);

  const write = useCallback((patch: (previous: ReaderPanelState) => Partial<ReaderPanelState>) => {
    setState((previous) => sidesUpdate(
      previous,
      withLegacy(previous.sides, patch(legacyPanels(previous.sides)), previous.pins),
    ));
  }, []);

  const setTocOpen = useCallback((value: SetStateAction<boolean>) => {
    write((previous) => ({ tocOpen: resolve(value, previous.tocOpen) }));
  }, [write]);
  const setSearchOpen = useCallback((value: SetStateAction<boolean>) => {
    write((previous) => ({ searchOpen: resolve(value, previous.searchOpen) }));
  }, [write]);
  const setSidePanel = useCallback((value: SetStateAction<SidePanel>) => {
    write((previous) => ({ sidePanel: resolve(value, previous.sidePanel) }));
  }, [write]);

  const peek = useCallback(() => setState((previous) => sidesUpdate(previous, peekLeft(previous.sides))), []);
  const unpeek = useCallback(() => setState((previous) => sidesUpdate(previous, endPeek(previous.sides))), []);
  const dismissFloating = useCallback((which: keyof ReaderSides) => {
    setState((previous) => sidesUpdate(previous, dismissFloat(previous.sides, which)));
  }, []);

  /** The pin button. Remembers the choice, so the side opens the same way next time. */
  const pin = useCallback((which: keyof ReaderSides) => {
    setState((previous) => {
      const next = togglePin(previous.sides, which);
      if (next === previous.sides) return previous;
      return { sides: next, pins: { ...previous.pins, [which]: next[which].mode === "pinned" } };
    });
  }, []);

  return {
    sides,
    ...legacy,
    setTocOpen,
    setSearchOpen,
    setSidePanel,
    peek,
    unpeek,
    dismissFloating,
    pin,
  };
}

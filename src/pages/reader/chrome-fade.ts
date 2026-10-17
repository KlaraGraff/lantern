/**
 * The reader's top bar steps back once reading has started (design §12): two
 * page turns in a row and it fades, staying in flow so nothing reflows. A
 * pointer over it brings it back and starts the count again.
 */
export interface ChromeFade {
  turns: number;
  faded: boolean;
}

export const CHROME_FADE_TURNS = 2;

export const CHROME_SHOWN: ChromeFade = { turns: 0, faded: false };

/**
 * `held` is anything that keeps the bar up — a pointer resting on it, a
 * floating card, the settings it anchors. A turn taken while held does not
 * count toward fading.
 */
export function chromeFade(state: ChromeFade, event: "turn" | "wake", held: boolean): ChromeFade {
  if (event === "wake" || held) return state.turns === 0 && !state.faded ? state : CHROME_SHOWN;
  const turns = state.turns + 1;
  return { turns, faded: turns >= CHROME_FADE_TURNS };
}

/**
 * The five frequency bands of the bundled word list, plus the sixth bucket for
 * words the table has never heard of.
 *
 * The rank boundaries mirror `src-tauri/src/word_frequency/mod.rs` — the same
 * 50 000-word table produces both — and exist here only so a band can be
 * labelled ("ranks 1 001–3 000") without a round trip. The counts themselves
 * always come from the backend.
 *
 * The sixth bucket is deliberately not band 5. A novel's recurring character
 * names and a genuinely rare word are different things to a reader, and
 * folding them together makes every novel look harder than it is.
 */
export interface FrequencyBand {
  band: 1 | 2 | 3 | 4 | 5;
  /** Key into the backend's `BookDifficulty` row. */
  field: "band1" | "band2" | "band3" | "band4" | "band5";
  from: number;
  /** `null` on band 5: everything past 20 000 is one band. */
  to: number | null;
  /** CSS custom property, so light and dark are one declaration each. */
  color: string;
}

export const FREQUENCY_BANDS: readonly FrequencyBand[] = [
  { band: 1, field: "band1", from: 1, to: 1000, color: "var(--color-band-1)" },
  { band: 2, field: "band2", from: 1001, to: 3000, color: "var(--color-band-2)" },
  { band: 3, field: "band3", from: 3001, to: 5000, color: "var(--color-band-3)" },
  { band: 4, field: "band4", from: 5001, to: 20000, color: "var(--color-band-4)" },
  { band: 5, field: "band5", from: 20001, to: null, color: "var(--color-band-5)" },
];

export const UNLISTED_BAND_COLOR = "var(--color-band-unlisted)";

/**
 * The two bands the difficulty verdict is read from. Band 3 is where a reader
 * starts needing the dictionary occasionally; 4 and 5 are where a book stops
 * being comfortable, and that is the difference a verdict is about.
 */
export const HARD_BANDS: readonly ("band4" | "band5")[] = ["band4", "band5"];

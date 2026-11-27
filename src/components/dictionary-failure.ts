/** Why a lookup came back empty, when the reason changes what the card says. */
export type DictionaryFailure = "offline" | "offline_missing" | null;

/** Device-local: set once the reader says no to the offline-dictionary offer. */
export const OFFLINE_PROMPT_DISMISSED_KEY = "offline_dictionary_prompt_dismissed";
/** The ECDICT download, as the offer quotes it. */
export const OFFLINE_DICTIONARY_DOWNLOAD_MB = 63;

export function dictionaryFailureOf(error: unknown): DictionaryFailure {
  const code = String(error);
  if (code.includes("DICTIONARY_OFFLINE_MISSING")) return "offline_missing";
  if (code.includes("DICTIONARY_UNAVAILABLE")) return "offline";
  return null;
}

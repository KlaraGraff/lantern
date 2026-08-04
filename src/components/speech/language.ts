/** Resolves the sentence language without trusting one root-level EPUB tag. */
export function speechLanguage(language: string | undefined, text: string) {
  let declared: string | undefined;
  if (language) {
    try {
      declared = new Intl.Locale(language).language;
    } catch {
      // Fall through to script detection.
    }
  }
  if (declared && declared !== "en" && declared !== "zh") return declared;
  const han = text.match(/\p{Script=Han}/gu)?.length ?? 0;
  const latin = text.match(/\p{Script=Latin}/gu)?.length ?? 0;
  if (han > latin) return "zh";
  if (latin > han) return "en";
  return declared ?? (han > 0 ? "zh" : "en");
}

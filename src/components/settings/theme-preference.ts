/**
 * The theme choice, in the one form two surfaces need it.
 *
 * 外观 is a section with exactly one control, which is why the mobile root list
 * raises it as a bottom sheet instead of pushing a level for it — and why the
 * three options and the DOM class they toggle have to live somewhere neither
 * surface owns.
 */

export const THEME_PREFERENCES = ["system", "light", "dark"] as const;

export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export const THEME_PREFERENCE_LABEL_KEYS: Record<ThemePreference, string> = {
  system: "settings.appearance.system",
  light: "settings.appearance.light",
  dark: "settings.appearance.dark",
};

export function isThemePreference(value: string | undefined): value is ThemePreference {
  return THEME_PREFERENCES.includes(value as ThemePreference);
}

/** Whatever is stored, read as one of the three. Anything else is 跟随系统. */
export function themePreferenceOf(value: string | undefined): ThemePreference {
  return isThemePreference(value) ? value : "system";
}

/** Put the choice on the document. `system` re-reads the OS every time. */
export function applyThemePreference(value: string): void {
  const root = document.documentElement;
  if (value === "dark") root.classList.add("dark");
  else if (value === "light") root.classList.remove("dark");
  else root.classList.toggle("dark", window.matchMedia("(prefers-color-scheme: dark)").matches);
}

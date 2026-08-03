export type PresetDeleteKind = "builtin" | "custom";
export type PresetSurface = "card" | "menu" | "sources";

export interface PresetDeleteConfirmation {
  titleKey: string;
  descriptionKeys: string[];
  nameParam?: string;
}

const LAST_ITEM_KEY: Record<PresetSurface, string> = {
  card: "settings.presets.deleteLastCard",
  menu: "settings.presets.deleteLastMenu",
  sources: "settings.presets.deleteLastSources",
};

/**
 * What a delete has to warn about, if anything. `null` means delete on the spot.
 *
 * Removing a built-in is reversible — "restore defaults" hands it straight back —
 * so wrapping every one of them in a dialog would turn ordinary list editing into
 * a two-click chore and teach the user to dismiss the dialog unread, right up to
 * the one time it mattered. Only two outcomes are worth stopping for: the list
 * going empty, which changes what the reader sees, and losing a prompt the user
 * wrote, which no restore can undo.
 */
export function presetDeleteConfirm(
  kind: PresetDeleteKind,
  isLast: boolean,
  surface: PresetSurface,
  name?: string,
): PresetDeleteConfirmation | null {
  if (kind === "builtin" && !isLast) return null;
  const descriptionKeys = [
    ...(kind === "custom" ? ["settings.presets.deleteCustomWarning"] : []),
    ...(isLast ? [LAST_ITEM_KEY[surface]] : []),
  ];
  return isLast
    ? { titleKey: "settings.presets.deleteLastTitle", descriptionKeys }
    : { titleKey: "settings.presets.deleteTitle", descriptionKeys, nameParam: name };
}

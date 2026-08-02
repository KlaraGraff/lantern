export interface SettingsProps {
  settings: Record<string, string>;
  loading: boolean;
  refresh: () => Promise<void>;
  save: (key: string, value: string) => Promise<void>;
  saveBulk: (entries: Record<string, string>) => Promise<void>;
  showSavedToast: (msg?: string) => void;
}

export const ROW_CONTROL_WIDTH = "w-[180px] shrink-0";
export const ROW_CONTROL_WIDTH_COMPACT = "w-[96px] shrink-0";
// Card design panel: every row control matches the compact/standard/detailed
// segmented control, which needs ~194px for its English labels.
export const ROW_CONTROL_WIDTH_CARD = "w-[200px] shrink-0";

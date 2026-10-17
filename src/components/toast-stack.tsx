import { createContext, useContext, useState, type ReactNode } from "react";

const ToastStackContext = createContext<HTMLElement | null>(null);

/**
 * Where a `<Toast>` lands when it is not on its own: the library window's
 * bottom-right corner (design v2 §5, "同步、更新、提示，统一在右下角").
 *
 * One container rather than one position per toast, because two notices up at
 * once — an import finishing while an update downloads — would otherwise sit
 * on top of each other. Here they stack, newest on top.
 *
 * `enabled` is the caller's to decide. Off, the context is `null` and every
 * toast keeps the top-centre position it always had: a reader window (where
 * the corner belongs to the chat composer) and a phone (where the bottom edge
 * belongs to the home indicator).
 */
export function ToastStackProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const [stack, setStack] = useState<HTMLDivElement | null>(null);
  return (
    <ToastStackContext.Provider value={enabled ? stack : null}>
      {children}
      {enabled && (
        <div
          ref={setStack}
          className="pointer-events-none fixed bottom-5 right-5 z-[60] flex max-w-[calc(100vw-2.5rem)] flex-col-reverse items-end gap-2"
        />
      )}
    </ToastStackContext.Provider>
  );
}

export function useToastStack(): HTMLElement | null {
  return useContext(ToastStackContext);
}

/**
 * Mock of `@tauri-apps/api/webviewWindow`.
 *
 * The harness is a single page, so `new WebviewWindow(...)` records the request
 * instead of opening anything (`window.__HARNESS__.windowsOpened`). The sweep
 * visits `/reader/:id` by routing there directly, which is the same thing the
 * single-window platforms do — and it keeps a mis-click from spawning tabs.
 *
 * The current window is labelled `main` so `SettingsHost`, `McpApprovalDialog`,
 * `OnboardingCard` and `UpdateToast` all mount; those are a large slice of the
 * surface the sweep is meant to reach.
 */
import { emitTo, listen, once, type EventCallback, type UnlistenFn } from "./event";
import { harness } from "../state";

export interface WebviewWindowOptions {
  url?: string;
  title?: string;
  width?: number;
  height?: number;
  [key: string]: unknown;
}

const registry = new Map<string, WebviewWindow>();

export class WebviewWindow {
  readonly label: string;

  constructor(label: string, options?: WebviewWindowOptions) {
    this.label = label;
    if (options) {
      harness.windowsOpened.push({ label, url: options.url });
      console.info(`[harness] WebviewWindow requested: ${label} -> ${options.url ?? "(no url)"}`);
    }
    registry.set(label, this);
  }

  static getByLabel(label: string): Promise<WebviewWindow | null> {
    return Promise.resolve(registry.get(label) ?? null);
  }

  static getAll(): Promise<WebviewWindow[]> {
    return Promise.resolve([...registry.values()]);
  }

  static getCurrent(): WebviewWindow {
    return current;
  }

  listen<T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> {
    return listen(event, handler, { target: this.label });
  }

  once<T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> {
    return once(event, handler, { target: this.label });
  }

  emit(event: string, payload?: unknown): Promise<void> {
    return emitTo(this.label, event, payload);
  }

  emitTo(target: string, event: string, payload?: unknown): Promise<void> {
    return emitTo(target, event, payload);
  }

  async setFocus(): Promise<void> {}
  async show(): Promise<void> {}
  async hide(): Promise<void> {}
  async close(): Promise<void> {
    registry.delete(this.label);
  }
  async destroy(): Promise<void> {
    registry.delete(this.label);
  }
  async setTitle(): Promise<void> {}
  async setSize(): Promise<void> {}
  async setMinSize(): Promise<void> {}
  async setZoom(): Promise<void> {}
  async isVisible(): Promise<boolean> {
    return true;
  }
  async isFocused(): Promise<boolean> {
    return true;
  }
  async isMaximized(): Promise<boolean> {
    return false;
  }
  async isFullscreen(): Promise<boolean> {
    return false;
  }
  async innerSize(): Promise<{ width: number; height: number }> {
    return { width: window.innerWidth, height: window.innerHeight };
  }
  async outerSize(): Promise<{ width: number; height: number }> {
    return { width: window.innerWidth, height: window.innerHeight };
  }
  async scaleFactor(): Promise<number> {
    return window.devicePixelRatio || 1;
  }
  async onCloseRequested(): Promise<UnlistenFn> {
    return () => {};
  }
  async onResized(): Promise<UnlistenFn> {
    return () => {};
  }
  async onMoved(): Promise<UnlistenFn> {
    return () => {};
  }
  async onFocusChanged(): Promise<UnlistenFn> {
    return () => {};
  }
}

// Constructed without options so it is not recorded as an "opened window".
const current = new WebviewWindow("main");

export function getCurrentWebviewWindow(): WebviewWindow {
  return current;
}

export function getAllWebviewWindows(): Promise<WebviewWindow[]> {
  return WebviewWindow.getAll();
}

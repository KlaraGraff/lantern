/**
 * Mock of `@tauri-apps/api/webview`.
 *
 * Used for three things in the app: label-targeted `listen` (the settings-open
 * channel), `onDragDropEvent` (library drag-import), and `setZoom`. `setZoom`
 * resolves without doing anything — Chrome has no equivalent, and a CSS
 * transform here would distort every coordinate the sweep clicks at.
 */
import { listen, type EventCallback, type UnlistenFn } from "./event";
import { recordNative } from "../state";

export interface DragDropPayload {
  type: "over" | "drop" | "enter" | "leave";
  paths?: string[];
  position?: { x: number; y: number };
}

export class Webview {
  readonly label: string;

  constructor(label: string) {
    this.label = label;
  }

  listen<T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> {
    return listen(event, handler, { target: this.label });
  }

  async setZoom(factor: number): Promise<void> {
    recordNative(`webview.setZoom(${factor})`);
  }

  /** Kept live so the sweep can fire a synthetic drop if it ever wants one. */
  onDragDropEvent(handler: EventCallback<DragDropPayload>): Promise<UnlistenFn> {
    return listen<DragDropPayload>("tauri://drag-drop", handler);
  }

  async close(): Promise<void> {}
  async reparent(): Promise<void> {}
}

const current = new Webview("main");

export function getCurrentWebview(): Webview {
  return current;
}

export function getAllWebviews(): Promise<Webview[]> {
  return Promise.resolve([current]);
}

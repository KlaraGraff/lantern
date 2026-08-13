import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import "./index.css";
import "./i18n";
import { installReaderDiagnostics } from "./utils/readerDiagnostics";
import { installBuiltinFontFaces, installCjkFontFaces } from "./components/builtin-fonts";
import { applyAppZoom, readAppZoom } from "./services/app-zoom-window";
import { installFocusZoomGuard } from "./services/focus-zoom-guard";
import { installKeyboardViewport } from "./services/keyboard-viewport";

// Install global fault sinks before anything else runs. On macOS 12 / Safari
// 15.1 a missing runtime API can throw at module top-level or inside the PDF
// Worker, where no local try/catch sees it; this routes those to the app log.
installReaderDiagnostics();

// Before React mounts, so the first focusable thing the app renders is already
// covered — an autofocused field in a panel that opens on load would otherwise
// zoom the page before any listener existed. Inert off a coarse pointer.
installFocusZoomGuard();

// Also before React mounts: the shells read `--app-viewport-height` on their
// first paint, and a route that opens with a field already focused would
// otherwise lay itself out one keyboard too tall.
installKeyboardViewport();

// Polyfill Map.getOrInsertComputed for PDF.js v5.5+ (Stage 3 proposal, not yet in WebKit)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
if (!(Map.prototype as any).getOrInsertComputed) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Map.prototype as any).getOrInsertComputed = function (key: any, callbackFn: (key: any) => any) {
    if (this.has(key)) return this.get(key);
    const value = callbackFn(key);
    this.set(key, value);
    return value;
  };
}

// Declare the bundled reading fonts before React mounts, so the first paint of
// the reader and the settings preview already has the faces available.
installBuiltinFontFaces();
// The CJK half of every reading chain. `CJK_SERIF` / `CJK_SANS` name wrapper
// families, not the system faces directly, so without this declaration those
// names resolve to nothing and Chinese falls through to the generic keyword —
// in the .txt reader, the marker previews and the settings previews alike.
installCjkFontFaces();

// Apply cached theme synchronously before React mounts so the window doesn't
// flash light-mode on cold start. Reconciled with the DB in App.tsx.
const cachedTheme = localStorage.getItem("lantern-theme") ?? "system";
const prefersDark =
  cachedTheme === "dark" ||
  (cachedTheme === "system" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches);
if (prefersDark) document.documentElement.classList.add("dark");

// Same reason, for the window zoom: waiting for React would show one frame at
// 100% before the app jumped to the size the user actually chose.
applyAppZoom(readAppZoom());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {/* Last resort. The boundaries inside `App` contain a page or a panel and
        leave the rest usable; this one only exists so that a failure in the
        shell itself — router, providers, `App`'s own effects — is an error
        screen with a way out rather than an empty white window. */}
    <ErrorBoundary scope="app">
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);

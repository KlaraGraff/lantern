import { useEffect } from "react";
import { BrowserRouter, Routes, Route } from "react-router";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { listen } from "@tauri-apps/api/event";
import Home from "./pages/Home";
import Reader from "./pages/Reader";
import ReadingStatsRoute from "./pages/ReadingStatsRoute";
import AiRouteFallbackNotice from "./components/AiRouteFallbackNotice";
import ReasoningEffortNotice from "./components/ReasoningEffortNotice";
import SettingsHost from "./components/SettingsHost";
import McpApprovalDialog from "./components/McpApprovalDialog";
import OnboardingCard from "./components/onboarding/OnboardingCard";
import UpdateToast from "./components/UpdateToast";
import { reconcileLanguage } from "./i18n";
import { useAppZoom } from "./hooks/useAppZoom";
import { openReaderWindow } from "./utils/openReaderWindow";
import {
  installCustomFontFaces,
  loadCustomFonts,
  type CustomFontRecord,
} from "./components/custom-fonts";
import { loadEnhancedFontFace } from "./components/enhanced-fonts";

const isMainWindow = getCurrentWebviewWindow().label === "main";

function applyTheme(theme: string) {
  const root = document.documentElement;
  if (theme === "dark") {
    root.classList.add("dark");
  } else if (theme === "light") {
    root.classList.remove("dark");
  } else {
    const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    root.classList.toggle("dark", dark);
  }
}

export default function App() {
  useAppZoom();

  useEffect(() => {
    // The main window starts hidden. Reveal it before any potentially slow
    // backend initialization so a blocked settings query cannot leave the
    // application running without visible UI.
    if (isMainWindow) {
      invoke("app_ready").catch(() => {});
    }

    invoke<Record<string, string>>("get_all_settings")
      .then((settings) => {
        const theme = settings.theme ?? "system";
        applyTheme(theme);
        localStorage.setItem("lantern-theme", theme);
      })
      .catch(() => applyTheme("system"));

    // Reconcile the language we picked synchronously from localStorage with
    // the persisted DB value (and persist to the DB on first launch).
    reconcileLanguage();
    loadCustomFonts().catch((error) => console.error("Failed to load custom fonts:", error));
    loadEnhancedFontFace().catch(() => {});
    const unlistenFonts = listen<CustomFontRecord[]>("custom-fonts-changed", (event) => {
      installCustomFontFaces(event.payload);
    });
    const unlistenMcpOpen = isMainWindow
      ? listen<{ id?: string; cfi?: string | null }>("mcp:open-reader", (event) => {
        if (!event.payload.id) return;
        void openReaderWindow(event.payload.id, { cfi: event.payload.cfi ?? undefined });
      })
      : undefined;

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      if (!document.documentElement.dataset.themeOverride) {
        applyTheme("system");
      }
    };
    mq.addEventListener("change", handler);
    return () => {
      mq.removeEventListener("change", handler);
      unlistenFonts.then((stop) => stop()).catch(() => {});
      unlistenMcpOpen?.then((stop) => stop()).catch(() => {});
    };
  }, []);

  const content = (
    <>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/reader/:bookId" element={<Reader />} />
        <Route path="/reading-stats" element={<ReadingStatsRoute />} />
      </Routes>
      <ReasoningEffortNotice />
      <AiRouteFallbackNotice />
      {/* Settings belong to the window that owns the library, not to a page.
          A desktop reader window forwards to this one by label instead of
          mounting a second modal of its own. */}
      {isMainWindow && <SettingsHost />}
      {isMainWindow && <McpApprovalDialog />}
      {isMainWindow && <OnboardingCard />}
      {/* One window checks and one window announces. A reader window mounting
          its own copy would run a second check and stack a second toast. */}
      {isMainWindow && <UpdateToast />}
    </>
  );

  return (
    <BrowserRouter>
      {content}
    </BrowserRouter>
  );
}

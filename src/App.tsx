import { lazy, Suspense, useEffect } from "react";
import { BrowserRouter, Routes, Route, useLocation, useNavigate } from "react-router";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { listen } from "@tauri-apps/api/event";
import Home from "./pages/Home";
import AiRouteFallbackNotice from "./components/AiRouteFallbackNotice";
import ReasoningEffortNotice from "./components/ReasoningEffortNotice";
import SettingsHost from "./components/SettingsHost";
import ErrorBoundary from "./components/ErrorBoundary";
import BookOpenGateProvider from "./components/BookOpenGateProvider";
import McpApprovalDialog from "./components/McpApprovalDialog";
import OnboardingCard from "./components/onboarding/OnboardingCard";
import UpdateToast from "./components/UpdateToast";
import { UpdaterProvider } from "./hooks/useUpdater";
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

// Home is the first paint and stays eager. Reader is only reached by
// navigating there, so it ships as its own chunk — opening the shelf no
// longer pays to parse the reader, the AI chat markdown renderer, and
// drag-and-drop before a single book cover appears. Reading stats used to be
// a third lazy route; it is a same-page filter of Home now
// (docs/impls/sidebar-ia-options-mockup.html, option C), so it ships in
// Home's own chunk instead.
const Reader = lazy(() => import("./pages/Reader"));
const BookDetails = lazy(() => import("./pages/BookDetails"));
// 学习板块的三个全屏页（词卷 / 试卷 / 翻卡）同理只在导航到时才加载。
const Quiz = lazy(() => import("./pages/Quiz"));
const QuizPaper = lazy(() => import("./pages/QuizPaper"));
const FlashcardReview = lazy(() => import("./pages/FlashcardReview"));

// Chunks load from the local filesystem here, so this is normally on screen
// for less than a frame. It exists only so that frame is a plain rect in the
// destination page's own background rather than a flash of whatever sits
// behind the router — same colour each route already paints once it mounts.
const ReaderFallback = () => <div className="h-screen bg-bg-page" />;
const BookDetailsFallback = () => <div className="h-screen bg-bg-page" />;
const StudyPageFallback = () => <div className="h-screen bg-bg-page" />;

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

  return (
    <BrowserRouter>
      <AppContent />
    </BrowserRouter>
  );
}

/**
 * Everything under the router. Split out of `App` only so the page-level error
 * boundary can read the location it resets on — `useLocation` is unavailable
 * above `BrowserRouter`.
 */
function AppContent() {
  const location = useLocation();
  const navigate = useNavigate();

  return (
    // Wraps every route, not just Home: the card can be triggered from the
    // shelf (BookGrid/BookList) or from a book's own details page, and both
    // need to share the same session-dismiss list and undo toast rather than
    // each carrying a copy.
    <BookOpenGateProvider>
      {/* One page failing should cost that page, not the window. Keyed by the
          path, so navigating anywhere else clears the failure on its own — and
          "back to library" is therefore a real recovery, not a re-render of the
          same broken route. Everything below this line keeps rendering. */}
      <ErrorBoundary
        scope="page"
        resetKey={location.pathname}
        isMainWindow={isMainWindow}
        atHome={location.pathname === "/"}
        onGoHome={() => navigate("/")}
      >
        <Routes>
          <Route path="/" element={<Home />} />
          <Route
            path="/reader/:bookId"
            element={<Suspense fallback={<ReaderFallback />}><Reader /></Suspense>}
          />
          <Route
            path="/book/:id"
            element={<Suspense fallback={<BookDetailsFallback />}><BookDetails /></Suspense>}
          />
          <Route
            path="/quiz"
            element={<Suspense fallback={<StudyPageFallback />}><Quiz /></Suspense>}
          />
          <Route
            path="/quiz/paper/:paperId"
            element={<Suspense fallback={<StudyPageFallback />}><QuizPaper /></Suspense>}
          />
          <Route
            path="/flashcards"
            element={<Suspense fallback={<StudyPageFallback />}><FlashcardReview /></Suspense>}
          />
        </Routes>
      </ErrorBoundary>
      {/* Passive notices fail silently: a garnish that breaks should disappear,
          not seize the screen to announce itself. Same principle already
          applied to the footnote module — a garnish must never be able to stop
          a book from opening. The error still reaches the console and the
          on-disk log. */}
      <ErrorBoundary scope="silent">
        <ReasoningEffortNotice />
        <AiRouteFallbackNotice />
      </ErrorBoundary>
      {/* Wraps exactly the two surfaces that show an update — the toast and
          the Settings → About row — so they share one lifecycle instead of
          each running its own check. A download begun in Settings therefore
          survives closing the modal, progress and all. Inactive outside the
          main window: one window checks, one window announces. */}
      <UpdaterProvider active={isMainWindow}>
        {/* Settings belong to the window that owns the library, not to a page.
            A desktop reader window forwards to this one by label instead of
            mounting a second modal of its own. */}
        {isMainWindow && <SettingsHost />}
        {isMainWindow && <McpApprovalDialog />}
        {isMainWindow && <OnboardingCard />}
        {isMainWindow && (
          <ErrorBoundary scope="silent">
            <UpdateToast />
          </ErrorBoundary>
        )}
      </UpdaterProvider>
    </BookOpenGateProvider>
  );
}

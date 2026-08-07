import { Component, Fragment, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RotateCw } from "lucide-react";
import { useTranslation } from "react-i18next";

import Button from "./ui/Button";
import { getReaderDiagnosticReport, logReaderDiagnostic } from "../utils/readerDiagnostics";
import {
  boundaryDetailText,
  initialBoundaryState,
  planBoundaryFallback,
  reconcileBoundaryState,
  retriedBoundaryState,
  type BoundaryAction,
  type BoundaryScope,
  type BoundaryState,
} from "./error-boundary";

interface ErrorBoundaryProps {
  scope: BoundaryScope;
  children: ReactNode;
  /**
   * Changing this throws away the recorded failure and the retry budget. Pass
   * whatever identifies the content: the route path, the settings section.
   */
  resetKey?: unknown;
  isMainWindow?: boolean;
  atHome?: boolean;
  /** Navigate back to the library. Only meaningful in the main window. */
  onGoHome?: () => void;
  /** Escape hatch for a contained failure — closing the modal it lives in. */
  onDismiss?: () => void;
  /** Already-translated label for `onDismiss`; the host names its own exit. */
  dismissLabel?: string;
}

/**
 * Presentation for a caught error. Split out of the class so the class holds
 * nothing but the lifecycle, and so the copy can use `useTranslation` — the app
 * has no non-hook translator and hardcoding English here is not an option.
 */
function BoundaryFallback({
  scope,
  attempts,
  detail,
  isMainWindow,
  atHome,
  onRetry,
  onGoHome,
  onDismiss,
  dismissLabel,
}: {
  scope: BoundaryScope;
  attempts: number;
  detail: string | null;
  isMainWindow: boolean;
  atHome: boolean;
  onRetry: () => void;
  onGoHome?: () => void;
  onDismiss?: () => void;
  dismissLabel?: string;
}) {
  const { t } = useTranslation();
  const plan = planBoundaryFallback({
    scope,
    attempts,
    isMainWindow,
    atHome,
    canDismiss: Boolean(onDismiss),
  });

  if (!plan.visible) return null;

  /**
   * Exactly one filled button per panel, and never `ghost`.
   *
   * `planBoundaryFallback` already puts the recommended action first, so the
   * emphasis follows from the plan rather than from a second table that could
   * disagree with it. Every action on an error screen is one the reader may
   * genuinely need; `ghost` reads as body text next to a real button, which
   * is fine in a toolbar and wrong here.
   */
  const renderAction = (action: BoundaryAction, index: number) => {
    const variant = index === 0 ? "primary" : "secondary";
    switch (action) {
      case "retry":
        return (
          <Button key="retry" variant={variant} size="sm" onClick={onRetry}>
            <RotateCw size={13} aria-hidden="true" />
            {t("common.retry")}
          </Button>
        );
      case "home":
        return (
          <Button key="home" variant={variant} size="sm" onClick={onGoHome}>
            {t("errorBoundary.backToLibrary")}
          </Button>
        );
      case "reload":
        return (
          <Button key="reload" variant={variant} size="sm" onClick={() => window.location.reload()}>
            <RotateCw size={13} aria-hidden="true" />
            {t("errorBoundary.reload")}
          </Button>
        );
      case "dismiss":
        return (
          <Button key="dismiss" variant={variant} size="sm" onClick={onDismiss}>
            {dismissLabel ?? t("common.close")}
          </Button>
        );
      case "copy":
        return (
          <Button
            key="copy"
            variant={variant}
            size="sm"
            onClick={() => {
              void navigator.clipboard
                ?.writeText(`${detail ?? ""}\n\n${getReaderDiagnosticReport()}`)
                .catch(() => {});
            }}
          >
            {t("reader.copyDiagnostics")}
          </Button>
        );
    }
  };

  const icon = (
    <div
      className={`flex items-center justify-center rounded-md bg-danger-bg text-danger-text ${
        plan.layout === "inset" ? "size-9" : "size-10"
      }`}
    >
      <AlertTriangle size={plan.layout === "inset" ? 18 : 21} aria-hidden="true" />
    </div>
  );

  const copy = (
    <div className={plan.layout === "inset" ? "min-w-0" : "max-w-[560px]"}>
      <p className="text-[16px] font-medium text-text-primary">{t(plan.titleKey)}</p>
      <p className="mt-2 text-[13px] leading-5 text-text-muted break-words">{t(plan.bodyKey)}</p>
      {/* Never the headline. Someone who only wanted to read a book gets a
          sentence they can act on; the stack stays one click away for whoever
          is going to file the bug. */}
      {detail && (
        <details
          className={`mt-3 max-w-[520px] text-left ${plan.layout === "inset" ? "" : "mx-auto"}`}
        >
          <summary
            className={`cursor-pointer text-[12px] text-text-secondary ${
              plan.layout === "inset" ? "" : "text-center"
            }`}
          >
            {t("reader.errorDetails")}
          </summary>
          <p className="mt-2 max-h-[200px] overflow-auto whitespace-pre-wrap rounded-md bg-bg-input px-3 py-2 font-mono text-[11px] leading-5 text-text-muted break-words">
            {detail}
          </p>
        </details>
      )}
    </div>
  );

  const actions = <div className="flex flex-wrap items-center gap-2">{plan.actions.map(renderAction)}</div>;

  if (plan.layout === "inset") {
    return (
      <div
        role="alert"
        className="mt-3 flex items-start gap-3 rounded-lg border border-border bg-bg-muted p-4"
      >
        {icon}
        <div className="min-w-0 flex-1">
          {copy}
          <div className="mt-3.5">{actions}</div>
        </div>
      </div>
    );
  }

  return (
    <div
      role="alert"
      className="flex h-screen flex-col items-center justify-center gap-4 bg-bg-page px-6 text-center"
    >
      {icon}
      {copy}
      {actions}
    </div>
  );
}

/**
 * Catches a render/lifecycle failure in its subtree and shows something the
 * user can act on instead of an empty `#root`.
 *
 * It does not swallow anything: every catch goes to the console with its stack
 * and into the app's existing diagnostic trail (`log_webview_warning`, the same
 * on-disk channel the reader's fault sinks use), so a boundary in front of a
 * bug never makes the bug harder to find than it was without one.
 *
 * What it structurally cannot catch — React's rules, not ours: errors thrown in
 * event handlers, in `setTimeout`, or inside a promise. Those never pass
 * through render, so `Home`'s `handleImport` and every other async path still
 * needs its own `try`/`catch`.
 */
export default class ErrorBoundary extends Component<ErrorBoundaryProps, BoundaryState> {
  state: BoundaryState = initialBoundaryState;

  static getDerivedStateFromProps(props: ErrorBoundaryProps, state: BoundaryState): BoundaryState {
    return reconcileBoundaryState(state, props.resetKey);
  }

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    return { error, detail: boundaryDetailText(error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    this.setState({ detail: boundaryDetailText(error, info.componentStack) });
    // Explicit, not just React's own dev-only logging: this is the line a
    // production console keeps.
    console.error(`[error-boundary/${this.props.scope}]`, error, info.componentStack);
    logReaderDiagnostic(
      `ui.boundary.${this.props.scope}`,
      `${boundaryDetailText(error, info.componentStack) ?? "unknown error"}`,
    );
  }

  private retry = () => {
    this.setState(retriedBoundaryState);
  };

  render() {
    if (this.state.error === null || this.state.error === undefined) {
      // Keyed by the attempt count so that "retry" is a real remount: every bit
      // of component state below is discarded and every effect re-runs, which
      // is what re-issues the request that returned the bad payload. Re-render
      // alone would hand the same component the same data and fail identically.
      return <Fragment key={this.state.attempts}>{this.props.children}</Fragment>;
    }
    return (
      <BoundaryFallback
        scope={this.props.scope}
        attempts={this.state.attempts}
        detail={this.state.detail}
        isMainWindow={this.props.isMainWindow ?? true}
        atHome={this.props.atHome ?? false}
        onRetry={this.retry}
        onGoHome={this.props.onGoHome}
        onDismiss={this.props.onDismiss}
        dismissLabel={this.props.dismissLabel}
      />
    );
  }
}

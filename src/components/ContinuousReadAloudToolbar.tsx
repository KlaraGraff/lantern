import { AlertTriangle, ChevronDown, ChevronUp, Pause, Play, RotateCcw, SkipBack, SkipForward, Square, Volume2 } from "lucide-react";
import { continuousReadReadout, type ContinuousReadState } from "./continuous-read-aloud";
import Select from "./ui/Select";

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];

export interface ContinuousReadAloudLabels {
  reading: string;
  paused: string;
  finished: string;
  failed: string;
  retry: string;
  restart: string;
  leaveAtEnd: string;
  previous: string;
  next: string;
  pause: string;
  resume: string;
  stop: string;
  collapse: string;
  expand: string;
  preparing: string;
  lastSentence: string;
  chapterProgress: string;
  position: (index: number, total: number) => string;
  timeLeft: (minutes: number) => string;
  speed: (rate: number) => string;
}

interface Props {
  state: ContinuousReadState;
  labels: ContinuousReadAloudLabels;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onRateChange: (rate: number) => void;
  onCollapsedChange: (collapsed: boolean) => void;
}

/**
 * The flanking keys and the tail keys share one size so the play key sits at a
 * fixed offset from the bar's centre. Both are laid out with `disabled:` styles
 * that keep the box — a key that vanished when it became unusable would shift
 * the play key sideways at exactly the moment (first sentence, last sentence)
 * the user is reaching for it without looking.
 */
const SMALL_KEY = "grid size-[30px] shrink-0 cursor-pointer place-items-center rounded-full text-text-muted transition-colors hover:bg-bg-input hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-text-muted";

/** The one control a listener reaches for. Filled, 46px, never disabled. */
const BIG_KEY = "grid size-[46px] shrink-0 cursor-pointer place-items-center rounded-full bg-accent text-white shadow-[0_4px_12px_rgba(124,58,237,0.22)] transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2";

/**
 * In-flow toolbar: its parent places it below Reader's title row, so it never
 * floats over the text.  The compact capsule is retained while reading.
 */
export default function ContinuousReadAloudToolbar({ state, labels, onStart, onPause, onResume, onStop, onPrevious, onNext, onRateChange, onCollapsedChange }: Props) {
  const active = state.status !== "idle" && state.status !== "finished" && state.status !== "error";
  const playing = state.status === "playing" || state.status === "loading";
  const onSectionKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); onCollapsedChange(true); }
  };
  if (state.collapsed && active) {
    return <button type="button" onClick={() => onCollapsedChange(false)} className="flex h-8 items-center gap-2 rounded-full border border-border-light bg-bg-surface px-3 text-xs text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" aria-label={labels.expand}><Volume2 size={14} className={playing ? "animate-pulse text-accent-text" : ""} />{state.status === "paused" ? labels.paused : labels.reading} · {labels.speed(state.rate)}<ChevronDown size={13} /></button>;
  }

  const statusLabel = state.status === "paused"
    ? labels.paused
    : state.status === "finished"
      ? labels.finished
      : state.status === "error"
        ? labels.failed
        : labels.reading;

  const readout = continuousReadReadout(state);
  const positionText = readout.position ? labels.position(readout.position.index, readout.position.total) : "";
  // Only ever one of the two: on the chapter's last sentence a time estimate has
  // nothing left to decide, which is why `continuousReadReadout` withholds it.
  const tailText = readout.lastSentence
    ? labels.lastSentence
    : readout.remainingMinutes !== null
      ? labels.timeLeft(readout.remainingMinutes)
      : "";
  // Before the first sentence resolves there is no position to report, and the
  // bar says what it is waiting for instead of showing an empty readout.
  const waitingText = !positionText && !tailText && !state.current && state.status === "loading"
    ? labels.preparing
    : "";

  const percent = readout.fraction === null ? null : Math.round(readout.fraction * 100);
  const spent = state.status === "paused" || state.status === "error";

  return <section
    aria-label={labels.reading}
    onKeyDown={onSectionKeyDown}
    className="flex min-h-[62px] items-center gap-3.5 border-b border-border-light bg-bg-surface px-3.5 py-2"
  >
    <span className={`grid size-7 shrink-0 place-items-center rounded-lg max-[720px]:hidden ${
      state.status === "error"
        ? "bg-danger-bg text-danger-text"
        : playing
          ? "bg-accent-bg text-accent-text"
          : "text-text-muted"
    }`}>
      {state.status === "error"
        ? <AlertTriangle size={16} />
        : <Volume2 size={16} className={state.status === "loading" ? "animate-pulse" : ""} />}
    </span>

    <div className="min-w-0 flex-1">
      <div className="flex min-w-0 items-baseline gap-2" aria-live="polite">
        <span className="shrink-0 text-[12.5px] font-semibold text-text-primary">{statusLabel}</span>
        {state.current?.text
          ? <span className="min-w-0 flex-1 truncate font-serif text-[12.5px] text-text-muted max-[720px]:hidden">{state.current.text}</span>
          : null}
      </div>
      <div className="mt-1.5 flex items-center gap-2.5">
        <span
          role="progressbar"
          aria-label={labels.chapterProgress}
          aria-valuemin={0}
          aria-valuemax={100}
          {...(percent === null ? {} : { "aria-valuenow": percent })}
          className="relative h-0.5 min-w-10 flex-1 overflow-hidden rounded-full bg-border"
        >
          <span
            className={`block h-full rounded-full transition-[width] duration-150 ease-linear ${
              percent === null ? "w-full animate-pulse" : ""
            } ${spent ? "bg-text-muted/60" : "bg-accent/70"}`}
            style={percent === null ? undefined : { width: `${percent}%` }}
          />
        </span>
        <span className="shrink-0 text-[10px] tabular-nums text-text-muted">
          {waitingText}
          {positionText}
          {tailText ? <span className="max-[920px]:hidden">{positionText ? " · " : ""}{tailText}</span> : null}
        </span>
      </div>
    </div>

    <div className="flex shrink-0 items-center gap-2.5">
      <button type="button" className={SMALL_KEY} onClick={onPrevious} disabled={!state.current || state.current.atBookStart === true} aria-label={labels.previous} title={labels.previous}><SkipBack size={16} fill="currentColor" /></button>
      {state.status === "paused"
        ? <button type="button" className={BIG_KEY} onClick={onResume} aria-label={labels.resume} title={labels.resume}><Play size={19} fill="currentColor" /></button>
        : active
          // Enabled while loading on purpose: changing your mind must not wait
          // for the audio the bar is still fetching.
          ? <button type="button" className={BIG_KEY} onClick={onPause} aria-label={labels.pause} title={labels.pause}><Pause size={19} fill="currentColor" /></button>
          : <button type="button" className={BIG_KEY} onClick={onStart} aria-label={state.status === "error" ? labels.retry : labels.restart} title={state.status === "error" ? labels.retry : labels.restart}>{state.status === "error" ? <RotateCcw size={19} /> : <Play size={19} fill="currentColor" />}</button>}
      <button type="button" className={SMALL_KEY} onClick={onNext} disabled={!state.current || state.current.atBookEnd === true} aria-label={labels.next} title={labels.next}><SkipForward size={16} fill="currentColor" /></button>
    </div>

    <div className="flex shrink-0 items-center gap-1.5">
      <Select
        className="w-[76px] shrink-0 max-[560px]:w-[64px]"
        value={String(state.rate)}
        onChange={(value) => onRateChange(Number(value))}
        options={RATES.map((rate) => ({ value: String(rate), label: labels.speed(rate) }))}
      />
      <button type="button" className={SMALL_KEY} onClick={onStop} aria-label={state.status === "finished" ? labels.leaveAtEnd : labels.stop} title={state.status === "finished" ? labels.leaveAtEnd : labels.stop}><Square size={14} fill="currentColor" /></button>
      {/* Deliberately absent while finished or errored: `active` excludes both,
          so the expanded bar is the only way out of them. */}
      {active && <button type="button" className={SMALL_KEY} onClick={() => onCollapsedChange(true)} aria-label={labels.collapse} title={labels.collapse}><ChevronUp size={16} /></button>}
    </div>
  </section>;
}

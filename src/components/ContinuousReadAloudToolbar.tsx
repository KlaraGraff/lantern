import { ChevronDown, ChevronUp, Pause, Play, RotateCcw, SkipBack, SkipForward, Square, Volume2 } from "lucide-react";
import type { ContinuousReadState } from "./continuous-read-aloud";
import Button from "./ui/Button";

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
 * In-flow toolbar: its parent places it below Reader's title row, so it never
 * floats over the text.  The compact capsule is retained while reading.
 */
export default function ContinuousReadAloudToolbar({ state, labels, onStart, onPause, onResume, onStop, onPrevious, onNext, onRateChange, onCollapsedChange }: Props) {
  const active = state.status !== "idle" && state.status !== "finished" && state.status !== "error";
  const playing = state.status === "playing" || state.status === "loading";
  if (state.collapsed && active) {
    return <button type="button" onClick={() => onCollapsedChange(false)} className="flex h-8 items-center gap-2 rounded-full border border-border-light bg-bg-elevated px-3 text-xs text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" aria-label={labels.expand}><Volume2 size={14} className={playing ? "animate-pulse text-accent-text" : ""} />{state.status === "paused" ? labels.paused : labels.reading} · {labels.speed(state.rate)}<ChevronDown size={13} /></button>;
  }
  const statusLabel = state.status === "paused"
    ? labels.paused
    : state.status === "finished"
      ? labels.finished
      : state.status === "error"
        ? labels.failed
        : labels.reading;
  return <section aria-label={labels.reading} aria-live="polite" className="flex min-h-12 items-center gap-2 overflow-x-auto border-b border-border-light bg-bg-elevated px-4 py-2">
    <Volume2 size={16} className={playing ? "animate-pulse text-accent-text" : "text-text-muted"} />
    <span className="min-w-24 flex-1 truncate text-sm text-text-secondary"><span className="font-medium text-text-primary">{statusLabel}</span>{state.current?.text ? <span> · {state.current.text}</span> : null}</span>
    <Button variant="icon" size="sm" onClick={onPrevious} disabled={!state.current} aria-label={labels.previous} title={labels.previous}><SkipBack size={16} /></Button>
    {state.status === "paused" ? <Button variant="icon" size="sm" onClick={onResume} aria-label={labels.resume} title={labels.resume}><Play size={16} fill="currentColor" /></Button> : active ? <Button variant="icon" size="sm" onClick={onPause} disabled={!playing} aria-label={labels.pause} title={labels.pause}><Pause size={16} fill="currentColor" /></Button> : <Button variant="icon" size="sm" onClick={onStart} aria-label={state.status === "error" ? labels.retry : labels.restart} title={state.status === "error" ? labels.retry : labels.restart}>{state.status === "error" ? <RotateCcw size={16} /> : <Play size={16} fill="currentColor" />}</Button>}
    <Button variant="icon" size="sm" onClick={onNext} disabled={!state.current} aria-label={labels.next} title={labels.next}><SkipForward size={16} /></Button>
    <label className="flex items-center gap-1 text-xs text-text-muted"><span className="sr-only">{labels.speed(state.rate)}</span><select value={state.rate} onChange={(event) => onRateChange(Number(event.target.value))} className="rounded border border-border-light bg-bg-input px-1 py-0.5 text-text-primary">{[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => <option key={rate} value={rate}>{labels.speed(rate)}</option>)}</select></label>
    {state.status !== "idle" && <Button variant="icon" size="sm" onClick={onStop} aria-label={state.status === "finished" ? labels.leaveAtEnd : labels.stop} title={state.status === "finished" ? labels.leaveAtEnd : labels.stop}><Square size={14} fill="currentColor" /></Button>}
    {active && <Button variant="icon" size="sm" onClick={() => onCollapsedChange(true)} aria-label={labels.collapse} title={labels.collapse}><ChevronUp size={16} /></Button>}
  </section>;
}

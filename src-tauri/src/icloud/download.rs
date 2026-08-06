//! Waiting on one book to come down from iCloud, with progress the reader can
//! see and a way to give up.
//!
//! On the phone a book that is not resident is the ordinary case, not an edge
//! case (D-013): iCloud evicts freely, the shelf still lists everything, and
//! tapping a title is what fetches it. `icloud.rs` already knows how to
//! *recognise* an evicted item and how to *ask* for it; what lives here is the
//! part that watches the request through and tells the reader where it has got
//! to, so a placeholder stops surfacing as "cannot open".
//!
//! **Per file, not per folder.** Progress is read from the item's own URL
//! resource values on a poll, deliberately not from an `NSMetadataQuery`. A
//! query watches a whole directory and has to be kept alive on a run loop; that
//! is a separate mechanism with a separate owner (P5 item 3, replacing the
//! `notify` watcher). A reader waiting on one book needs one file's numbers,
//! and polling one URL costs a `stat` and two resource reads.
//!
//! **The percentage is a bonus, not a contract.** See
//! [`super::DownloadSnapshot::percent`]: iCloud often reports no number at all,
//! so every event here may carry `percent: null` and the reader's progress
//! display has to work anyway.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use chrono::Utc;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::watch;

use super::{download_snapshot, file_readability, trigger_download_file, FileAvailability};
use crate::error::{AppError, AppResult};

/// How often the watched file is re-read.
///
/// Fast enough that a small book's progress bar does not look frozen, slow
/// enough that a large one does not spend the whole download in `stat`.
const POLL_INTERVAL: Duration = Duration::from_millis(750);

/// How long to wait before asking iCloud again for a file it does not appear to
/// be fetching.
///
/// `startDownloadingUbiquitousItemAtURL:` is a request, not a command, and iOS
/// drops in-flight requests when the app is suspended — a reader who backgrounds
/// the app mid-download and comes back would otherwise wait on a transfer
/// nobody is making. Re-asking is idempotent, so the cost of being wrong is
/// nil.
const REKICK_INTERVAL_MS: i64 = 15_000;

/// How long a single watch runs before it stops reporting.
///
/// This ends the *watch*, not the download: iCloud keeps fetching, and opening
/// the book again starts a fresh watch that will finish immediately if the
/// bytes arrived meanwhile. The limit exists so a task polling a file nobody is
/// waiting for any more cannot outlive the session.
const WATCH_DEADLINE_MS: i64 = 30 * 60 * 1000;

/// Percentage movement below which no event is emitted.
///
/// iCloud can report fractional changes several times a second on a fast link;
/// a whole point is the smallest step a progress bar can actually show.
const PERCENT_EMIT_STEP: f64 = 1.0;

/// The event channel one download reports on.
///
/// Per-request, matching the AI streaming idiom (`ai-translate-chunk-<id>`):
/// the frontend mints the request id, subscribes, and only then invokes, so no
/// event can be missed between the two.
pub fn event_name(request_id: &str) -> String {
    format!("book-download-{request_id}")
}

/// What a download can be doing, from the reader's point of view.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DownloadPhase {
    /// iCloud has been asked and the bytes are not all here yet.
    Downloading,
    /// The file opens. This is the only phase the reader can act on.
    Ready,
    /// The reader gave up waiting.
    Cancelled,
    /// The wait ended without the file becoming readable.
    Failed,
}

/// One progress event for one book download.
///
/// Shaped like the AI stream's `AiStreamChunk` — a `done` flag and an optional
/// `error` code — so the frontend's stream-subscription pattern applies
/// unchanged.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BookDownloadProgress {
    /// The book being fetched, so a stale subscription cannot mislabel a row.
    pub book_id: String,
    pub phase: DownloadPhase,
    /// Completion in percent, 0–100, when iCloud reports one. Frequently
    /// absent for a whole download — render an indeterminate state then.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<f64>,
    /// True on the last event of a watch, whatever the phase.
    pub done: bool,
    /// A stable code for the frontend to translate, never prose.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// iCloud's own message behind `error`, already localised by the OS.
    /// Diagnostic detail for the reader to quote, not something to translate.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// The file could not be found at all — a local repair problem, not an iCloud
/// one, so retrying the download would loop forever.
pub const ERROR_FILE_MISSING: &str = "BOOK_FILE_MISSING";
/// The file resolves and iCloud calls it downloaded, but the bytes refuse to
/// be read: a permission problem or a volume that went away.
pub const ERROR_FILE_UNREADABLE: &str = "BOOK_FILE_UNREADABLE";
/// iCloud itself reported a failure against the item.
pub const ERROR_DOWNLOAD_FAILED: &str = "BOOK_DOWNLOAD_FAILED";
/// The watch hit [`WATCH_DEADLINE_MS`]. The transfer may still be running.
pub const ERROR_DOWNLOAD_TIMED_OUT: &str = "BOOK_DOWNLOAD_TIMED_OUT";
/// A second watch was asked for under a request id that already has one.
pub const ERROR_ALREADY_RUNNING: &str = "BOOK_DOWNLOAD_ALREADY_RUNNING";

/// Everything one poll learned about the watched file.
#[derive(Debug, Clone, PartialEq)]
pub struct PollReading {
    /// The authoritative answer to "can the reader open this yet", reused from
    /// `file_readability` rather than re-derived, so the watch and the book-open
    /// path can never disagree about when a download finished.
    pub availability: FileAvailability,
    /// The decoration: how far along, and whether iCloud is still trying.
    pub snapshot: super::DownloadSnapshot,
}

/// What the watch loop should do after one poll.
#[derive(Debug, Clone, PartialEq)]
pub struct WatchStep {
    /// The event to emit, when this poll changed something the reader can see.
    pub progress: Option<BookDownloadProgress>,
    /// Ask iCloud for the file again before polling further.
    pub rekick: bool,
    /// Stop polling. Any event in `progress` is the last one.
    pub done: bool,
}

/// The decision half of a watch, kept free of Foundation and of the clock so
/// every branch can be exercised on a machine with no iCloud account.
#[derive(Debug)]
pub struct DownloadWatch {
    book_id: String,
    started_at_ms: i64,
    last_kick_ms: i64,
    /// The highest percentage already sent. Progress is clamped to be
    /// monotonic: iCloud restarts a stalled transfer from zero, and a bar that
    /// jumps backwards reads as the book un-downloading itself.
    reported_percent: Option<f64>,
    reported_downloading: bool,
    emitted: bool,
}

impl DownloadWatch {
    /// Start a watch for `book_id`. `now_ms` seeds both the deadline and the
    /// re-ask timer, because the caller has just asked iCloud once itself.
    pub fn new(book_id: impl Into<String>, now_ms: i64) -> Self {
        Self {
            book_id: book_id.into(),
            started_at_ms: now_ms,
            last_kick_ms: now_ms,
            reported_percent: None,
            reported_downloading: false,
            emitted: false,
        }
    }

    /// Fold one poll into the watch.
    pub fn observe(&mut self, reading: &PollReading, now_ms: i64) -> WatchStep {
        match reading.availability {
            // The bytes are here and readable. This is the only success, and it
            // is decided by the same probe the book-open path uses.
            FileAvailability::Available => {
                return self.finish(DownloadPhase::Ready, Some(100.0), None, None)
            }
            // Neither of these is an iCloud problem, and neither improves by
            // waiting, so the watch ends instead of polling a file that will
            // never arrive.
            FileAvailability::Missing => {
                return self.finish(
                    DownloadPhase::Failed,
                    self.reported_percent,
                    Some(ERROR_FILE_MISSING),
                    None,
                )
            }
            FileAvailability::Unreadable => {
                return self.finish(
                    DownloadPhase::Failed,
                    self.reported_percent,
                    Some(ERROR_FILE_UNREADABLE),
                    None,
                )
            }
            FileAvailability::ICloudPlaceholder => {}
        }

        // iCloud recorded a failure against the item. It survives on the item
        // until the next attempt, so reporting it is more useful than waiting
        // out the deadline in silence.
        if let Some(detail) = reading.snapshot.error.clone() {
            return self.finish(
                DownloadPhase::Failed,
                self.reported_percent,
                Some(ERROR_DOWNLOAD_FAILED),
                Some(detail),
            );
        }

        if now_ms.saturating_sub(self.started_at_ms) >= WATCH_DEADLINE_MS {
            return self.finish(
                DownloadPhase::Failed,
                self.reported_percent,
                Some(ERROR_DOWNLOAD_TIMED_OUT),
                None,
            );
        }

        let percent = self.advance_percent(reading.snapshot.percent);
        let downloading = reading.snapshot.downloading;

        // Nothing is fetching this file, so the earlier request was dropped or
        // never took. Re-ask, but not on every poll — see REKICK_INTERVAL_MS.
        let rekick = !downloading && now_ms.saturating_sub(self.last_kick_ms) >= REKICK_INTERVAL_MS;
        if rekick {
            self.last_kick_ms = now_ms;
        }

        let worth_emitting = !self.emitted
            || downloading != self.reported_downloading
            || percent_step_crossed(self.reported_percent, percent);
        self.reported_downloading = downloading;
        if !worth_emitting {
            return WatchStep {
                progress: None,
                rekick,
                done: false,
            };
        }
        self.reported_percent = percent;
        self.emitted = true;
        WatchStep {
            progress: Some(BookDownloadProgress {
                book_id: self.book_id.clone(),
                phase: DownloadPhase::Downloading,
                percent,
                done: false,
                error: None,
                detail: None,
            }),
            rekick,
            done: false,
        }
    }

    /// The event for a reader who gave up. Carries the last percentage so the
    /// row can show where it stopped rather than snapping back to zero.
    pub fn cancelled(&self) -> BookDownloadProgress {
        BookDownloadProgress {
            book_id: self.book_id.clone(),
            phase: DownloadPhase::Cancelled,
            percent: self.reported_percent,
            done: true,
            error: None,
            detail: None,
        }
    }

    fn finish(
        &mut self,
        phase: DownloadPhase,
        percent: Option<f64>,
        error: Option<&str>,
        detail: Option<String>,
    ) -> WatchStep {
        self.emitted = true;
        self.reported_percent = percent;
        WatchStep {
            progress: Some(BookDownloadProgress {
                book_id: self.book_id.clone(),
                phase,
                percent,
                done: true,
                error: error.map(str::to_string),
                detail,
            }),
            rekick: false,
            done: true,
        }
    }

    /// Clamp a raw reading into the 0–100 band and never let it fall.
    ///
    /// A missing reading keeps whatever was last shown: iCloud dropping the
    /// number mid-download is normal, and it does not mean progress was lost.
    fn advance_percent(&self, reading: Option<f64>) -> Option<f64> {
        let Some(raw) = reading.filter(|value| value.is_finite()) else {
            return self.reported_percent;
        };
        let clamped = raw.clamp(0.0, 100.0);
        match self.reported_percent {
            Some(previous) if previous >= clamped => Some(previous),
            _ => Some(clamped),
        }
    }
}

/// True when the reader would see the bar move.
fn percent_step_crossed(previous: Option<f64>, next: Option<f64>) -> bool {
    match (previous, next) {
        (Some(previous), Some(next)) => (next - previous).abs() >= PERCENT_EMIT_STEP,
        (None, Some(_)) => true,
        _ => false,
    }
}

/// Read the watched file once. Blocking: both halves talk to the filesystem,
/// and on a ubiquitous item the resource reads talk to the iCloud daemon.
pub fn poll_file(path: &Path) -> PollReading {
    PollReading {
        availability: file_readability(path),
        snapshot: download_snapshot(path),
    }
}

/// Live watches, keyed by the request id the frontend minted.
///
/// A watch is registered before its task is spawned, so a Stop tapped the
/// instant after the invoke returns can never find an empty registry. There is
/// deliberately no equivalent of the AI router's pending-cancellation map: a
/// download is one task from registration to completion, never a multi-step job
/// that unregisters between steps, so there is no gap for a cancel to fall
/// into.
fn watch_registry() -> &'static Mutex<HashMap<String, watch::Sender<bool>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, watch::Sender<bool>>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Claim `request_id` for a new watch.
///
/// `None` means the id is already watching something. Re-registering would
/// drop the first watch's sender on the floor and leave that task
/// uncancellable, so the caller has to treat this as an error rather than
/// starting a second watch.
pub fn register(request_id: &str) -> Option<watch::Receiver<bool>> {
    let mut registry = watch_registry().lock().ok()?;
    if registry.contains_key(request_id) {
        return None;
    }
    let (sender, receiver) = watch::channel(false);
    registry.insert(request_id.to_string(), sender);
    Some(receiver)
}

/// Release `request_id`. Called by the watch task on every exit path.
pub fn finish(request_id: &str) {
    if let Ok(mut registry) = watch_registry().lock() {
        registry.remove(request_id);
    }
}

/// Ask the watch for `request_id` to stop. `false` when there is no such watch,
/// which is what a Stop that raced the last event looks like.
///
/// **This stops the waiting, not the transfer.** iCloud exposes no way to
/// withdraw a `startDownloadingUbiquitousItemAtURL:` request, so the bytes may
/// well keep arriving in the background — which is fine, and means a reader who
/// gives up and comes back often finds the book already open-able.
pub fn cancel(request_id: &str) -> bool {
    match watch_registry().lock() {
        Ok(registry) => registry
            .get(request_id)
            .is_some_and(|sender| sender.send(true).is_ok()),
        Err(_) => false,
    }
}

/// Start fetching `path` and report progress on [`event_name`] until it is
/// readable, fails, or the reader cancels.
///
/// Returns as soon as the request is in — the waiting happens on the async
/// runtime. Errors only when the request id is already in use; everything that
/// can go wrong afterwards arrives as a `done` event instead, so the frontend
/// has one place to handle failure.
pub fn start_watch(
    app: &AppHandle,
    book_id: &str,
    path: PathBuf,
    request_id: &str,
) -> AppResult<()> {
    let Some(cancel_rx) = register(request_id) else {
        return Err(AppError::Other(ERROR_ALREADY_RUNNING.to_string()));
    };
    // Ask before the first poll, so the first reading already reflects a
    // download in flight rather than a file nobody has requested.
    trigger_download_file(&path);
    let app = app.clone();
    let book_id = book_id.to_string();
    let request_id = request_id.to_string();
    tauri::async_runtime::spawn(async move {
        run_watch(app, book_id, path, request_id, cancel_rx).await;
    });
    Ok(())
}

async fn run_watch(
    app: AppHandle,
    book_id: String,
    path: PathBuf,
    request_id: String,
    mut cancel_rx: watch::Receiver<bool>,
) {
    let event = event_name(&request_id);
    let mut state = DownloadWatch::new(book_id, now_ms());
    loop {
        // The poll is synchronous and can reach the iCloud daemon, so it is not
        // run on the async runtime's own threads.
        let polled = {
            let path = path.clone();
            tauri::async_runtime::spawn_blocking(move || poll_file(&path)).await
        };
        let Ok(reading) = polled else {
            // The only way this fails is the runtime shutting down, and there
            // is then nobody left to tell.
            break;
        };

        let step = state.observe(&reading, now_ms());
        if step.rekick {
            let path = path.clone();
            let _ =
                tauri::async_runtime::spawn_blocking(move || trigger_download_file(&path)).await;
        }
        if let Some(progress) = step.progress {
            let _ = app.emit(&event, progress);
        }
        if step.done {
            break;
        }

        tokio::select! {
            _ = tokio::time::sleep(POLL_INTERVAL) => {}
            // A cancel wakes the loop immediately rather than after the rest of
            // the poll interval, so Stop feels like it did something.
            _ = cancel_rx.changed() => {}
        }
        if *cancel_rx.borrow() {
            let _ = app.emit(&event, state.cancelled());
            break;
        }
    }
    finish(&request_id);
}

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

/// Give up on a book download the reader is tired of waiting for.
///
/// Returns whether a live watch was found. See [`cancel`] for why the bytes may
/// keep arriving afterwards.
///
/// Registered on its own, unlike starting a download, which rides on
/// `diagnose_book_file` — cancelling has nothing to ride on.
#[tauri::command]
pub fn cancel_book_download(request_id: String) -> bool {
    cancel(&request_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::icloud::DownloadSnapshot;
    use std::fs;
    use tempfile::TempDir;

    fn placeholder(percent: Option<f64>, downloading: bool) -> PollReading {
        PollReading {
            availability: FileAvailability::ICloudPlaceholder,
            snapshot: DownloadSnapshot {
                downloading,
                percent,
                error: None,
            },
        }
    }

    fn arrived() -> PollReading {
        PollReading {
            availability: FileAvailability::Available,
            snapshot: DownloadSnapshot {
                downloading: false,
                percent: Some(100.0),
                error: None,
            },
        }
    }

    // --- event channel ---

    #[test]
    fn each_request_gets_its_own_event_channel() {
        assert_eq!(event_name("abc-123"), "book-download-abc-123");
        assert_ne!(event_name("a"), event_name("b"));
    }

    // --- the state machine ---

    #[test]
    fn the_first_poll_always_tells_the_reader_something() {
        // Otherwise a download with no percentage reported — the common case —
        // would leave the reader looking at nothing at all until it finished.
        let mut watch = DownloadWatch::new("book", 0);
        let step = watch.observe(&placeholder(None, true), 0);
        let progress = step.progress.expect("first poll must emit");
        assert_eq!(progress.phase, DownloadPhase::Downloading);
        assert_eq!(progress.percent, None);
        assert!(!progress.done);
        assert!(!step.done);
    }

    #[test]
    fn an_unchanged_poll_stays_quiet() {
        let mut watch = DownloadWatch::new("book", 0);
        watch.observe(&placeholder(Some(10.0), true), 0);
        let step = watch.observe(&placeholder(Some(10.4), true), 1_000);
        assert_eq!(step.progress, None);
        assert!(!step.done);
    }

    #[test]
    fn a_whole_point_of_progress_is_worth_an_event() {
        let mut watch = DownloadWatch::new("book", 0);
        watch.observe(&placeholder(Some(10.0), true), 0);
        let step = watch.observe(&placeholder(Some(11.2), true), 1_000);
        assert_eq!(step.progress.expect("moved").percent, Some(11.2));
    }

    #[test]
    fn iclouds_flag_flipping_is_worth_an_event_on_its_own() {
        // "Downloading" versus "queued behind something" is the difference
        // between a bar that should spin and one that should not.
        let mut watch = DownloadWatch::new("book", 0);
        watch.observe(&placeholder(Some(10.0), true), 0);
        let step = watch.observe(&placeholder(Some(10.0), false), 1_000);
        assert!(step.progress.is_some());
    }

    #[test]
    fn progress_never_runs_backwards() {
        // iCloud restarts a stalled transfer from zero. Showing that would read
        // as the book un-downloading itself.
        let mut watch = DownloadWatch::new("book", 0);
        watch.observe(&placeholder(Some(60.0), true), 0);
        let step = watch.observe(&placeholder(Some(2.0), true), 1_000);
        assert_eq!(step.progress, None);
        let step = watch.observe(&placeholder(Some(80.0), true), 2_000);
        assert_eq!(step.progress.expect("moved").percent, Some(80.0));
    }

    #[test]
    fn a_percentage_that_vanishes_keeps_the_last_one() {
        let mut watch = DownloadWatch::new("book", 0);
        watch.observe(&placeholder(Some(40.0), true), 0);
        assert_eq!(
            watch.observe(&placeholder(None, true), 1_000).progress,
            None
        );
        assert_eq!(watch.cancelled().percent, Some(40.0));
    }

    #[test]
    fn nonsense_percentages_are_clamped_into_the_band() {
        let mut watch = DownloadWatch::new("book", 0);
        let step = watch.observe(&placeholder(Some(180.0), true), 0);
        assert_eq!(step.progress.expect("first poll").percent, Some(100.0));

        let mut watch = DownloadWatch::new("book", 0);
        let step = watch.observe(&placeholder(Some(-5.0), true), 0);
        assert_eq!(step.progress.expect("first poll").percent, Some(0.0));

        let mut watch = DownloadWatch::new("book", 0);
        let step = watch.observe(&placeholder(Some(f64::NAN), true), 0);
        assert_eq!(step.progress.expect("first poll").percent, None);
    }

    #[test]
    fn the_file_becoming_readable_ends_the_watch() {
        let mut watch = DownloadWatch::new("book", 0);
        watch.observe(&placeholder(Some(50.0), true), 0);
        let step = watch.observe(&arrived(), 1_000);
        let progress = step.progress.expect("terminal event");
        assert_eq!(progress.phase, DownloadPhase::Ready);
        assert_eq!(progress.percent, Some(100.0));
        assert!(progress.done);
        assert_eq!(progress.error, None);
        assert!(step.done);
        assert!(!step.rekick);
    }

    #[test]
    fn a_file_that_is_simply_gone_is_not_an_icloud_problem() {
        // Waiting cannot fix it, so the watch says so instead of polling until
        // the deadline.
        let mut watch = DownloadWatch::new("book", 0);
        let reading = PollReading {
            availability: FileAvailability::Missing,
            snapshot: DownloadSnapshot::default(),
        };
        let step = watch.observe(&reading, 0);
        let progress = step.progress.expect("terminal event");
        assert_eq!(progress.phase, DownloadPhase::Failed);
        assert_eq!(progress.error.as_deref(), Some(ERROR_FILE_MISSING));
        assert!(step.done);
    }

    #[test]
    fn a_present_but_unreadable_file_ends_the_watch() {
        let mut watch = DownloadWatch::new("book", 0);
        let reading = PollReading {
            availability: FileAvailability::Unreadable,
            snapshot: DownloadSnapshot::default(),
        };
        let step = watch.observe(&reading, 0);
        assert_eq!(
            step.progress.expect("terminal event").error.as_deref(),
            Some(ERROR_FILE_UNREADABLE)
        );
        assert!(step.done);
    }

    #[test]
    fn iclouds_own_failure_is_reported_with_its_message() {
        let mut watch = DownloadWatch::new("book", 0);
        let mut reading = placeholder(Some(30.0), false);
        reading.snapshot.error = Some("The network connection was lost.".to_string());
        let step = watch.observe(&reading, 0);
        let progress = step.progress.expect("terminal event");
        assert_eq!(progress.phase, DownloadPhase::Failed);
        assert_eq!(progress.error.as_deref(), Some(ERROR_DOWNLOAD_FAILED));
        assert_eq!(
            progress.detail.as_deref(),
            Some("The network connection was lost.")
        );
        assert!(step.done);
    }

    #[test]
    fn a_watch_that_never_finishes_stops_reporting_eventually() {
        let mut watch = DownloadWatch::new("book", 1_000);
        watch.observe(&placeholder(Some(5.0), true), 1_000);
        let step = watch.observe(&placeholder(Some(5.0), true), 1_000 + WATCH_DEADLINE_MS - 1);
        assert!(!step.done);
        let step = watch.observe(&placeholder(Some(5.0), true), 1_000 + WATCH_DEADLINE_MS);
        let progress = step.progress.expect("terminal event");
        assert_eq!(progress.error.as_deref(), Some(ERROR_DOWNLOAD_TIMED_OUT));
        // The last known position survives, because the transfer itself has not
        // been cancelled and may well still be running.
        assert_eq!(progress.percent, Some(5.0));
        assert!(step.done);
    }

    // --- re-asking iCloud ---

    #[test]
    fn a_file_nobody_is_fetching_gets_asked_for_again() {
        let mut watch = DownloadWatch::new("book", 0);
        assert!(!watch.observe(&placeholder(None, false), 0).rekick);
        assert!(
            !watch
                .observe(&placeholder(None, false), REKICK_INTERVAL_MS - 1)
                .rekick
        );
        assert!(
            watch
                .observe(&placeholder(None, false), REKICK_INTERVAL_MS)
                .rekick
        );
        // And the timer restarts, so the ask does not repeat every poll.
        assert!(
            !watch
                .observe(&placeholder(None, false), REKICK_INTERVAL_MS + 1)
                .rekick
        );
    }

    #[test]
    fn a_download_in_flight_is_left_alone() {
        let mut watch = DownloadWatch::new("book", 0);
        assert!(
            !watch
                .observe(&placeholder(Some(20.0), true), REKICK_INTERVAL_MS * 4)
                .rekick
        );
    }

    // --- cancellation ---

    #[test]
    fn a_request_id_can_only_be_claimed_once() {
        let id = "claim-once";
        let first = register(id).expect("first claim");
        assert!(register(id).is_none());
        drop(first);
        finish(id);
        // Released, so a later download may reuse the id.
        let second = register(id).expect("reclaim after finish");
        drop(second);
        finish(id);
    }

    #[test]
    fn cancelling_signals_the_live_watch() {
        let id = "cancel-live";
        let receiver = register(id).expect("claim");
        assert!(!*receiver.borrow());
        assert!(cancel(id));
        assert!(*receiver.borrow());
        finish(id);
    }

    #[test]
    fn cancelling_a_finished_download_is_a_no_op() {
        // A Stop that races the last event has nothing to stop, and must not be
        // remembered — the next download to reuse this id would die instantly.
        let id = "cancel-finished";
        let receiver = register(id).expect("claim");
        finish(id);
        assert!(!cancel(id));
        drop(receiver);
        let second = register(id).expect("reclaim");
        assert!(!*second.borrow());
        finish(id);
    }

    #[test]
    fn cancelling_something_that_never_ran_is_a_no_op() {
        assert!(!cancel("never-registered"));
    }

    #[test]
    fn a_cancelled_watch_reports_where_it_stopped() {
        let mut watch = DownloadWatch::new("book", 0);
        watch.observe(&placeholder(Some(37.0), true), 0);
        let progress = watch.cancelled();
        assert_eq!(progress.phase, DownloadPhase::Cancelled);
        assert_eq!(progress.percent, Some(37.0));
        assert!(progress.done);
        assert_eq!(progress.error, None);
    }

    // --- the poll, against a real file ---

    #[test]
    fn polling_an_ordinary_file_reports_it_ready() {
        // The host has no iCloud item to poll, but it does prove the two halves
        // agree: a plain readable file is Available and claims no download.
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("book.epub");
        fs::write(&file, "epub data").unwrap();
        let reading = poll_file(&file);
        assert_eq!(reading.availability, FileAvailability::Available);
        assert_eq!(reading.snapshot, DownloadSnapshot::default());

        let mut watch = DownloadWatch::new("book", 0);
        let step = watch.observe(&reading, 0);
        assert_eq!(step.progress.expect("terminal").phase, DownloadPhase::Ready);
    }

    #[test]
    fn polling_a_placeholder_keeps_the_watch_going() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join(".book.epub.icloud"), "placeholder").unwrap();
        let reading = poll_file(&dir.path().join("book.epub"));
        assert_eq!(reading.availability, FileAvailability::ICloudPlaceholder);

        let mut watch = DownloadWatch::new("book", 0);
        let step = watch.observe(&reading, 0);
        assert!(!step.done);
        assert_eq!(
            step.progress.expect("first poll").phase,
            DownloadPhase::Downloading
        );
    }

    // --- the wire shape ---

    #[test]
    fn progress_serialises_the_way_the_frontend_reads_it() {
        let progress = BookDownloadProgress {
            book_id: "book-1".to_string(),
            phase: DownloadPhase::Downloading,
            percent: Some(42.0),
            done: false,
            error: None,
            detail: None,
        };
        let json = serde_json::to_value(&progress).unwrap();
        assert_eq!(json["book_id"], "book-1");
        assert_eq!(json["phase"], "downloading");
        assert_eq!(json["percent"], 42.0);
        assert_eq!(json["done"], false);
        // Absent rather than null, so the frontend can test for presence.
        assert!(json.get("error").is_none());
        assert!(json.get("detail").is_none());
    }

    #[test]
    fn every_phase_has_a_stable_wire_name() {
        for (phase, name) in [
            (DownloadPhase::Downloading, "downloading"),
            (DownloadPhase::Ready, "ready"),
            (DownloadPhase::Cancelled, "cancelled"),
            (DownloadPhase::Failed, "failed"),
        ] {
            assert_eq!(serde_json::to_value(phase).unwrap(), name);
        }
    }
}

//! Quiescing background work before the OS suspends the process.
//!
//! iOS suspends a backgrounded app within a few seconds of the user
//! swiping away, and it does not ask first. A process that is still
//! holding a lock on a data-protected file at that moment is killed
//! outright with `0xdead10cc` — not a crash the app can catch, and not
//! one the user can distinguish from any other "it just closed". Both
//! of our SQLite connections run in WAL mode, which means each holds a
//! POSIX advisory lock on the `-shm` companion for as long as it is
//! open, and the sync writers append into a directory that P5 is about
//! to move inside the iCloud container — the exact shape Apple's own
//! guidance names as the common cause.
//!
//! There is no way to catch this from Tauri: `RunEvent` has `Resumed`
//! but no suspension counterpart on any platform, so the app-lifecycle
//! notifications are observed directly from UIKit here.
//!
//! The shape is a gate, not a kill switch. Background workers take a
//! [`Permit`] around each unit of work; while the app is suspended
//! `permit()` parks the worker instead of letting it start something
//! new, and the suspension handler waits — briefly — for whatever was
//! already running to finish. Work is deferred, never abandoned: a
//! parked worker resumes the moment the app comes back.
//!
//! On every platform other than iOS the gate exists but is never
//! closed, so a permit costs one uncontended mutex and a counter, and
//! desktop behaviour is unchanged.

use std::sync::{Condvar, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

/// How long the suspension handler waits for in-flight background work
/// to reach a stopping point.
///
/// Only iOS ever suspends us, so off iOS this and the two methods that
/// use it have no caller outside the tests. They are compiled anyway
/// rather than `cfg`-ed out: the gate's behaviour is what the tests
/// assert, and a version of it that only exists on iOS could only be
/// tested on iOS.
///
/// iOS allows roughly five seconds inside the "did enter background"
/// callback before it suspends the process regardless, so this has to
/// stay comfortably under that; the handler runs on the main thread and
/// blocking it for the whole budget would be its own bug. If draining
/// ever routinely hits this ceiling the answer is `beginBackgroundTask`
/// (which buys ~30 s), not a longer block here.
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
const DRAIN_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Default)]
struct State {
    suspended: bool,
    in_flight: usize,
}

/// See the module docs. One per process, reached through [`gate`].
pub struct SuspensionGate {
    state: Mutex<State>,
    /// Signalled when the app comes back — wakes parked workers.
    resumed: Condvar,
    /// Signalled when `in_flight` reaches zero — wakes the suspender.
    drained: Condvar,
}

/// Proof that the gate was open when this unit of work started, and that
/// the suspension handler knows the work is running. Dropping it — on
/// the normal path or while unwinding — releases the count.
pub struct Permit<'a> {
    gate: &'a SuspensionGate,
}

impl Drop for Permit<'_> {
    fn drop(&mut self) {
        let mut state = self.gate.lock();
        state.in_flight = state.in_flight.saturating_sub(1);
        if state.in_flight == 0 {
            drop(state);
            self.gate.drained.notify_all();
        }
    }
}

impl SuspensionGate {
    fn new() -> Self {
        Self {
            state: Mutex::new(State::default()),
            resumed: Condvar::new(),
            drained: Condvar::new(),
        }
    }

    /// A panicking worker must not wedge every other worker forever, and
    /// the gate holds no invariant a panic could have broken — two
    /// counters and a flag. Recover from poisoning rather than
    /// propagating it.
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Park until the app is in the foreground, then register one unit of
    /// in-flight work. Call this *around* a drain, not around each row:
    /// the point is to stop new work from starting, and a permit held
    /// across a long transaction is exactly what the suspension handler
    /// needs to wait for.
    pub fn permit(&self) -> Permit<'_> {
        let mut state = self.lock();
        while state.suspended {
            state = self.resumed.wait(state).unwrap_or_else(|e| e.into_inner());
        }
        state.in_flight += 1;
        Permit { gate: self }
    }

    /// Close the gate and wait for in-flight work to finish. Returns
    /// whether it actually drained inside [`DRAIN_TIMEOUT`]; a `false`
    /// means the process is about to be suspended mid-write, which is
    /// worth a log line but is not something the caller can fix.
    #[cfg_attr(not(target_os = "ios"), allow(dead_code))]
    pub fn suspend(&self) -> bool {
        let deadline = Instant::now() + DRAIN_TIMEOUT;
        let mut state = self.lock();
        state.suspended = true;
        while state.in_flight > 0 {
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                return false;
            };
            let (next, timeout) = self
                .drained
                .wait_timeout(state, remaining)
                .unwrap_or_else(|e| e.into_inner());
            state = next;
            if timeout.timed_out() && state.in_flight > 0 {
                return false;
            }
        }
        true
    }

    /// Reopen the gate and wake everything parked in `permit`.
    #[cfg_attr(not(target_os = "ios"), allow(dead_code))]
    pub fn resume(&self) {
        let mut state = self.lock();
        state.suspended = false;
        drop(state);
        self.resumed.notify_all();
    }

    #[cfg(test)]
    fn is_suspended(&self) -> bool {
        self.lock().suspended
    }
}

/// The process-wide gate. Cheap enough to call on every drain.
pub fn gate() -> &'static SuspensionGate {
    static GATE: OnceLock<SuspensionGate> = OnceLock::new();
    GATE.get_or_init(SuspensionGate::new)
}

/// Start observing app-lifecycle transitions. No-op off iOS, where
/// nothing suspends the process out from under us.
#[cfg(not(target_os = "ios"))]
pub fn install(_db: crate::db::Db) {}

/// Start observing app-lifecycle transitions.
///
/// The notification names are spelled out rather than imported from
/// `objc2-ui-kit`: pulling UIKit in as a direct dependency means pinning
/// a version against the one Tauri already resolves for iOS, and getting
/// that wrong compiles two copies of a very large crate. They are stable
/// public constants, but a typo would fail silently — hence the log line
/// on every transition, which is how the wiring gets verified at all.
#[cfg(target_os = "ios")]
pub fn install(db: crate::db::Db) {
    use objc2_foundation::{NSNotificationCenter, NSOperationQueue, NSString};

    let center = NSNotificationCenter::defaultCenter();

    let enter_background = NSString::from_str("UIApplicationDidEnterBackgroundNotification");
    let will_foreground = NSString::from_str("UIApplicationWillEnterForegroundNotification");

    let suspend_block = block2::RcBlock::new(
        move |_: std::ptr::NonNull<objc2_foundation::NSNotification>| {
            let drained = gate().suspend();
            if drained {
                // Nothing is mid-write, so this is the one safe moment to
                // fold the WAL back into the main file. It does not release
                // the `-shm` lock — only closing the connection would — but
                // it does mean a process frozen here has no unflushed frames
                // to lose if iOS never wakes it again.
                //
                // `try_lock` rather than `lock`: the gate having drained says
                // no *background* worker holds the connection, not that a
                // command handler on another thread doesn't. Skipping the
                // checkpoint costs nothing; blocking the main thread during
                // the suspension window could cost the whole app.
                match db.conn.try_lock() {
                    Ok(conn) => {
                        if let Err(e) = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);") {
                            log::warn!("lifecycle: WAL checkpoint on suspend failed: {e}");
                        }
                    }
                    Err(_) => log::info!("lifecycle: write connection busy, skipping checkpoint"),
                }
                log::info!("lifecycle: background work quiesced before suspension");
            } else {
                log::warn!(
                    "lifecycle: background work still running after {}s — suspending anyway",
                    DRAIN_TIMEOUT.as_secs()
                );
            }
        },
    );

    let resume_block =
        block2::RcBlock::new(|_: std::ptr::NonNull<objc2_foundation::NSNotification>| {
            gate().resume();
            log::info!("lifecycle: foreground, background work released");
        });

    // A `None` queue runs the block synchronously on the thread that
    // posted the notification, which for these two is the main thread.
    // That is deliberate: blocking there is what holds the suspension
    // off while the drain finishes. Handing it to a queue instead would
    // let the process suspend before the block ever ran.
    let tokens = unsafe {
        [
            center.addObserverForName_object_queue_usingBlock(
                Some(&enter_background),
                None,
                None::<&NSOperationQueue>,
                &suspend_block,
            ),
            center.addObserverForName_object_queue_usingBlock(
                Some(&will_foreground),
                None,
                None::<&NSOperationQueue>,
                &resume_block,
            ),
        ]
    };
    // The observer tokens deregister themselves when dropped, and these
    // must outlive every caller. One deliberate leak per process.
    std::mem::forget(tokens);
    log::info!("lifecycle: observing app suspension");
}

#[cfg(test)]
mod tests {
    use super::SuspensionGate;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    /// The gate is open by default, so every non-iOS platform behaves
    /// exactly as it did before this module existed.
    #[test]
    fn permit_is_free_when_nothing_has_suspended() {
        let gate = SuspensionGate::new();
        let started = Instant::now();
        let _permit = gate.permit();
        assert!(started.elapsed() < Duration::from_millis(50));
        assert!(!gate.is_suspended());
    }

    /// The whole point: once the app is backgrounded a worker that comes
    /// looking for work does not get to start any.
    #[test]
    fn permit_parks_while_suspended_and_proceeds_after_resume() {
        let gate = Arc::new(SuspensionGate::new());
        assert!(
            gate.suspend(),
            "nothing in flight, so it drains immediately"
        );

        let started = Arc::new(AtomicUsize::new(0));
        let worker = {
            let gate = Arc::clone(&gate);
            let started = Arc::clone(&started);
            std::thread::spawn(move || {
                let _permit = gate.permit();
                started.fetch_add(1, Ordering::SeqCst);
            })
        };

        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(
            started.load(Ordering::SeqCst),
            0,
            "worker started work while the app was suspended"
        );

        gate.resume();
        worker.join().expect("worker panicked");
        assert_eq!(started.load(Ordering::SeqCst), 1);
    }

    /// Work that was already running when the user swiped away is waited
    /// for, not cut off.
    #[test]
    fn suspend_waits_for_in_flight_work() {
        let gate = Arc::new(SuspensionGate::new());
        let finished = Arc::new(AtomicUsize::new(0));

        let worker = {
            let gate = Arc::clone(&gate);
            let finished = Arc::clone(&finished);
            std::thread::spawn(move || {
                let _permit = gate.permit();
                std::thread::sleep(Duration::from_millis(150));
                finished.fetch_add(1, Ordering::SeqCst);
            })
        };

        // Let the worker take its permit before we try to suspend.
        std::thread::sleep(Duration::from_millis(30));
        assert!(gate.suspend(), "should have drained inside the timeout");
        assert_eq!(
            finished.load(Ordering::SeqCst),
            1,
            "suspend returned before in-flight work finished"
        );
        worker.join().expect("worker panicked");
    }

    /// A worker that panics mid-drain releases its permit and leaves the
    /// gate usable — a poisoned mutex here would freeze every background
    /// worker for the rest of the session.
    #[test]
    fn a_panicking_worker_does_not_wedge_the_gate() {
        let gate = Arc::new(SuspensionGate::new());
        let worker = {
            let gate = Arc::clone(&gate);
            std::thread::spawn(move || {
                let _permit = gate.permit();
                panic!("worker exploded");
            })
        };
        assert!(worker.join().is_err(), "the test worker was meant to panic");

        assert!(
            gate.suspend(),
            "the panicking worker's permit was not released"
        );
        gate.resume();
        let _permit = gate.permit();
    }
}

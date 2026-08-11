//! `NSMetadataQuery` over the app's ubiquity container, as a second wake-up
//! source for [`super::watcher`] (P5 item 3).
//!
//! **What this is for, measured rather than assumed.** The roadmap line that
//! asked for this said kqueue cannot see iCloud-initiated downloads. iOS does
//! not get kqueue: `notify 6.1.1` picks `RecommendedWatcher` by `target_os`,
//! and iOS matches none of its arms — linux, android, macos, windows, and the
//! four BSDs — so it falls through to `PollWatcher`. A poll *does* see an
//! iCloud download land, because it stats the directory rather than waiting to
//! be told. What it does not do is see it soon: `notify`'s default
//! `poll_interval` is 30 seconds. So the phone converges today; a highlight
//! made on the Mac just takes up to half a minute to appear.
//!
//! `NSMetadataQuery` is the OS telling us instead of us asking, which is worth
//! having for the latency alone. It is added **alongside** the poll rather
//! than replacing it, for one honest reason: none of this can be exercised
//! without a provisioned container on real hardware (P5 item 5), and a sync
//! mechanism that only runs where nobody can debug it is the wrong thing to
//! stake convergence on. If the query never fires, the phone behaves exactly
//! as it does now. If it fires, the same tick happens sooner.
//!
//! **iOS only.** On macOS the shared directory is reached by a constructed
//! path and the app claims no ubiquity container of its own (Q-005), so
//! `NSMetadataQueryUbiquitousDocumentsScope` would be scoped to nothing there;
//! macOS keeps FSEvents, which already reports these writes promptly.
//!
//! **Main thread.** `-[NSMetadataQuery startQuery]` is documented as
//! main-thread-only, and its notifications post on the thread that started it.
//! Both the start and the teardown are therefore dispatched onto the main
//! queue, which is also what makes the `thread_local!` below the right place
//! to keep the live query: only main-thread code ever touches it, and the two
//! dispatches run in FIFO order, so a teardown can never overtake its setup.

use std::sync::mpsc;

/// Handle for one live query. Dropping it stops the query and unregisters its
/// observers; `spawn` returning `None` (every non-iOS platform, or a failed
/// start) means the watcher simply runs on its `notify` source alone.
pub struct QueryHandle {
    #[cfg(target_os = "ios")]
    _private: (),
}

/// Send `signal()` on `tx` whenever the container changes.
///
/// `signal` is a plain fn pointer rather than a closure so this module never
/// has to know the caller's message type — the watcher's own wake enum stays
/// private to the watcher.
#[cfg(not(target_os = "ios"))]
pub fn spawn<T: Send + 'static>(_tx: mpsc::Sender<T>, _signal: fn() -> T) -> Option<QueryHandle> {
    None
}

#[cfg(target_os = "ios")]
pub fn spawn<T: Send + 'static>(tx: mpsc::Sender<T>, signal: fn() -> T) -> Option<QueryHandle> {
    ios::start(move || {
        let _ = tx.send(signal());
    });
    Some(QueryHandle { _private: () })
}

#[cfg(target_os = "ios")]
impl Drop for QueryHandle {
    fn drop(&mut self) {
        ios::stop();
    }
}

#[cfg(target_os = "ios")]
mod ios {
    use std::cell::RefCell;
    use std::ffi::c_void;
    use std::ptr::NonNull;
    use std::rc::Rc;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_foundation::{
        NSArray, NSMetadataQuery, NSMetadataQueryDidFinishGatheringNotification,
        NSMetadataQueryDidUpdateNotification, NSMetadataQueryUbiquitousDocumentsScope,
        NSNotification, NSNotificationCenter, NSPredicate,
    };

    /// How long `NSMetadataQuery` coalesces changes before posting an update.
    ///
    /// Matched to the watcher's own debounce: batching in the OS is strictly
    /// cheaper than batching after the notification has crossed into Rust, and
    /// a second layer of the same 250 ms would only add latency.
    const BATCHING_INTERVAL: f64 = 0.25;

    /// The live query, and the observer tokens that have to outlive it.
    ///
    /// Only ever touched from the main thread, which is why it can be a
    /// `thread_local!` holding non-`Send` `Retained`s instead of a static with
    /// a lock around it.
    struct Live {
        query: Retained<NSMetadataQuery>,
        /// Kept as `AnyObject` because that is all `removeObserver:` wants of
        /// them — the tokens are opaque and are never messaged otherwise.
        observers: Vec<Retained<AnyObject>>,
    }

    impl Drop for Live {
        fn drop(&mut self) {
            let center = NSNotificationCenter::defaultCenter();
            for observer in &self.observers {
                // SAFETY: every token here came from this same centre's
                // `addObserverForName:object:queue:usingBlock:`.
                unsafe { center.removeObserver(observer) };
            }
            self.query.stopQuery();
        }
    }

    thread_local! {
        static LIVE: RefCell<Option<Live>> = const { RefCell::new(None) };
    }

    // libdispatch. `_dispatch_main_q` is the main queue's global object; both
    // symbols come from libSystem, which is linked into every Apple binary, so
    // there is no `#[link]` attribute to add.
    extern "C" {
        static _dispatch_main_q: c_void;
        fn dispatch_async_f(
            queue: *const c_void,
            context: *mut c_void,
            work: extern "C" fn(*mut c_void),
        );
    }

    fn on_main(context: *mut c_void, work: extern "C" fn(*mut c_void)) {
        // SAFETY: `work` is a plain `extern "C" fn` and `context` is whatever
        // that function is written to reclaim — see the two callers below.
        unsafe { dispatch_async_f(&raw const _dispatch_main_q, context, work) };
    }

    /// The type erased at the module boundary: one call means "the container
    /// changed", and what the caller does with that is none of this module's
    /// business.
    type Notify = Box<dyn Fn() + Send + 'static>;

    pub fn start(notify: impl Fn() + Send + 'static) {
        let boxed: Notify = Box::new(notify);
        let context = Box::into_raw(Box::new(boxed)) as *mut c_void;
        on_main(context, start_on_main);
    }

    pub fn stop() {
        on_main(std::ptr::null_mut(), stop_on_main);
    }

    extern "C" fn stop_on_main(_context: *mut c_void) {
        // Dropping it is what stops the query — see `Live`'s `Drop`.
        LIVE.with(|live| live.borrow_mut().take());
    }

    extern "C" fn start_on_main(context: *mut c_void) {
        // SAFETY: `context` is the `Box<Notify>` leaked by `start`, and this
        // is the only place that reclaims it. `Rc` because both observer
        // blocks share the one callback and blocks are main-thread-only.
        let notify: Rc<Notify> = Rc::new(*unsafe { Box::from_raw(context as *mut Notify) });

        let query = NSMetadataQuery::new();
        // Everything in scope. The watcher's own `is_relevant_event` filter
        // exists to spare a `tick` on filesystem noise from Spotlight and
        // Finder previews; a metadata update inside our own container has no
        // such noise to filter, and a redundant tick is cheap — the engine's
        // watermarks make one that finds nothing nearly free.
        query.setPredicate(Some(&NSPredicate::predicateWithValue(true)));
        query.setNotificationBatchingInterval(BATCHING_INTERVAL);
        // SAFETY: the scope constant is the documented value for this setter,
        // and the array holds it alive for the duration of the call.
        unsafe {
            let scopes: Retained<NSArray> = Retained::cast_unchecked(NSArray::from_slice(&[
                &**NSMetadataQueryUbiquitousDocumentsScope,
            ]));
            query.setSearchScopes(&scopes);
        }

        let center = NSNotificationCenter::defaultCenter();
        let mut observers = Vec::with_capacity(2);
        for name in [
            // The first pass over the container. Without this the watcher
            // would learn nothing until something changed *after* launch.
            unsafe { NSMetadataQueryDidFinishGatheringNotification },
            unsafe { NSMetadataQueryDidUpdateNotification },
        ] {
            let notify = Rc::clone(&notify);
            let block = RcBlock::new(move |_notification: NonNull<NSNotification>| {
                // The callback swallows a closed channel: the watcher thread
                // being already gone is the ordinary shape of shutdown, with
                // the teardown dispatch right behind this one.
                notify();
            });
            // SAFETY: `name` is a Foundation notification-name constant, no
            // object filter is wanted, and a `None` queue is what delivers on
            // the posting thread — the main thread, where this query lives.
            let observer = unsafe {
                center.addObserverForName_object_queue_usingBlock(Some(name), None, None, &block)
            };
            // SAFETY: the token is an ordinary object; the cast only forgets
            // the protocol conformance this module never uses.
            observers.push(unsafe { Retained::cast_unchecked::<AnyObject>(observer) });
        }

        if !query.startQuery() {
            log::warn!("icloud metadata query refused to start; sync falls back to polling");
            for observer in &observers {
                // SAFETY: tokens from this same centre, registered just above.
                unsafe { center.removeObserver(observer) };
            }
            return;
        }

        // Replaces any previous query rather than stacking a second one — a
        // disable/enable cycle dispatches its teardown first, but a caller
        // that spawns twice without dropping would otherwise leak one.
        LIVE.with(|live| *live.borrow_mut() = Some(Live { query, observers }));
    }
}

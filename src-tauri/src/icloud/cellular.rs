//! D-016: on cellular, a book download asks once and remembers.
//!
//! `probe_book_availability_watched` calls [`enforce`] immediately before
//! `download::start_watch`, never after — `start_watch` asks iCloud
//! immediately, and once asked the bytes are already moving, so a prompt past
//! that point would be theatre. On Wi-Fi `enforce` always succeeds and the
//! flow is exactly what shipped before this file existed.
//!
//! What decides is a two-input truth table — is this connection cellular, and
//! what did the user say last time — kept as the pure [`decide`] function so
//! every cell of it is testable without a device, a network, or a database.
//! Everything else here is plumbing to get those two inputs: [`is_on_cellular`]
//! reads them from the OS, and [`enforce`] reads the remembered answer from
//! `settings` via `commands::settings::get_setting_value`.

use crate::commands::settings::get_setting_value;
use crate::db::Db;
use crate::error::{AppError, AppResult};

/// The `settings` row the remembered answer lives in. Absent means "ask" —
/// there is no separate boolean for "has this been asked before", the row's
/// existence *is* that boolean. Read and written like any other setting (see
/// `commands/settings.rs`); never anything in `secrets.db`, because it is a
/// preference, not a credential.
pub const SETTING_KEY: &str = "icloud_download_on_cellular";

/// Returned by `diagnose_book_file` in place of starting the download, when
/// the connection is cellular and there is nothing on file yet (or the file
/// says no). Mirrors the shape of `icloud::download`'s `BOOK_DOWNLOAD_*`
/// codes — a stable string the frontend matches on, never prose.
pub const ERROR_NEEDS_CELLULAR_CONSENT: &str = "BOOK_DOWNLOAD_NEEDS_CELLULAR_CONSENT";

/// The remembered answer, decoded from the settings row. Any stored value
/// other than the two recognised words reads as `Unset` rather than as an
/// error — a row a future version stops writing should fail open to "ask
/// again", not wedge the gate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CellularConsent {
    Unset,
    Allow,
    Deny,
}

impl CellularConsent {
    fn from_stored(value: Option<&str>) -> Self {
        match value {
            Some("allow") => Self::Allow,
            Some("deny") => Self::Deny,
            _ => Self::Unset,
        }
    }
}

/// What the gate decided.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CellularGateDecision {
    /// Wi-Fi, or cellular with a remembered "allow": behave exactly as the
    /// flow did before D-016 existed.
    Proceed,
    /// Cellular, and the remembered answer is either "deny" or nothing at
    /// all. The caller must not have started the download by this point —
    /// `Refuse` on an `Unset` answer is what turns into the first-time
    /// prompt, and `Refuse` on `Deny` is the same refusal replayed silently.
    Refuse,
}

/// The truth table itself, on-cellular × remembered-answer → proceed/refuse,
/// free of the database and of any OS call so it can run on any host.
pub fn decide(on_cellular: bool, consent: CellularConsent) -> CellularGateDecision {
    if !on_cellular {
        return CellularGateDecision::Proceed;
    }
    match consent {
        CellularConsent::Allow => CellularGateDecision::Proceed,
        CellularConsent::Unset | CellularConsent::Deny => CellularGateDecision::Refuse,
    }
}

/// Read reachability and the remembered answer, and enforce the result.
///
/// Called from `probe_book_availability_watched` right before
/// `download::start_watch`. `Ok(())` means proceed exactly as before;
/// `Err` carries [`ERROR_NEEDS_CELLULAR_CONSENT`] and the caller must not
/// have started the watch.
pub fn enforce(db: &Db) -> AppResult<()> {
    enforce_with(db, is_on_cellular())
}

/// The database half of `enforce`, with reachability injected so a test can
/// drive both branches on a host that is always "Wi-Fi" to `is_on_cellular`.
fn enforce_with(db: &Db, on_cellular: bool) -> AppResult<()> {
    let consent = CellularConsent::from_stored(get_setting_value(db, SETTING_KEY)?.as_deref());
    match decide(on_cellular, consent) {
        CellularGateDecision::Proceed => Ok(()),
        CellularGateDecision::Refuse => {
            Err(AppError::Other(ERROR_NEEDS_CELLULAR_CONSENT.to_string()))
        }
    }
}

/// True while the active route is cellular rather than Wi-Fi (or nothing).
///
/// iOS-only: `SCNetworkReachability`'s `kSCNetworkReachabilityFlagsIsWWAN` is
/// meaningless on a desktop, which has no cellular radio to report — Wi-Fi is
/// unaffected by design (see the module doc), and gating this at
/// `target_os = "ios"` rather than `target_vendor = "apple"` means macOS never
/// even asks the question.
#[cfg(target_os = "ios")]
pub use reachability::is_on_cellular;

#[cfg(not(target_os = "ios"))]
pub fn is_on_cellular() -> bool {
    false
}

/// The `SCNetworkReachability` binding.
///
/// No existing crate covers this: `Cargo.lock` resolves `system-configuration`
/// / `system-configuration-sys` (pulled in by `hyper-util`), but only under
/// `cfg(target_os = "macos")` in that crate's own `Cargo.toml` — they never
/// compile into an iOS target. There is no `objc2-system-configuration`
/// crate either (checked the same way `icloud.rs`'s module doc checked
/// `objc2-foundation` for the resource-key bindings). A minimal direct
/// `extern "C"` against the framework, mirroring Apple's own reachability
/// sample, is therefore the smallest correct option rather than a new
/// dependency for two functions.
#[cfg(target_os = "ios")]
mod reachability {
    use std::ffi::c_void;
    use std::mem;

    /// `kSCNetworkReachabilityFlagsIsWWAN`, from
    /// `SystemConfiguration/SCNetworkReachability.h`. Cellular is the only
    /// flag this module reads, so the rest of the bitmask is never named.
    const IS_WWAN: u32 = 0x0004_0000;

    /// Mirrors `struct sockaddr_in` from `<netinet/in.h>` — only the layout
    /// matters, the fields are never read back on the Rust side.
    #[repr(C)]
    struct SockAddrIn {
        sin_len: u8,
        sin_family: u8,
        sin_port: u16,
        sin_addr: u32,
        sin_zero: [u8; 8],
    }

    const AF_INET: u8 = 2;

    #[link(name = "SystemConfiguration", kind = "framework")]
    extern "C" {
        fn SCNetworkReachabilityCreateWithAddress(
            allocator: *const c_void,
            address: *const SockAddrIn,
        ) -> *const c_void;
        // `Boolean` in CoreFoundation headers is `unsigned char`, not `int`.
        fn SCNetworkReachabilityGetFlags(target: *const c_void, flags: *mut u32) -> u8;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(cf: *const c_void);
    }

    /// True while the active route is cellular.
    ///
    /// Follows Apple's own `Reachability` sample: asking about the zero
    /// address is the documented way to ask "how would the device reach the
    /// internet in general" without resolving a hostname or opening a socket.
    pub fn is_on_cellular() -> bool {
        unsafe {
            let mut address: SockAddrIn = mem::zeroed();
            address.sin_len = mem::size_of::<SockAddrIn>() as u8;
            address.sin_family = AF_INET;

            let target = SCNetworkReachabilityCreateWithAddress(std::ptr::null(), &address);
            if target.is_null() {
                return false;
            }

            let mut flags: u32 = 0;
            let ok = SCNetworkReachabilityGetFlags(target, &mut flags);
            CFRelease(target);

            ok != 0 && (flags & IS_WWAN) != 0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    // --- CellularConsent::from_stored ---

    #[test]
    fn no_row_reads_as_unset() {
        assert_eq!(CellularConsent::from_stored(None), CellularConsent::Unset);
    }

    #[test]
    fn the_two_recognised_words_decode() {
        assert_eq!(
            CellularConsent::from_stored(Some("allow")),
            CellularConsent::Allow
        );
        assert_eq!(
            CellularConsent::from_stored(Some("deny")),
            CellularConsent::Deny
        );
    }

    #[test]
    fn anything_else_fails_open_to_unset() {
        // A row a future version stops writing, or one that got corrupted,
        // must ask again rather than wedge the gate shut or open.
        assert_eq!(
            CellularConsent::from_stored(Some("")),
            CellularConsent::Unset
        );
        assert_eq!(
            CellularConsent::from_stored(Some("Allow")),
            CellularConsent::Unset
        );
        assert_eq!(
            CellularConsent::from_stored(Some("garbage")),
            CellularConsent::Unset
        );
    }

    // --- decide: the whole truth table ---

    #[test]
    fn wifi_always_proceeds_whatever_is_on_file() {
        for consent in [
            CellularConsent::Unset,
            CellularConsent::Allow,
            CellularConsent::Deny,
        ] {
            assert_eq!(decide(false, consent), CellularGateDecision::Proceed);
        }
    }

    #[test]
    fn cellular_with_nothing_on_file_asks() {
        assert_eq!(
            decide(true, CellularConsent::Unset),
            CellularGateDecision::Refuse
        );
    }

    #[test]
    fn cellular_with_a_remembered_allow_proceeds_silently() {
        assert_eq!(
            decide(true, CellularConsent::Allow),
            CellularGateDecision::Proceed
        );
    }

    #[test]
    fn cellular_with_a_remembered_deny_refuses_silently() {
        // Same refusal code as `Unset` — the frontend distinguishes "ask" from
        // "already said no" by whether it has a stored answer to show, not by
        // two different backend outcomes.
        assert_eq!(
            decide(true, CellularConsent::Deny),
            CellularGateDecision::Refuse
        );
    }

    // --- enforce_with: the settings-table wiring ---

    fn test_db() -> (TempDir, Db) {
        let dir = TempDir::new().unwrap();
        let db = Db::init(dir.path()).unwrap();
        (dir, db)
    }

    /// Writes the row directly rather than through `commands::settings`,
    /// which has no `pub(crate)` entry point for a single unsyncable key —
    /// only the webview-facing command and the sync-aware bulk writer, both
    /// of which pull in a `SyncWriter` for a detail this test does not care
    /// about. `enforce_with`/`get_setting_value` only ever read the row, so
    /// the row only has to exist, not have been written the "real" way.
    fn store_consent(db: &Db, value: &str) {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO settings (key, value, updated_at, updated_by_device)
             VALUES (?1, ?2, 0, '')
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            rusqlite::params![SETTING_KEY, value],
        )
        .unwrap();
    }

    #[test]
    fn wifi_proceeds_even_with_no_settings_row_at_all() {
        let (_dir, db) = test_db();
        assert!(enforce_with(&db, false).is_ok());
    }

    #[test]
    fn cellular_with_no_row_refuses_with_the_consent_code() {
        let (_dir, db) = test_db();
        let error = enforce_with(&db, true).unwrap_err();
        assert_eq!(error.to_string(), ERROR_NEEDS_CELLULAR_CONSENT);
    }

    #[test]
    fn cellular_after_allow_is_remembered_and_proceeds() {
        let (_dir, db) = test_db();
        store_consent(&db, "allow");
        assert!(enforce_with(&db, true).is_ok());
    }

    #[test]
    fn cellular_after_deny_is_remembered_and_keeps_refusing() {
        let (_dir, db) = test_db();
        store_consent(&db, "deny");
        let error = enforce_with(&db, true).unwrap_err();
        assert_eq!(error.to_string(), ERROR_NEEDS_CELLULAR_CONSENT);
    }

    #[test]
    fn the_setting_never_touches_secrets() {
        // The whole point of storing this in `settings` rather than
        // `secrets.db`: it is a preference, not a credential, and it is fine
        // for it to sync-eligible infrastructure to see (even though
        // `is_syncable_setting` keeps it local for now).
        assert_eq!(SETTING_KEY, "icloud_download_on_cellular");
        assert!(!crate::secrets::Secrets::is_sensitive_key(SETTING_KEY));
    }
}

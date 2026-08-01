//! Local scanned-PDF OCR data plane.
//!
//! Phase D deliberately contains no sync events, outbox writes, package
//! downloads, or production worker startup. Those remain gated by later
//! phases so a default build cannot publish schema-v7 state accidentally.

#![allow(dead_code)]

// Read half — ships on every platform. A scanned PDF is OCR'd on the desktop
// and syncs to the phone as a replacement asset; without `resolver` the phone
// would silently open the original un-OCR'd scan instead of the text layer it
// was given (docs/roadmap/mobile-ios.md, D-003). Both modules are plain SQLite
// reads over the assets table, so there is nothing platform-specific to gate.
pub(crate) mod assets;
pub(crate) mod resolver;

// Write half — desktop-only. This downloads a native OCR runtime and execs it,
// which iOS cannot do and App Store guideline 2.5.2 forbids outright, so it
// must not merely be hidden in the UI: it must not be in the binary.
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub(crate) mod backend;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub(crate) mod jobs;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub(crate) mod manager;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub(crate) mod package;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub(crate) mod publish;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub(crate) mod validate;

/// The production worker must remain disabled in default builds until the
/// Phase C release gates and the Phase G sync protocol land.
pub(crate) const PIPELINE_ENABLED: bool = cfg!(feature = "ocr-pipeline");

pub(crate) fn pipeline_enabled() -> bool {
    PIPELINE_ENABLED
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(not(feature = "ocr-pipeline"))]
    fn default_build_is_fail_closed() {
        assert!(!pipeline_enabled());
    }

    #[test]
    #[cfg(feature = "ocr-pipeline")]
    fn opt_in_build_reports_pipeline_capability() {
        assert!(pipeline_enabled());
    }
}

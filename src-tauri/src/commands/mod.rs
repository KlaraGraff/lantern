pub mod ai;
pub mod app;
pub mod bookmarks;
pub mod books;
pub mod chats;
pub mod collections;
pub mod dictionary;
pub mod fonts;
pub mod language_assessments;
pub mod lookup_history;
pub mod mcp;
pub mod notes;
pub mod oauth;
// Desktop-only by design: OCR runs where the scanner is, and the phone reads the
// result over sync (docs/roadmap/mobile-ios.md, D-003). The pipeline also
// downloads a native runtime and execs it, which iOS cannot do and App Store
// guideline 2.5.2 forbids outright — so this must not merely be hidden in the UI,
// it must not be in the binary.
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub mod ocr;
pub mod settings;
pub mod speech;
pub mod sync;
pub mod translation;
pub mod vocab;
pub mod word_marks;

pub mod ai;
pub mod annotations;
pub mod app;
pub mod bookmarks;
pub mod books;
pub mod chats;
pub mod collections;
pub mod dictionary;
pub mod enhanced_fonts;
pub mod fonts;
pub mod language_assessments;
pub mod lookup_history;
pub mod mcp;
pub mod notes;
pub mod oauth;
pub mod reading_stats;
// Split by platform *inside* the module, not here: the OCR *pipeline* is
// desktop-only, but the *resolver* that picks a book's active asset has to
// exist everywhere. See the cfgs in `ocr/mod.rs`.
pub mod ocr;
pub mod settings;
pub mod speech;
pub mod sync;
pub mod translation;
pub mod vocab;
pub mod word_marks;

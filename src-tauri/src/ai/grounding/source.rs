//! Where a book's readable text actually lives, and how to read it.
//!
//! Two unrelated features need the same answer to "given a `books` row, which
//! file on disk do I parse, and which content hash identifies that file":
//! the AI grounding index ([`super::index::ensure_index`]) and the local
//! book-difficulty preview (`commands::book_difficulty`). The difficulty
//! preview is a pure table lookup with no network anywhere in it, so it must
//! not be routed through the grounding index — a book whose owner never
//! turned on AI has no chunks and never would.
//!
//! The one branch that makes this worth sharing rather than copying is PDF:
//! a scanned PDF is transparently served from a verified OCR asset, and
//! picking that asset (plus its content hash) is
//! `commands::ocr::resolver::resolve_active_asset`'s job, not something a
//! second caller should reimplement.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use rusqlite::{params, OptionalExtension};

use super::extract::{extract_epub, extract_pdf, extract_text_book, SectionText};
use crate::commands::books::source_sha256;
use crate::db::Db;
use crate::error::{AppError, AppResult};

/// Source formats the extractors can read. A conversion book (mobi, azw3)
/// keeps its original `source_format`, so it is *not* in this list even
/// though a converted EPUB exists on disk — see the note in
/// [`resolve_book_source`].
const READABLE_FORMATS: [&str; 5] = ["epub", "pdf", "txt", "markdown", "html"];

/// A book's text source: the file to parse and the hash that identifies this
/// version of it.
#[derive(Debug, Clone)]
pub struct ResolvedSource {
    pub path: PathBuf,
    /// `source_format`, lowercased.
    pub format: String,
    /// `render_format` verbatim; `"text"` selects the prepared-document
    /// reader rather than parsing `path` directly.
    pub render_format: String,
    /// Content hash of what will actually be read: the OCR asset's hash for a
    /// PDF served from OCR, the stored hash otherwise, falling back to hashing
    /// the file. `None` only when every one of those came back empty.
    pub sha256: Option<String>,
}

/// The three answers [`resolve_book_source`] can give.
#[derive(Debug, Clone)]
pub enum BookSource {
    /// No such book.
    Missing,
    /// The book exists but no extractor can read its format.
    Unsupported {
        stored_sha256: Option<String>,
    },
    Ready(ResolvedSource),
}

/// Resolve `book_id` to the file its text should be read from.
///
/// A conversion book (mobi/azw3 rendered as EPUB) resolves to
/// `Unsupported`: its `source_format` stays `mobi`, and the converted EPUB
/// lives in the local cache under a path this function has never known
/// about. That is pre-existing grounding behaviour, preserved here
/// deliberately — changing it would change what `ensure_index` does.
pub fn resolve_book_source(db: &Db, book_id: &str) -> AppResult<BookSource> {
    let row = {
        let conn = db.reader();
        conn.query_row(
            "SELECT file_path, source_file_path, COALESCE(source_format, format),
                    COALESCE(render_format, format), source_sha256
             FROM books WHERE id = ?1",
            params![book_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            },
        )
        .optional()?
    };
    let Some((file_path, source_file_path, source_format, render_format, stored_sha256)) = row
    else {
        return Ok(BookSource::Missing);
    };

    let format = source_format.to_ascii_lowercase();
    if !READABLE_FORMATS.contains(&format.as_str()) {
        return Ok(BookSource::Unsupported { stored_sha256 });
    }

    let (path, resolved_sha256) = if format == "pdf" {
        let data_dir = db
            .data_dir
            .lock()
            .map_err(|error| AppError::Other(error.to_string()))?
            .clone();
        let resolved = {
            let conn = db.reader();
            crate::commands::ocr::resolver::resolve_active_asset(&conn, &data_dir, book_id)?
        };
        (resolved.absolute_path, resolved.content_sha256)
    } else {
        (
            db.resolve_path(source_file_path.as_deref().unwrap_or(&file_path))?,
            stored_sha256.clone(),
        )
    };

    let sha256 = resolved_sha256
        .filter(|hash| !hash.is_empty())
        .unwrap_or_else(|| {
            source_sha256(&path).unwrap_or_else(|_| stored_sha256.clone().unwrap_or_default())
        });

    Ok(BookSource::Ready(ResolvedSource {
        path,
        format,
        render_format,
        sha256: (!sha256.is_empty()).then_some(sha256),
    }))
}

/// [`resolve_book_source`] plus the one case grounding deliberately refuses:
/// a conversion book (mobi, azw3, fb2 …) whose converted EPUB is already
/// sitting in the local cache.
///
/// The difficulty preview wants this and the grounding index must not have
/// it. For grounding, indexing the converted artifact would move index state
/// for books `ensure_index` has always recorded `Unsupported`, and that state
/// machine is not this feature's to touch. For difficulty the calculus is the
/// opposite: the app is *rendering* that very EPUB on screen, so telling the
/// reader their book's format cannot be analysed is a claim they can see is
/// false.
///
/// The artifact's own existence is the proof that conversion ran, so no
/// separate format test is needed — and hashing the artifact rather than the
/// original means a `CONVERSION_VERSION` bump correctly reads as stale.
pub fn resolve_readable_source(db: &Db, book_id: &str) -> AppResult<BookSource> {
    let stored_sha256 = match resolve_book_source(db, book_id)? {
        BookSource::Unsupported { stored_sha256 } => stored_sha256,
        resolved => return Ok(resolved),
    };

    let local_dir = db
        .local_dir
        .lock()
        .map_err(|error| AppError::Other(error.to_string()))?
        .clone();
    if !crate::commands::books::converted_artifact_exists(&local_dir, book_id) {
        return Ok(BookSource::Unsupported { stored_sha256 });
    }

    let path = crate::commands::books::converted_document_path(&local_dir, book_id);
    let sha256 = source_sha256(&path)
        .ok()
        .filter(|hash| !hash.is_empty())
        .or(stored_sha256);

    Ok(BookSource::Ready(ResolvedSource {
        path,
        format: "epub".to_string(),
        render_format: "epub".to_string(),
        sha256,
    }))
}

impl ResolvedSource {
    /// The hash as a string, empty when unknown — the form the extractors and
    /// the index state row have always used.
    pub fn sha256_or_empty(&self) -> &str {
        self.sha256.as_deref().unwrap_or_default()
    }
}

/// Parse the resolved source into sections. Pure parsing: no network, no
/// derived-table reads beyond the prepared document a text book was imported
/// into.
///
/// Callers that ask for the same file at the same time share one parse. This
/// is not a cache — nothing survives the last concurrent caller returning —
/// it exists because finishing an import fires the grounding index and the
/// difficulty preview onto the blocking pool in the same breath, and both
/// land here on the same file within microseconds of each other. Reading a
/// novel twice is merely wasteful; for a PDF it is worse, because the two
/// then queue up behind `crate::pdfium`'s exclusive lock and the second parse
/// is pure added latency before the shelf stops saying "analyzing".
pub fn extract_source_text(
    db: &Db,
    book_id: &str,
    source: &ResolvedSource,
) -> AppResult<Vec<SectionText>> {
    let key = format!(
        "{book_id}\u{0}{}\u{0}{}",
        source.sha256_or_empty(),
        source.path.display()
    );
    let slot = claim(&key);

    // Whoever gets the lock first does the parse; anyone else blocks here and
    // reads the answer out. A leader that panics poisons the lock, and
    // `into_inner` lets the next caller find `None` and parse it themselves
    // rather than inheriting a wedged slot.
    let mut cell = slot.lock().unwrap_or_else(|poison| poison.into_inner());
    if let Some(shared) = cell.as_ref() {
        return clone_out(shared);
    }

    let outcome = parse(db, book_id, source);
    // Retire the slot before the lock is released: callers already holding an
    // `Arc` to it still get this result, while anyone arriving afterwards
    // starts a fresh parse instead of being served text of unknown age.
    retire(&key, &slot);
    if Arc::strong_count(&slot) == 1 {
        // Retired, and the only reference left is this one — no caller is
        // waiting and none can still arrive. The uncontended path, which is
        // most of them, therefore hands back the sections it just parsed
        // without paying for a copy or flattening the error type.
        return outcome;
    }
    let shared = cell.insert(outcome.map(Arc::new).map_err(|error| error.to_string()));
    clone_out(shared)
}

fn parse(db: &Db, book_id: &str, source: &ResolvedSource) -> AppResult<Vec<SectionText>> {
    match source.format.as_str() {
        "txt" | "markdown" | "html" if source.render_format == "text" => {
            extract_text_book(db, book_id, Some(source.sha256_or_empty()))
        }
        "pdf" => extract_pdf(&source.path),
        _ => extract_epub(&source.path),
    }
}

/// One in-flight parse. `None` until the leader finishes.
///
/// The failure side is a `String` rather than an `AppError` because sharing
/// requires cloning and `AppError` is not `Clone`. Both callers only ever read
/// the message — `ensure_index` stores it and tests it for
/// `PDF_TEXT_LAYER_UNAVAILABLE` — so the round trip through `AppError::Other`
/// is lossless where it counts.
type Slot = Mutex<Option<Result<Arc<Vec<SectionText>>, String>>>;

static IN_FLIGHT: OnceLock<Mutex<HashMap<String, Arc<Slot>>>> = OnceLock::new();

fn in_flight() -> &'static Mutex<HashMap<String, Arc<Slot>>> {
    IN_FLIGHT.get_or_init(|| Mutex::new(HashMap::new()))
}

fn claim(key: &str) -> Arc<Slot> {
    let mut map = in_flight()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    map.entry(key.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(None)))
        .clone()
}

fn retire(key: &str, slot: &Arc<Slot>) {
    let mut map = in_flight()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    // Only if it is still *this* slot: a caller that arrived after an earlier
    // retire may already have installed a newer one for the same key.
    if map.get(key).is_some_and(|current| Arc::ptr_eq(current, slot)) {
        map.remove(key);
    }
}

fn clone_out(shared: &Result<Arc<Vec<SectionText>>, String>) -> AppResult<Vec<SectionText>> {
    match shared {
        Ok(sections) => Ok(sections.as_ref().clone()),
        Err(message) => Err(AppError::Other(message.clone())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn insert_book(db: &Db, format: &str, render_format: &str) {
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO books (
                     id, title, author, file_path, source_format, render_format,
                     source_file_path, source_sha256, status, progress, created_at, updated_at
                 ) VALUES ('book', 'Book', 'Author', 'books/book.epub', ?1, ?2,
                           'books/book.epub', 'source-a', 'unread', 0, 1, 1)",
                params![format, render_format],
            )
            .unwrap();
    }

    #[test]
    fn a_book_that_does_not_exist_is_missing() {
        let directory = tempfile::TempDir::new().unwrap();
        let db = Db::init(directory.path()).unwrap();
        assert!(matches!(
            resolve_book_source(&db, "nope").unwrap(),
            BookSource::Missing
        ));
    }

    #[test]
    fn a_conversion_source_format_is_unsupported() {
        let directory = tempfile::TempDir::new().unwrap();
        let db = Db::init(directory.path()).unwrap();
        insert_book(&db, "mobi", "epub");
        let BookSource::Unsupported { stored_sha256 } = resolve_book_source(&db, "book").unwrap()
        else {
            panic!("mobi is not a readable source format");
        };
        assert_eq!(stored_sha256.as_deref(), Some("source-a"));
    }

    /// The difficulty preview parts company with grounding here: grounding
    /// still refuses the book, the reader-facing path reads the EPUB the app
    /// is already rendering.
    #[test]
    fn a_converted_artifact_is_readable_even_though_grounding_refuses_it() {
        let directory = tempfile::TempDir::new().unwrap();
        let db = Db::init(directory.path()).unwrap();
        insert_book(&db, "mobi", "epub");

        // No artifact yet: both callers agree it cannot be read.
        assert!(matches!(
            resolve_readable_source(&db, "book").unwrap(),
            BookSource::Unsupported { .. }
        ));

        let local_dir = db.local_dir.lock().unwrap().clone();
        let converted = crate::commands::books::converted_document_path(&local_dir, "book");
        std::fs::create_dir_all(converted.parent().unwrap()).unwrap();
        std::fs::write(&converted, b"not a real epub, but a non-empty file").unwrap();

        let BookSource::Ready(source) = resolve_readable_source(&db, "book").unwrap() else {
            panic!("a converted artifact on disk is readable");
        };
        assert_eq!(source.path, converted);
        assert_eq!(source.format, "epub");
        // Hashed from the artifact, not inherited from the mobi, so bumping
        // CONVERSION_VERSION reads as stale rather than as unchanged.
        assert_ne!(source.sha256.as_deref(), Some("source-a"));

        // Grounding is untouched by any of this.
        assert!(matches!(
            resolve_book_source(&db, "book").unwrap(),
            BookSource::Unsupported { .. }
        ));
    }

    fn section(title: &str) -> SectionText {
        SectionText {
            section_index: 0,
            section_href: None,
            section_title: Some(title.to_string()),
            blocks: Vec::new(),
        }
    }

    /// Import fires the grounding index and the difficulty preview at the
    /// same file microseconds apart. The second one to arrive waits for the
    /// first parse instead of starting its own.
    #[test]
    fn callers_racing_on_one_file_share_a_single_parse() {
        let key = "book\u{0}hash-a\u{0}/books/book.epub";
        let leader = claim(key);
        let follower = claim(key);
        assert!(Arc::ptr_eq(&leader, &follower));

        let mut parsing = leader.lock().unwrap();
        let waiting = std::thread::spawn(move || {
            let done = follower.lock().unwrap_or_else(|poison| poison.into_inner());
            clone_out(done.as_ref().expect("the leader published a result"))
        });

        retire(key, &leader);
        *parsing = Some(Ok(Arc::new(vec![section("Chapter 1")])));
        drop(parsing);

        let shared = waiting.join().unwrap().unwrap();
        assert_eq!(shared.len(), 1);
        assert_eq!(shared[0].section_title.as_deref(), Some("Chapter 1"));

        // Nothing is cached: the next caller re-reads rather than being
        // served text of unknown age.
        let later = claim(key);
        assert!(!Arc::ptr_eq(&later, &leader));
        assert!(later.lock().unwrap().is_none());
        retire(key, &later);
    }

    /// A failed parse is shared too — for a PDF the failure only comes back
    /// *after* a full read, so re-running it is the expensive case, not the
    /// cheap one. `AppError` cannot be cloned, so the message round-trips
    /// through a string; the substring `ensure_index` keys off must survive.
    #[test]
    fn a_shared_failure_keeps_the_message_callers_match_on() {
        let shared = Err("PDF_TEXT_LAYER_UNAVAILABLE".to_string());
        let error = clone_out(&shared).unwrap_err();
        assert!(error.to_string().contains("PDF_TEXT_LAYER_UNAVAILABLE"));
    }

    /// Two different books resolve to two different parses, obviously — but
    /// so do two versions of one book, because the hash is part of the key.
    /// An OCR rerun must not be served the pre-OCR text.
    #[test]
    fn a_new_content_hash_is_a_different_parse() {
        let before = claim("book\u{0}hash-a\u{0}/books/book.pdf");
        let after = claim("book\u{0}hash-b\u{0}/books/book.pdf");
        let other = claim("other\u{0}hash-a\u{0}/books/other.pdf");
        assert!(!Arc::ptr_eq(&before, &after));
        assert!(!Arc::ptr_eq(&before, &other));
        retire("book\u{0}hash-a\u{0}/books/book.pdf", &before);
        retire("book\u{0}hash-b\u{0}/books/book.pdf", &after);
        retire("other\u{0}hash-a\u{0}/books/other.pdf", &other);
    }

    #[test]
    fn a_readable_book_keeps_its_stored_hash_and_resolves_a_path() {
        let directory = tempfile::TempDir::new().unwrap();
        let db = Db::init(directory.path()).unwrap();
        insert_book(&db, "EPUB", "epub");
        let BookSource::Ready(source) = resolve_book_source(&db, "book").unwrap() else {
            panic!("epub is readable");
        };
        assert_eq!(source.format, "epub");
        assert_eq!(source.sha256.as_deref(), Some("source-a"));
        assert!(source.path.ends_with("books/book.epub"));
    }
}

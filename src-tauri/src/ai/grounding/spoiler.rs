use rusqlite::{params, Connection, OptionalExtension};

use super::retrieve::SpoilerCutoff;
use crate::db::Db;
use crate::error::AppResult;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SpoilerResolution {
    pub active: bool,
    pub cutoff: Option<SpoilerCutoff>,
    pub progress: i32,
}

pub(crate) fn parse_text_offset(value: &str) -> Option<i64> {
    if let Some(rest) = value.strip_prefix("textloc:v2:") {
        return rest.split(':').next()?.parse::<i64>().ok();
    }
    value.strip_prefix("textloc:")?.parse::<i64>().ok()
}

pub(crate) fn parse_spine_section(value: &str) -> Option<i64> {
    let prefix = value.strip_prefix("epubcfi(/6/")?;
    let number = prefix
        .split(|character: char| !character.is_ascii_digit())
        .next()?
        .parse::<i64>()
        .ok()?;
    (number >= 2 && number % 2 == 0).then_some(number / 2 - 1)
}

pub(crate) fn cutoff_for_position(render_format: &str, current_cfi: Option<&str>) -> SpoilerCutoff {
    let current_cfi = current_cfi.unwrap_or_default();
    if render_format == "text" {
        SpoilerCutoff::Character(parse_text_offset(current_cfi).unwrap_or(0).max(0))
    } else {
        SpoilerCutoff::Section(parse_spine_section(current_cfi).unwrap_or(0).max(0))
    }
}

fn normalize_for_match(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Pure: locate which chunk contains the START of `visible_context` inside
/// `chunks` (chunk_index, text pairs, ordered by chunk_index and belonging
/// to one section), matching after whitespace normalization because the
/// reader's live-extracted text and the indexer's stored text can disagree
/// on whitespace. Returns `None` when `visible_context` is empty or cannot
/// be found — callers must fall back to their own conservative or permissive
/// default rather than treating "not found" as "nothing to hide."
pub(crate) fn locate_visible_context_chunk(
    chunks: &[(i64, String)],
    visible_context: &str,
) -> Option<i64> {
    let needle = normalize_for_match(visible_context);
    if needle.is_empty() {
        return None;
    }
    let mut haystack = String::new();
    let mut chunk_offsets = Vec::with_capacity(chunks.len());
    for (chunk_index, text) in chunks {
        chunk_offsets.push((haystack.len(), *chunk_index));
        if !haystack.is_empty() {
            haystack.push(' ');
        }
        haystack.push_str(&normalize_for_match(text));
    }
    let match_start = haystack.find(&needle)?;
    chunk_offsets
        .iter()
        .rev()
        .find(|(start, _)| *start <= match_start)
        .map(|(_, chunk_index)| *chunk_index)
}

pub(crate) fn section_chunk_texts(
    conn: &Connection,
    book_id: &str,
    section: i64,
) -> rusqlite::Result<Vec<(i64, String)>> {
    conn.prepare(
        "SELECT chunk_index, text FROM book_chunks WHERE book_id = ?1 AND section_index = ?2 ORDER BY chunk_index",
    )?
    .query_map(params![book_id, section], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
    })?
    .collect()
}

/// Locate the chunk containing the start of `visible_context` within
/// `section`'s own indexed chunks. Shared by `ai_xray` (which then keeps its
/// own conservative whole-section fallback) and `resolve_chat_cutoff` (which
/// falls back to the permissive `Section` cutoff instead). Returns `None`
/// when there is no usable `visible_context`, the section has no indexed
/// chunks, or the text cannot be located (stale index, extraction drift, or
/// text that genuinely isn't in this section).
pub(crate) fn locate_section_chunk_index(
    conn: &Connection,
    book_id: &str,
    section: i64,
    visible_context: Option<&str>,
) -> Option<i64> {
    let visible_context = visible_context
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let chunks = section_chunk_texts(conn, book_id, section).ok()?;
    locate_visible_context_chunk(&chunks, visible_context)
}

struct BookPosition {
    render_format: String,
    current_cfi: Option<String>,
    progress: i32,
}

fn read_book_position(conn: &Connection, book_id: &str) -> AppResult<Option<BookPosition>> {
    Ok(conn
        .query_row(
            "SELECT COALESCE(render_format, format), current_cfi, progress FROM books WHERE id = ?1",
            params![book_id],
            |row| {
                Ok(BookPosition {
                    render_format: row.get(0)?,
                    current_cfi: row.get(1)?,
                    progress: row.get(2)?,
                })
            },
        )
        .optional()?)
}

/// Whether the spoiler guard applies to `book_id`: the global
/// `ai_spoiler_guard` setting, overridable per book. Shared by
/// `resolve_cutoff` and `resolve_chat_cutoff` so their enablement rule can't
/// drift apart.
fn guard_enabled(conn: &Connection, book_id: &str) -> AppResult<bool> {
    let global_enabled = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'ai_spoiler_guard'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .map(|value| value != "false")
        .unwrap_or(true);
    let override_key = format!("book_spoiler_guard_{book_id}");
    let book_override = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![override_key],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    Ok(match book_override.as_deref() {
        Some("on") => true,
        Some("off") => false,
        _ => global_enabled,
    })
}

pub fn resolve_cutoff(db: &Db, book_id: &str) -> AppResult<SpoilerResolution> {
    let conn = db.reader();
    let enabled = guard_enabled(&conn, book_id)?;
    Ok(match read_book_position(&conn, book_id)? {
        Some(position) if enabled => SpoilerResolution {
            active: true,
            cutoff: Some(cutoff_for_position(
                &position.render_format,
                position.current_cfi.as_deref(),
            )),
            progress: position.progress.clamp(0, 100),
        },
        Some(position) => SpoilerResolution {
            active: false,
            cutoff: None,
            progress: position.progress.clamp(0, 100),
        },
        None => SpoilerResolution {
            active: false,
            cutoff: None,
            progress: 0,
        },
    })
}

/// Chat's entry point for resolving the spoiler cutoff: same enablement and
/// position lookup as `resolve_cutoff`, but for EPUB additionally tries to
/// tighten a whole-chapter `Section` cutoff down to a `SectionPrefix`
/// bounded at the chunk containing `viewport_text` — the text the reader's
/// screen is currently showing, captured client-side at send time. This is
/// the same technique `ai_xray` uses (see `commands/ai/xray.rs`), reused
/// here rather than duplicated via `locate_section_chunk_index`.
///
/// Unlike xray, which fails closed to a stricter whole-section exclusion
/// when it cannot locate the text (it has no query of its own to fall back
/// on beyond a single entity), chat keeps its existing `Section` cutoff —
/// today's permissive chapter-level behavior — whenever the tightening
/// can't be made: non-EPUB formats, no viewport text, or text that can't be
/// located in the current section's indexed chunks. A retrieval query still
/// guards every chat answer, so under-locating here should not additionally
/// punish the user by hiding the whole chapter.
///
/// Only `Section` cutoffs are ever narrowed; `Character` (txt/PDF) passes
/// through unchanged, since it is already exact.
pub fn resolve_chat_cutoff(
    db: &Db,
    book_id: &str,
    viewport_text: Option<&str>,
) -> AppResult<SpoilerResolution> {
    let conn = db.reader();
    let enabled = guard_enabled(&conn, book_id)?;
    let Some(position) = read_book_position(&conn, book_id)? else {
        return Ok(SpoilerResolution {
            active: false,
            cutoff: None,
            progress: 0,
        });
    };
    if !enabled {
        return Ok(SpoilerResolution {
            active: false,
            cutoff: None,
            progress: position.progress.clamp(0, 100),
        });
    }
    let mut cutoff = cutoff_for_position(&position.render_format, position.current_cfi.as_deref());
    if position.render_format == "epub" {
        if let SpoilerCutoff::Section(section) = cutoff {
            if let Some(chunk_index) =
                locate_section_chunk_index(&conn, book_id, section, viewport_text)
            {
                cutoff = SpoilerCutoff::SectionPrefix {
                    section,
                    chunk_index,
                };
            }
        }
    }
    Ok(SpoilerResolution {
        active: true,
        cutoff: Some(cutoff),
        progress: position.progress.clamp(0, 100),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn parses_text_epub_and_pdf_locations() {
        assert_eq!(
            cutoff_for_position("text", Some("textloc:v2:12345:12350")),
            SpoilerCutoff::Character(12345)
        );
        assert_eq!(
            cutoff_for_position("epub", Some("epubcfi(/6/8!/4/2:9)")),
            SpoilerCutoff::Section(3)
        );
        assert_eq!(
            cutoff_for_position("pdf", Some("epubcfi(/6/12)")),
            SpoilerCutoff::Section(5)
        );
        assert_eq!(cutoff_for_position("epub", None), SpoilerCutoff::Section(0));
    }

    #[test]
    fn locates_visible_context_within_a_single_chunk() {
        let chunks = vec![
            (0_i64, "Alice walked into the room.".to_string()),
            (1_i64, "She smiled and sat down.".to_string()),
            (2_i64, "Bob was already there.".to_string()),
        ];
        assert_eq!(
            locate_visible_context_chunk(&chunks, "She smiled and sat down."),
            Some(1)
        );
    }

    #[test]
    fn locates_visible_context_after_whitespace_normalization() {
        let chunks = vec![
            (0_i64, "Alice walked into the room.".to_string()),
            (1_i64, "She   smiled\nand  sat down.".to_string()),
        ];
        // The reader's extracted snippet uses different whitespace than the
        // indexer's stored chunk text; normalization must still match.
        assert_eq!(
            locate_visible_context_chunk(&chunks, "She smiled and sat down."),
            Some(1)
        );
    }

    #[test]
    fn locate_visible_context_uses_the_start_of_the_match_to_pick_the_chunk() {
        let chunks = vec![
            (0_i64, "...she stepped into the room.".to_string()),
            (1_i64, "Bob turned to greet her.".to_string()),
        ];
        // The needle spans the chunk boundary; it starts inside chunk 0, so
        // chunk 0 is the containing chunk even though the match tails into
        // chunk 1's text.
        assert_eq!(
            locate_visible_context_chunk(&chunks, "the room. Bob turned"),
            Some(0)
        );
    }

    #[test]
    fn locate_visible_context_returns_none_when_absent_or_empty() {
        let chunks = vec![(0_i64, "Alice walked into the room.".to_string())];
        assert_eq!(
            locate_visible_context_chunk(&chunks, "a phrase that is not here"),
            None
        );
        assert_eq!(locate_visible_context_chunk(&chunks, "   "), None);
        assert_eq!(locate_visible_context_chunk(&[], "anything"), None);
    }

    fn test_db() -> (TempDir, Db) {
        let dir = TempDir::new().unwrap();
        let db = Db::init(dir.path()).unwrap();
        (dir, db)
    }

    fn insert_book(db: &Db, book_id: &str, render_format: &str, current_cfi: Option<&str>) {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO books
                 (id, title, author, file_path, format, render_format, current_cfi, progress,
                  created_at, updated_at)
             VALUES (?1, 'Title', 'Author', '/tmp/book', ?2, ?2, ?3, 0, '2024-01-01', '2024-01-01')",
            params![book_id, render_format, current_cfi],
        )
        .unwrap();
    }

    fn insert_chunk(db: &Db, book_id: &str, section: i64, chunk_index: i64, text: &str) {
        let conn = db.conn.lock().unwrap();
        let id = format!("{book_id}-c{section}-{chunk_index}");
        conn.execute(
            "INSERT INTO book_chunks
                 (id, book_id, chunk_index, section_index, section_href, section_title,
                  char_start, char_end, text, snippet, token_estimate, created_at)
             VALUES (?1, ?2, ?3, ?4, NULL, 'Chapter', NULL, NULL, ?5, ?5, 20, 0)",
            params![id, book_id, chunk_index, section, text],
        )
        .unwrap();
    }

    #[test]
    fn chat_cutoff_tightens_an_epub_section_to_the_located_chunk() {
        let (_dir, db) = test_db();
        insert_book(&db, "book", "epub", Some("epubcfi(/6/8!/4/2:9)"));
        insert_chunk(&db, "book", 3, 10, "Alice arrived at the manor.");
        insert_chunk(&db, "book", 3, 11, "She began to explore the halls.");
        insert_chunk(&db, "book", 3, 12, "Something moved in the shadows.");

        let resolution =
            resolve_chat_cutoff(&db, "book", Some("began to explore the halls")).unwrap();
        assert!(resolution.active);
        assert_eq!(
            resolution.cutoff,
            Some(SpoilerCutoff::SectionPrefix {
                section: 3,
                chunk_index: 11
            })
        );
    }

    #[test]
    fn chat_cutoff_falls_back_to_the_permissive_section_when_unlocatable() {
        let (_dir, db) = test_db();
        insert_book(&db, "book", "epub", Some("epubcfi(/6/8!/4/2:9)"));
        insert_chunk(&db, "book", 3, 10, "Alice arrived at the manor.");
        insert_chunk(&db, "book", 3, 11, "She began to explore the halls.");

        // No viewport text at all.
        assert_eq!(
            resolve_chat_cutoff(&db, "book", None).unwrap().cutoff,
            Some(SpoilerCutoff::Section(3))
        );
        // Viewport text supplied but does not match anything indexed in the
        // section — falling back to `Section` (not xray's stricter
        // whole-section exclusion) keeps chat's existing, wider context.
        assert_eq!(
            resolve_chat_cutoff(&db, "book", Some("a sentence that was never indexed"))
                .unwrap()
                .cutoff,
            Some(SpoilerCutoff::Section(3))
        );
        // The section has no indexed chunks at all.
        insert_book(&db, "empty-section", "epub", Some("epubcfi(/6/2!/4/2:9)"));
        assert_eq!(
            resolve_chat_cutoff(&db, "empty-section", Some("anything"))
                .unwrap()
                .cutoff,
            Some(SpoilerCutoff::Section(0))
        );
    }

    #[test]
    fn chat_cutoff_never_tightens_non_epub_formats() {
        let (_dir, db) = test_db();
        insert_book(&db, "text-book", "text", Some("textloc:v2:100:105"));
        insert_chunk(
            &db,
            "text-book",
            0,
            0,
            "Some text on this text-format page.",
        );
        assert_eq!(
            resolve_chat_cutoff(
                &db,
                "text-book",
                Some("Some text on this text-format page.")
            )
            .unwrap()
            .cutoff,
            Some(SpoilerCutoff::Character(100))
        );

        let (_dir2, db2) = test_db();
        insert_book(&db2, "pdf-book", "pdf", Some("epubcfi(/6/8!/4/2:9)"));
        insert_chunk(&db2, "pdf-book", 3, 10, "Alice arrived at the manor.");
        assert_eq!(
            resolve_chat_cutoff(&db2, "pdf-book", Some("Alice arrived at the manor."))
                .unwrap()
                .cutoff,
            Some(SpoilerCutoff::Section(3))
        );
    }

    #[test]
    fn chat_cutoff_respects_the_spoiler_guard_being_off() {
        let (_dir, db) = test_db();
        insert_book(&db, "book", "epub", Some("epubcfi(/6/8!/4/2:9)"));
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO settings (key, value) VALUES ('ai_spoiler_guard', 'false')
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [],
            )
            .unwrap();
        }
        let resolution = resolve_chat_cutoff(&db, "book", Some("anything")).unwrap();
        assert!(!resolution.active);
        assert_eq!(resolution.cutoff, None);
    }
}

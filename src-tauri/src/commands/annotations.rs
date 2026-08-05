//! One timeline for everything the reader marked in a book.
//!
//! Highlights and notes grew up in separate tables: a highlight is a coloured
//! range (`highlights`), a note is written text (`notes`). A passage that was
//! only highlighted had no page of its own outside the book it lives in. This
//! module unions the two into a single ordered feed and folds the pair that
//! describe *the same anchor* into one item.
//!
//! The join key is exact string equality between `highlights.cfi_range` and
//! `notes.location`, compared as an opaque string. Anchor formats differ by
//! book format (EPUB CFI vs text offsets); nothing here parses them, and the
//! `book_id` must match too, so an identical string in two different books
//! stays two items.

use rusqlite::{params, Row};
use serde::Serialize;
use tauri::State;

use crate::db::{sqlite_contains_pattern, Db};
use crate::error::{AppError, AppResult};

/// One anchor's worth of marking: a highlight, a note, or a highlight that
/// has a note written on it.
#[derive(Debug, Clone, Serialize)]
pub struct Annotation {
    /// Stable list key. `h:<highlight id>` or `n:<note id>` — also the
    /// pagination tie-break, so it must sort deterministically.
    pub id: String,
    pub highlight_id: Option<String>,
    pub note_id: Option<String>,
    pub book_id: Option<String>,
    pub book_title: Option<String>,
    pub anchor_kind: String,
    pub normalized_word: Option<String>,
    pub scope: String,
    pub location: Option<String>,
    /// The quoted passage: the highlight's captured text, or the note's.
    pub selected_text: Option<String>,
    pub color: Option<String>,
    pub content: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Pill-row counts. Computed over the search / book / date filters but
/// *ignoring* the type filter, so switching type never rewrites the numbers
/// the user is choosing between.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct AnnotationCounts {
    pub all: usize,
    pub highlights: usize,
    pub with_notes: usize,
    pub words: usize,
    pub selections: usize,
    pub bare_highlights: usize,
}

#[derive(Debug, Serialize)]
pub struct AnnotationPage {
    pub annotations: Vec<Annotation>,
    pub next_cursor: Option<String>,
    /// Items matching every filter, type included.
    pub total: usize,
    /// How many of those are highlights nobody has written on.
    pub bare_highlights: usize,
    pub counts: AnnotationCounts,
}

/// Type-filter tokens accepted by `list_annotations`.
const KINDS: [&str; 4] = ["highlight", "with_note", "word", "selection"];

/// The union, as a CTE. `folded` picks at most one note per anchor (the most
/// recently updated one) so a highlight can never fan out into several rows;
/// any extra note at the same anchor falls through to the second arm and
/// stays a separate item rather than disappearing.
const ITEMS_CTE: &str = "
WITH folded AS (
  SELECT id, book_id, location, content, selected_text, scope, created_at, updated_at
  FROM (
    SELECT n.id, n.book_id, n.location, n.content, n.selected_text, n.scope,
           n.created_at, n.updated_at,
           ROW_NUMBER() OVER (
             PARTITION BY n.book_id, n.location
             ORDER BY n.updated_at DESC, n.id DESC
           ) AS rn
    FROM notes n
    WHERE n.anchor_kind = 'selection'
      AND n.book_id IS NOT NULL
      AND n.location IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM highlights h
        WHERE h.book_id = n.book_id AND h.cfi_range = n.location
      )
  )
  WHERE rn = 1
),
items AS (
  SELECT
    'h:' || h.id AS id,
    h.id AS highlight_id,
    f.id AS note_id,
    h.book_id AS book_id,
    'selection' AS anchor_kind,
    NULL AS normalized_word,
    COALESCE(f.scope, 'book') AS scope,
    h.cfi_range AS location,
    COALESCE(h.text_content, f.selected_text) AS selected_text,
    h.color AS color,
    f.content AS content,
    MIN(h.created_at, COALESCE(f.created_at, h.created_at)) AS created_at,
    MAX(h.updated_at, COALESCE(f.updated_at, h.updated_at)) AS updated_at
  FROM highlights h
  LEFT JOIN folded f ON f.book_id = h.book_id AND f.location = h.cfi_range
  UNION ALL
  SELECT
    'n:' || n.id,
    NULL,
    n.id,
    n.book_id,
    n.anchor_kind,
    n.normalized_word,
    n.scope,
    n.location,
    n.selected_text,
    NULL,
    n.content,
    n.created_at,
    n.updated_at
  FROM notes n
  WHERE n.id NOT IN (SELECT id FROM folded)
)
";

/// Search / book / date predicates. Bound as `?1` book, `?2` pattern,
/// `?3` updated_after, `?4` updated_before.
const SCOPE_FILTER: &str = "
  (?1 IS NULL OR i.book_id = ?1)
  AND (?2 IS NULL
       OR LOWER(COALESCE(i.selected_text, '')) LIKE ?2 ESCAPE '\\'
       OR LOWER(COALESCE(i.content, '')) LIKE ?2 ESCAPE '\\'
       OR LOWER(COALESCE(i.normalized_word, '')) LIKE ?2 ESCAPE '\\'
       OR LOWER(COALESCE(b.title, '')) LIKE ?2 ESCAPE '\\')
  AND (?3 IS NULL OR i.updated_at >= ?3)
  AND (?4 IS NULL OR i.updated_at <= ?4)
";

/// Type predicate, bound as `?5`.
const KIND_FILTER: &str = "
  AND (?5 IS NULL
       OR (?5 = 'highlight' AND i.highlight_id IS NOT NULL)
       OR (?5 = 'with_note' AND i.content IS NOT NULL AND TRIM(i.content) <> '')
       OR (?5 = 'word' AND i.anchor_kind = 'word')
       OR (?5 = 'selection' AND i.anchor_kind = 'selection'))
";

fn row_to_annotation(row: &Row<'_>) -> rusqlite::Result<Annotation> {
    let content: Option<String> = row.get(11)?;
    Ok(Annotation {
        id: row.get(0)?,
        highlight_id: row.get(1)?,
        note_id: row.get(2)?,
        book_id: row.get(3)?,
        anchor_kind: row.get(4)?,
        normalized_word: row.get(5)?,
        scope: row.get(6)?,
        location: row.get(7)?,
        selected_text: row.get(8)?,
        color: row.get(9)?,
        book_title: row.get(10)?,
        content: content.filter(|value| !value.trim().is_empty()),
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
    })
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn query_annotations(
    db: &Db,
    book_id: Option<&str>,
    kind: Option<&str>,
    search: Option<&str>,
    updated_after: Option<i64>,
    updated_before: Option<i64>,
    cursor: Option<&str>,
    limit: usize,
) -> AppResult<AnnotationPage> {
    let kind = kind.filter(|value| !value.is_empty());
    if let Some(kind) = kind {
        if !KINDS.contains(&kind) {
            return Err(AppError::Other("ANNOTATION_KIND_UNKNOWN".to_string()));
        }
    }
    let pattern = search
        .filter(|value| !value.trim().is_empty())
        .map(|value| sqlite_contains_pattern(value.trim()));
    let conn = db.reader();

    let counts: AnnotationCounts = conn.query_row(
        &format!(
            "{ITEMS_CTE}
             SELECT COUNT(*),
                    COALESCE(SUM(i.highlight_id IS NOT NULL), 0),
                    COALESCE(SUM(i.content IS NOT NULL AND TRIM(i.content) <> ''), 0),
                    COALESCE(SUM(i.anchor_kind = 'word'), 0),
                    COALESCE(SUM(i.anchor_kind = 'selection'), 0),
                    COALESCE(SUM(i.highlight_id IS NOT NULL
                                 AND (i.content IS NULL OR TRIM(i.content) = '')), 0)
             FROM items i LEFT JOIN books b ON b.id = i.book_id
             WHERE {SCOPE_FILTER}"
        ),
        params![book_id, pattern, updated_after, updated_before],
        |row| {
            Ok(AnnotationCounts {
                all: row.get(0)?,
                highlights: row.get(1)?,
                with_notes: row.get(2)?,
                words: row.get(3)?,
                selections: row.get(4)?,
                bare_highlights: row.get(5)?,
            })
        },
    )?;

    // Every highlight is a selection, so the bare count survives both the
    // "highlights" and "passages" filters untouched.
    let (total, bare_highlights) = match kind {
        None => (counts.all, counts.bare_highlights),
        Some("highlight") => (counts.highlights, counts.bare_highlights),
        Some("with_note") => (counts.with_notes, 0),
        Some("word") => (counts.words, 0),
        Some(_) => (counts.selections, counts.bare_highlights),
    };

    let page_limit = limit.clamp(1, 500);
    let fetch_limit = page_limit + 1;
    let mut statement = conn.prepare(&format!(
        "{ITEMS_CTE}
         SELECT i.id, i.highlight_id, i.note_id, i.book_id, i.anchor_kind,
                i.normalized_word, i.scope, i.location, i.selected_text, i.color,
                b.title, i.content, i.created_at, i.updated_at
         FROM items i LEFT JOIN books b ON b.id = i.book_id
         WHERE {SCOPE_FILTER} {KIND_FILTER}
           AND (?6 IS NULL OR printf('%020lld:%s', i.updated_at, i.id) < ?6)
         ORDER BY i.updated_at DESC, i.id DESC LIMIT ?7"
    ))?;
    let mut annotations = statement
        .query_map(
            params![
                book_id,
                pattern,
                updated_after,
                updated_before,
                kind,
                cursor,
                fetch_limit
            ],
            row_to_annotation,
        )?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppError::from)?;
    let has_more = annotations.len() > page_limit;
    annotations.truncate(page_limit);
    let next_cursor = has_more.then(|| {
        let last = annotations
            .last()
            .expect("non-empty page with continuation");
        format!("{:020}:{}", last.updated_at, last.id)
    });

    Ok(AnnotationPage {
        annotations,
        next_cursor,
        total,
        bare_highlights,
        counts,
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn list_annotations(
    book_id: Option<String>,
    kind: Option<String>,
    search: Option<String>,
    updated_after: Option<i64>,
    updated_before: Option<i64>,
    cursor: Option<String>,
    limit: Option<usize>,
    db: State<'_, Db>,
) -> AppResult<AnnotationPage> {
    query_annotations(
        &db,
        book_id.as_deref(),
        kind.as_deref(),
        search.as_deref(),
        updated_after,
        updated_before,
        cursor.as_deref(),
        limit.unwrap_or(100),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use tempfile::TempDir;

    struct Fixture {
        _dir: TempDir,
        db: Db,
    }

    fn fixture() -> Fixture {
        let dir = TempDir::new().unwrap();
        let db = Db::init(dir.path()).unwrap();
        {
            let conn = db.conn.lock().unwrap();
            book(&conn, "b1", "The Stranger");
            book(&conn, "b2", "Animal Farm");
        }
        Fixture { _dir: dir, db }
    }

    fn book(conn: &Connection, id: &str, title: &str) {
        conn.execute(
            "INSERT INTO books
             (id, title, author, file_path, format, status, progress, created_at, updated_at)
             VALUES (?1, ?2, 'Author', 'books/' || ?1 || '.epub', 'epub', 'reading', 0, 1, 1)",
            params![id, title],
        )
        .unwrap();
    }

    fn highlight(db: &Db, id: &str, book_id: &str, range: &str, text: &str, ts: i64) {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO highlights
             (id, book_id, cfi_range, color, text_content, created_at, updated_at,
              updated_by_device)
             VALUES (?1, ?2, ?3, 'yellow', ?4, ?5, ?5, 'dev-A')",
            params![id, book_id, range, text, ts],
        )
        .unwrap();
    }

    #[allow(clippy::too_many_arguments)]
    fn note(
        db: &Db,
        id: &str,
        book_id: Option<&str>,
        anchor_kind: &str,
        word: Option<&str>,
        location: Option<&str>,
        content: &str,
        ts: i64,
    ) {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO notes
             (id, book_id, anchor_kind, normalized_word, scope, location, selected_text,
              content, content_format, created_at, updated_at, updated_by_device)
             VALUES (?1, ?2, ?3, ?4, 'book', ?5, NULL, ?6, 'plain_text', ?7, ?7, 'dev-A')",
            params![id, book_id, anchor_kind, word, location, content, ts],
        )
        .unwrap();
    }

    fn list(db: &Db, kind: Option<&str>) -> AnnotationPage {
        query_annotations(db, None, kind, None, None, None, None, 100).unwrap()
    }

    fn ids(page: &AnnotationPage) -> Vec<String> {
        page.annotations.iter().map(|a| a.id.clone()).collect()
    }

    #[test]
    fn a_highlight_without_a_note_is_its_own_item() {
        let f = fixture();
        highlight(&f.db, "h1", "b1", "cfi-1", "quoted text", 1000);

        let page = list(&f.db, None);
        assert_eq!(ids(&page), vec!["h:h1"]);
        let item = &page.annotations[0];
        assert_eq!(item.highlight_id.as_deref(), Some("h1"));
        assert_eq!(item.note_id, None);
        assert_eq!(item.content, None);
        assert_eq!(item.selected_text.as_deref(), Some("quoted text"));
        assert_eq!(item.book_title.as_deref(), Some("The Stranger"));
        assert_eq!(page.total, 1);
        assert_eq!(page.bare_highlights, 1);
    }

    #[test]
    fn a_note_at_the_same_anchor_folds_into_the_highlight() {
        let f = fixture();
        highlight(&f.db, "h1", "b1", "cfi-1", "quoted", 1000);
        note(
            &f.db,
            "n1",
            Some("b1"),
            "selection",
            None,
            Some("cfi-1"),
            "my thought",
            2000,
        );

        let page = list(&f.db, None);
        assert_eq!(ids(&page), vec!["h:h1"], "one anchor must yield one item");
        let item = &page.annotations[0];
        assert_eq!(item.highlight_id.as_deref(), Some("h1"));
        assert_eq!(item.note_id.as_deref(), Some("n1"));
        assert_eq!(item.content.as_deref(), Some("my thought"));
        assert_eq!(item.updated_at, 2000, "the newer side dates the item");
        assert_eq!(page.total, 1);
        assert_eq!(page.bare_highlights, 0);
    }

    #[test]
    fn the_same_anchor_string_in_two_books_stays_two_items() {
        let f = fixture();
        highlight(&f.db, "h1", "b1", "cfi-1", "quoted", 1000);
        note(
            &f.db,
            "n1",
            Some("b2"),
            "selection",
            None,
            Some("cfi-1"),
            "other book",
            2000,
        );

        let page = list(&f.db, None);
        assert_eq!(ids(&page), vec!["n:n1", "h:h1"]);
        assert_eq!(page.annotations[1].note_id, None);
        assert_eq!(page.total, 2);
    }

    #[test]
    fn a_word_note_never_folds_into_a_highlight() {
        let f = fixture();
        highlight(&f.db, "h1", "b1", "cfi-1", "quoted", 1000);
        note(
            &f.db,
            "n1",
            Some("b1"),
            "word",
            Some("courage"),
            Some("cfi-1"),
            "gloss",
            2000,
        );

        let page = list(&f.db, None);
        assert_eq!(ids(&page), vec!["n:n1", "h:h1"]);
        assert_eq!(
            page.annotations[0].normalized_word.as_deref(),
            Some("courage")
        );
        assert_eq!(page.counts.words, 1);
        assert_eq!(page.counts.selections, 1);
    }

    #[test]
    fn the_type_filter_slices_the_union() {
        let f = fixture();
        highlight(&f.db, "h1", "b1", "cfi-1", "bare", 1000);
        highlight(&f.db, "h2", "b1", "cfi-2", "annotated", 1100);
        note(
            &f.db,
            "n1",
            Some("b1"),
            "selection",
            None,
            Some("cfi-2"),
            "thought",
            1200,
        );
        note(
            &f.db,
            "n2",
            Some("b1"),
            "word",
            Some("courage"),
            None,
            "gloss",
            1300,
        );

        assert_eq!(list(&f.db, Some("highlight")).total, 2);
        assert_eq!(ids(&list(&f.db, Some("highlight"))), vec!["h:h2", "h:h1"]);
        assert_eq!(list(&f.db, Some("with_note")).total, 2);
        assert_eq!(ids(&list(&f.db, Some("word"))), vec!["n:n2"]);
        assert_eq!(ids(&list(&f.db, Some("selection"))), vec!["h:h2", "h:h1"]);

        let highlights_only = list(&f.db, Some("highlight"));
        assert_eq!(highlights_only.bare_highlights, 1);
        // Pill counts ignore the type filter so the numbers hold still.
        assert_eq!(highlights_only.counts.all, 3);

        assert!(
            query_annotations(&f.db, None, Some("nonsense"), None, None, None, None, 100).is_err()
        );
    }

    #[test]
    fn search_reaches_both_the_quoted_text_and_the_note_body() {
        let f = fixture();
        highlight(&f.db, "h1", "b1", "cfi-1", "the sea was warm", 1000);
        highlight(&f.db, "h2", "b1", "cfi-2", "nothing here", 1100);
        note(
            &f.db,
            "n1",
            Some("b1"),
            "selection",
            None,
            Some("cfi-2"),
            "warmth as memory",
            1200,
        );

        let by_text =
            query_annotations(&f.db, None, None, Some("sea"), None, None, None, 100).unwrap();
        assert_eq!(ids(&by_text), vec!["h:h1"]);

        let by_body =
            query_annotations(&f.db, None, None, Some("memory"), None, None, None, 100).unwrap();
        assert_eq!(ids(&by_body), vec!["h:h2"]);
        assert_eq!(by_body.total, 1);
    }

    #[test]
    fn pagination_walks_across_the_union_boundary() {
        let f = fixture();
        highlight(&f.db, "h1", "b1", "cfi-1", "first", 1000);
        note(
            &f.db,
            "n1",
            Some("b1"),
            "word",
            Some("alpha"),
            None,
            "a",
            1100,
        );
        highlight(&f.db, "h2", "b1", "cfi-2", "second", 1200);
        note(
            &f.db,
            "n2",
            Some("b1"),
            "word",
            Some("beta"),
            None,
            "b",
            1300,
        );

        let mut seen = Vec::new();
        let mut cursor = None;
        loop {
            let page = query_annotations(&f.db, None, None, None, None, None, cursor.as_deref(), 1)
                .unwrap();
            assert_eq!(page.total, 4, "totals stay whole-set, not page-set");
            seen.extend(page.annotations.iter().map(|a| a.id.clone()));
            match page.next_cursor {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        assert_eq!(seen, vec!["n:n2", "h:h2", "n:n1", "h:h1"]);
    }

    #[test]
    fn the_bare_highlight_count_tracks_only_unwritten_highlights() {
        let f = fixture();
        highlight(&f.db, "h1", "b1", "cfi-1", "bare", 1000);
        highlight(&f.db, "h2", "b1", "cfi-2", "written on", 1100);
        highlight(&f.db, "h3", "b1", "cfi-3", "folded", 1200);
        note(
            &f.db,
            "n0",
            Some("b1"),
            "selection",
            None,
            Some("cfi-2"),
            "a thought",
            1150,
        );
        note(
            &f.db,
            "n1",
            Some("b1"),
            "selection",
            None,
            Some("cfi-3"),
            "thought",
            1300,
        );
        note(
            &f.db,
            "n2",
            Some("b1"),
            "word",
            Some("courage"),
            None,
            "gloss",
            1400,
        );

        let page = list(&f.db, None);
        assert_eq!(page.total, 4);
        assert_eq!(page.bare_highlights, 1);
        assert_eq!(
            (
                page.counts.highlights,
                page.counts.with_notes,
                page.counts.words
            ),
            (3, 3, 1)
        );
    }

    #[test]
    fn a_second_note_at_one_anchor_stays_visible_on_its_own() {
        let f = fixture();
        highlight(&f.db, "h1", "b1", "cfi-1", "quoted", 1000);
        note(
            &f.db,
            "n1",
            Some("b1"),
            "selection",
            None,
            Some("cfi-1"),
            "older",
            1100,
        );
        note(
            &f.db,
            "n2",
            Some("b1"),
            "selection",
            None,
            Some("cfi-1"),
            "newer",
            1200,
        );

        let page = list(&f.db, None);
        assert_eq!(ids(&page), vec!["h:h1", "n:n1"]);
        assert_eq!(page.annotations[0].note_id.as_deref(), Some("n2"));
    }
}

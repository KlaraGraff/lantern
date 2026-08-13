//! AI word-class verdicts for the level observation's topical screen.
//!
//! The local burstiness heuristic in `level_observation.rs` can only see
//! *recurrence*: a hard word one book keeps repeating. It cannot see
//! *meaning* — so a general abstract word a novel happens to lean on
//! ("melancholy" in a melancholy book) gets screened out as terminology,
//! and a genuine term the reader met only twice stays in as evidence. This
//! module fixes both by asking the reader's configured AI the question the
//! heuristic only approximates: given the book's title, is this word that
//! book's subject-matter vocabulary, or ordinary English?
//!
//! Shape and discipline copied from `followup_difficulty.rs`:
//!
//! - Never inline. `get_level_observation` computes today's row from what is
//!   already cached and returns; classification of whatever is still
//!   unjudged runs detached, and its results are simply *there* the next
//!   time the page is opened.
//! - A verdict is computed once per (word, book) and cached forever in
//!   `level_word_classifications` (migration 055) — the word's relationship
//!   to the book does not change, so neither does the answer.
//! - Failure is silent. No provider, no quota, a malformed response — the
//!   words stay unclassified, the observation falls back to the local
//!   heuristic for them, and a later visit tries again.
//! - What leaves the machine is exactly what the stats page's fine print
//!   says: the words themselves and the title/author of the book each sits
//!   in. No passage text, no counts, nothing else about the reader.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};

use rusqlite::{params, Connection, OptionalExtension};
use tauri::{AppHandle, Runtime};

use crate::commands::ai::ChatMessage;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::secrets::Secrets;

/// This job's id — and the exact string every classification call is tagged
/// with in `ai_usage_records.feature`, so its spend is attributable.
pub const JOB_ID: &str = "level_word_class";

/// Words per AI call. Same register as `followup_difficulty`'s batch cap:
/// large enough to amortise the prompt, small enough that one malformed
/// response throws away little.
const BATCH_MAX: usize = 30;

/// Ceiling on words classified per page visit. A first visit over a large
/// backlog pays for at most this many; the rest wait for the next visit.
/// At flash-model prices this is a fraction of one chat reply.
const MAX_WORDS_PER_VISIT: usize = 300;

/// Only one classification pass in flight at a time, process-wide — the
/// same one-flag idiom `followup_difficulty` uses, for the same reason:
/// two stats-page loads in quick succession must not both pay to classify
/// the same words.
static BATCH_RUNNING: AtomicBool = AtomicBool::new(false);

/// A word awaiting a verdict, in the one book that is its context: for a
/// looked-up word the book it was looked up in, for a read-past word the
/// book holding most of its sightings.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Candidate {
    pub word: String,
    pub book_id: String,
}

/// The two answers, matching migration 055's CHECK constraint.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WordClass {
    Topical,
    General,
}

impl WordClass {
    fn as_db(self) -> &'static str {
        match self {
            Self::Topical => "topical",
            Self::General => "general",
        }
    }

    fn from_db(raw: &str) -> Option<Self> {
        match raw {
            "topical" => Some(Self::Topical),
            "general" => Some(Self::General),
            _ => None,
        }
    }
}

/// Every cached verdict, keyed by (word, book). Loaded whole: the table
/// only ever holds words the reader actually met in a 90-day window, and
/// one map lookup per scored row beats one query per scored row.
pub fn cached_verdicts(conn: &Connection) -> AppResult<HashMap<(String, String), WordClass>> {
    let mut stmt =
        conn.prepare("SELECT normalized_word, book_id, verdict FROM level_word_classifications")?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let mut verdicts = HashMap::new();
    for row in rows {
        let (word, book, verdict) = row?;
        if let Some(class) = WordClass::from_db(&verdict) {
            verdicts.insert((word, book), class);
        }
    }
    Ok(verdicts)
}

/// Fire a detached classification pass over `candidates`. Never awaited —
/// the command that calls this returns to the reader before any network
/// work has started. A pass already in flight wins; these words simply
/// come back as candidates on the next visit.
pub fn spawn_classification<R: Runtime>(
    app: AppHandle<R>,
    db: Db,
    secrets: Secrets,
    candidates: Vec<Candidate>,
) {
    if candidates.is_empty() {
        return;
    }
    if BATCH_RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        if let Err(error) = classify_all(&app, &db, &secrets, candidates).await {
            log::debug!("level_word_class: classification pass skipped: {error}");
        }
        BATCH_RUNNING.store(false, Ordering::SeqCst);
    });
}

/// "Title — Author" per book id, the whole context the prompt is allowed to
/// carry. A candidate whose book row is gone (deleted between collection
/// and this call) is dropped from the pass, not sent context-free: without
/// a title the question "is this that book's terminology" has no referent.
fn book_names(db: &Db, candidates: &[Candidate]) -> AppResult<HashMap<String, String>> {
    let conn = db.reader();
    let mut names = HashMap::new();
    for candidate in candidates {
        if names.contains_key(&candidate.book_id) {
            continue;
        }
        let row: Option<(String, String)> = conn
            .query_row(
                "SELECT title, author FROM books WHERE id = ?1",
                params![candidate.book_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((title, author)) = row {
            let name = if author.trim().is_empty() {
                title
            } else {
                format!("{title} — {author}")
            };
            names.insert(candidate.book_id.clone(), name);
        }
    }
    Ok(names)
}

/// One pass: resolve book names, then classify in chunks of [`BATCH_MAX`]
/// until done or [`MAX_WORDS_PER_VISIT`] is spent. Chunks are independent —
/// a chunk that fails ends the pass (the provider is likely down for the
/// next chunk too), but everything stored by earlier chunks stays stored.
pub async fn classify_all<R: Runtime>(
    app: &AppHandle<R>,
    db: &Db,
    secrets: &Secrets,
    candidates: Vec<Candidate>,
) -> AppResult<usize> {
    let names = book_names(db, &candidates)?;
    let rows: Vec<(Candidate, String)> = candidates
        .into_iter()
        .filter_map(|candidate| {
            let name = names.get(&candidate.book_id)?.clone();
            Some((candidate, name))
        })
        .take(MAX_WORDS_PER_VISIT)
        .collect();
    let mut stored = 0usize;
    for chunk in rows.chunks(BATCH_MAX) {
        stored += classify_chunk(app, db, secrets, chunk).await?;
    }
    Ok(stored)
}

/// Fixed, inspectable prompt. The only interpolated content is each word
/// and its book's title/author — exactly what the stats page's fine print
/// discloses, nothing else.
fn classification_prompt(rows: &[(Candidate, String)]) -> Vec<ChatMessage> {
    let items: Vec<serde_json::Value> = rows
        .iter()
        .enumerate()
        .map(|(index, (candidate, book))| {
            serde_json::json!({
                "index": index,
                "word": candidate.word,
                "book": book,
            })
        })
        .collect();
    let payload = serde_json::Value::Array(items).to_string();
    vec![
        ChatMessage {
            role: "system".to_string(),
            content: "You judge whether an English word a reader met in a specific book is that \
                book's own subject-matter vocabulary or general English vocabulary. Answer \
                \"topical\" when the word belongs to the book's particular subject, setting, or \
                jargon — vocabulary this book uses because of what it is about (sailing terms in \
                a sea story, courtroom terms in a legal drama, invented names for a fantasy \
                world's things). Answer \"general\" for ordinary literary, abstract, or everyday \
                vocabulary that could appear in any book, even when it fits this book's mood. \
                When unsure, answer \"general\". Respond with only a JSON array, no prose, no \
                markdown fences. Each element is an object {\"index\": <the input item's index>, \
                \"class\": \"topical\" or \"general\"}. Include one element per input item, in \
                any order."
                .to_string(),
        },
        ChatMessage {
            role: "user".to_string(),
            content: payload,
        },
    ]
}

/// Strip a ```json fence a model adds despite being asked not to.
fn strip_code_fence(text: &str) -> &str {
    let trimmed = text.trim();
    let Some(after_open) = trimmed.strip_prefix("```") else {
        return trimmed;
    };
    let after_open = after_open
        .strip_prefix("json")
        .unwrap_or(after_open)
        .trim_start_matches(['\n', '\r']);
    after_open.strip_suffix("```").unwrap_or(after_open).trim()
}

#[derive(serde::Deserialize)]
struct ClassificationEntry {
    index: usize,
    class: String,
}

/// Parse the model's response, keeping only entries with an in-range index
/// and a recognised class. A malformed entry is dropped, not fatal — a
/// response that got most rows right should not throw away the rest.
fn parse_classifications(text: &str, row_count: usize) -> Vec<(usize, WordClass)> {
    let Ok(entries) = serde_json::from_str::<Vec<ClassificationEntry>>(strip_code_fence(text))
    else {
        return Vec::new();
    };
    entries
        .into_iter()
        .filter(|entry| entry.index < row_count)
        .filter_map(|entry| WordClass::from_db(&entry.class).map(|class| (entry.index, class)))
        .collect()
}

async fn classify_chunk<R: Runtime>(
    app: &AppHandle<R>,
    db: &Db,
    secrets: &Secrets,
    rows: &[(Candidate, String)],
) -> AppResult<usize> {
    if rows.is_empty() {
        return Ok(0);
    }
    let messages = classification_prompt(rows);
    let completion = crate::ai::router::complete_with_failover(
        app,
        db,
        secrets,
        &messages,
        Some(2_000),
        crate::ai::router::AiRequestPurpose::Utility,
        crate::ai::router::AiRetryMode::Automatic,
        None,
        None,
        "auto",
        // Must stay exactly `JOB_ID` — usage attribution matches on it.
        JOB_ID,
    )
    .await?;
    let classifications = parse_classifications(&completion.text, rows.len());
    if classifications.is_empty() {
        return Ok(0);
    }
    let batch_id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp_millis();
    let conn = db
        .conn
        .lock()
        .map_err(|error| AppError::Other(error.to_string()))?;
    let mut stored = 0usize;
    for (index, class) in classifications {
        let (candidate, _) = &rows[index];
        // OR IGNORE: a concurrent pass (other device, sync) that judged the
        // same pair first keeps its verdict — either answer was computed
        // from the same question, and stability beats freshness here.
        let changed = conn.execute(
            "INSERT OR IGNORE INTO level_word_classifications
                (normalized_word, book_id, verdict, classified_at, batch_id)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                candidate.word,
                candidate.book_id,
                class.as_db(),
                now,
                batch_id
            ],
        )?;
        stored += changed;
    }
    Ok(stored)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn setup() -> (TempDir, Db) {
        let dir = TempDir::new().unwrap();
        let db = Db::init(dir.path()).unwrap();
        let conn = db.conn.lock().unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "INSERT INTO books (id, title, author, file_path, status, progress, created_at, updated_at)
             VALUES ('book1', 'Moby-Dick', 'Herman Melville', 'books/moby.epub', 'reading', 0, ?1, ?1)",
            params![now],
        )
        .unwrap();
        drop(conn);
        (dir, db)
    }

    fn candidate(word: &str) -> Candidate {
        Candidate {
            word: word.to_string(),
            book_id: "book1".to_string(),
        }
    }

    fn stored_verdict(db: &Db, word: &str) -> Option<String> {
        db.reader()
            .query_row(
                "SELECT verdict FROM level_word_classifications
                 WHERE normalized_word = ?1 AND book_id = 'book1'",
                params![word],
                |row| row.get(0),
            )
            .optional()
            .unwrap()
    }

    // --- parsing ---

    #[test]
    fn a_fenced_response_with_stray_entries_keeps_the_valid_rows() {
        let text = "```json\n[{\"index\":0,\"class\":\"topical\"},{\"index\":9,\"class\":\"general\"},{\"index\":1,\"class\":\"maybe\"}]\n```";
        let parsed = parse_classifications(text, 2);
        assert_eq!(parsed, vec![(0, WordClass::Topical)]);
    }

    #[test]
    fn a_non_json_response_parses_to_nothing() {
        assert!(parse_classifications("the words seem nautical", 3).is_empty());
    }

    // --- prompt ---

    #[test]
    fn the_prompt_carries_only_words_and_book_names() {
        let rows = vec![
            (
                candidate("harpoon"),
                "Moby-Dick — Herman Melville".to_string(),
            ),
            (
                candidate("melancholy"),
                "Moby-Dick — Herman Melville".to_string(),
            ),
        ];
        let messages = classification_prompt(&rows);
        assert_eq!(messages.len(), 2);
        let payload: serde_json::Value = serde_json::from_str(&messages[1].content).unwrap();
        assert_eq!(payload[0]["word"], "harpoon");
        assert_eq!(payload[0]["book"], "Moby-Dick — Herman Melville");
        assert_eq!(payload[1]["index"], 1);
        // Nothing else about the reader travels: two keys plus the index.
        assert_eq!(payload[0].as_object().unwrap().len(), 3);
    }

    // --- the pass against a fake provider ---

    async fn fake_sse_server(bodies: Vec<String>) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            for body in bodies {
                let Ok((mut stream, _)) = listener.accept().await else {
                    return;
                };
                let mut request = Vec::new();
                let mut buffer = [0_u8; 4096];
                while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                    let Ok(read) = stream.read(&mut buffer).await else {
                        return;
                    };
                    if read == 0 {
                        break;
                    }
                    request.extend_from_slice(&buffer[..read]);
                }
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
            }
        });
        format!("http://{address}")
    }

    fn sse_answer(text: &str) -> String {
        let escaped = text.replace('\\', "\\\\").replace('"', "\\\"");
        format!(
            "data: {{\"choices\":[{{\"delta\":{{\"content\":\"{escaped}\"}}}}]}}\n\ndata: {{\"choices\":[],\"usage\":{{\"prompt_tokens\":10,\"completion_tokens\":5}}}}\n\ndata: [DONE]\n\n"
        )
    }

    fn wire_fake_provider(db: &Db, secrets: &Secrets, base_url: String) {
        let profile = crate::ai::router::create_profile(
            db,
            "Test".to_string(),
            "custom".to_string(),
            "api_key".to_string(),
            Some(base_url),
            "placeholder".to_string(),
            0.2,
            None,
            false,
            None,
            true,
        )
        .unwrap();
        crate::ai::router::add_credential(
            db,
            secrets,
            profile.id,
            "Key".to_string(),
            "test-key".to_string(),
        )
        .unwrap();
    }

    #[tokio::test]
    async fn a_pass_stores_verdicts_and_bills_the_job_id() {
        let (_dir, db) = setup();
        let body = sse_answer(r#"[{"index":0,"class":"topical"},{"index":1,"class":"general"}]"#);
        let base_url = fake_sse_server(vec![body]).await;
        let secrets = crate::secrets::Secrets::init_in_memory().unwrap();
        wire_fake_provider(&db, &secrets, base_url);

        let app = tauri::test::mock_app();
        let stored = classify_all(
            app.handle(),
            &db,
            &secrets,
            vec![candidate("harpoon"), candidate("melancholy")],
        )
        .await
        .unwrap();
        assert_eq!(stored, 2);
        assert_eq!(stored_verdict(&db, "harpoon").as_deref(), Some("topical"));
        assert_eq!(
            stored_verdict(&db, "melancholy").as_deref(),
            Some("general")
        );

        let (origin, feature): (String, String) = db
            .reader()
            .query_row(
                "SELECT origin, feature FROM ai_usage_records ORDER BY created_at DESC LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(origin, "auto");
        assert_eq!(feature, JOB_ID);
    }

    #[tokio::test]
    async fn a_malformed_response_stores_nothing_so_the_words_stay_candidates() {
        let (_dir, db) = setup();
        let base_url = fake_sse_server(vec![sse_answer("not json at all")]).await;
        let secrets = crate::secrets::Secrets::init_in_memory().unwrap();
        wire_fake_provider(&db, &secrets, base_url);

        let app = tauri::test::mock_app();
        let stored = classify_all(app.handle(), &db, &secrets, vec![candidate("harpoon")])
            .await
            .unwrap();
        assert_eq!(stored, 0);
        assert_eq!(stored_verdict(&db, "harpoon"), None);
    }

    #[tokio::test]
    async fn a_candidate_whose_book_is_gone_is_dropped_not_sent() {
        let (_dir, db) = setup();
        let secrets = crate::secrets::Secrets::init_in_memory().unwrap();
        // No provider wired: if the orphan candidate survived the name
        // resolution, the pass would attempt a call and fail with
        // NOT_CONFIGURED rather than return Ok(0).
        let app = tauri::test::mock_app();
        let stored = classify_all(
            app.handle(),
            &db,
            &secrets,
            vec![Candidate {
                word: "harpoon".to_string(),
                book_id: "deleted-book".to_string(),
            }],
        )
        .await
        .unwrap();
        assert_eq!(stored, 0);
    }

    #[test]
    fn an_existing_verdict_is_never_overwritten() {
        let (_dir, db) = setup();
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO level_word_classifications
                (normalized_word, book_id, verdict, classified_at, batch_id)
             VALUES ('harpoon', 'book1', 'topical', 1, 'b1')",
            [],
        )
        .unwrap();
        let changed = conn
            .execute(
                "INSERT OR IGNORE INTO level_word_classifications
                    (normalized_word, book_id, verdict, classified_at, batch_id)
                 VALUES ('harpoon', 'book1', 'general', 2, 'b2')",
                [],
            )
            .unwrap();
        drop(conn);
        assert_eq!(changed, 0);
        assert_eq!(stored_verdict(&db, "harpoon").as_deref(), Some("topical"));
    }

    // --- the pass against the machine's real provider ---

    /// The acceptance test the AI-default rests on: the reader's actual
    /// configured provider, on a hand-labeled sample, must beat the bar
    /// before AI screening ships as the default mode.
    ///
    /// `#[ignore]`d because it needs this machine's real config and spends
    /// real (fractions of a cent of) quota: `cargo test -- --ignored`. It
    /// reads the production databases strictly read-only, copies the active
    /// profile and key into a throwaway test database, and never prints or
    /// stores the key anywhere else.
    #[tokio::test]
    #[ignore = "uses the machine's real AI config and spends real quota"]
    async fn the_real_provider_classifies_a_labeled_sample_accurately() {
        let config_dir = std::path::PathBuf::from(std::env::var("HOME").unwrap())
            .join("Library/Application Support/com.klaragraff.lantern");
        if !config_dir.join("lantern.db").exists() {
            eprintln!("no production config on this machine — nothing to test against");
            return;
        }
        let read_only = rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY;
        let prod = Connection::open_with_flags(config_dir.join("lantern.db"), read_only).unwrap();
        let (profile_id, provider, base_url, model): (String, String, Option<String>, String) =
            prod.query_row(
                "SELECT id, provider, base_url, model FROM ai_profiles WHERE enabled = 1 LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        let secret_ref: String = prod
            .query_row(
                "SELECT secret_ref FROM ai_credentials
                 WHERE profile_id = ?1 AND enabled = 1 AND state = 'active'
                 ORDER BY priority LIMIT 1",
                params![profile_id],
                |row| row.get(0),
            )
            .unwrap();
        let prod_secrets =
            Connection::open_with_flags(config_dir.join("secrets.db"), read_only).unwrap();
        let api_key: String = prod_secrets
            .query_row(
                "SELECT value FROM secrets WHERE key = ?1",
                params![secret_ref],
                |row| row.get(0),
            )
            .unwrap();
        eprintln!("testing against {provider} / {model}");

        // The labeled sample: two books whose subject vocabulary any
        // competent judge should separate from the general hard words the
        // same books also use. Half of each, deliberately — the failure
        // mode being tested is a judge that calls everything topical (or
        // nothing) once it knows the book.
        let (dir, db) = setup();
        {
            let conn = db.conn.lock().unwrap();
            let now = chrono::Utc::now().timestamp_millis();
            conn.execute(
                "INSERT INTO books (id, title, author, file_path, status, progress, created_at, updated_at)
                 VALUES ('book2', 'A Brief History of Time', 'Stephen Hawking', 'books/time.epub', 'reading', 0, ?1, ?1)",
                params![now],
            )
            .unwrap();
        }
        let sample: Vec<(&str, &str, WordClass)> = vec![
            ("harpoon", "book1", WordClass::Topical),
            ("forecastle", "book1", WordClass::Topical),
            ("blubber", "book1", WordClass::Topical),
            ("leviathan", "book1", WordClass::Topical),
            ("gunwale", "book1", WordClass::Topical),
            ("melancholy", "book1", WordClass::General),
            ("inexorable", "book1", WordClass::General),
            ("countenance", "book1", WordClass::General),
            ("prodigious", "book1", WordClass::General),
            ("wistful", "book1", WordClass::General),
            ("quark", "book2", WordClass::Topical),
            ("singularity", "book2", WordClass::Topical),
            ("photon", "book2", WordClass::Topical),
            ("spacetime", "book2", WordClass::Topical),
            ("entropy", "book2", WordClass::Topical),
            ("endeavour", "book2", WordClass::General),
            ("profound", "book2", WordClass::General),
            ("intricate", "book2", WordClass::General),
            ("elusive", "book2", WordClass::General),
            ("remarkable", "book2", WordClass::General),
        ];

        let secrets = crate::secrets::Secrets::init_in_memory().unwrap();
        let profile = crate::ai::router::create_profile(
            &db,
            "Real-config test".to_string(),
            provider,
            "api_key".to_string(),
            base_url,
            model,
            0.2,
            None,
            false,
            None,
            true,
        )
        .unwrap();
        crate::ai::router::add_credential(&db, &secrets, profile.id, "Key".to_string(), api_key)
            .unwrap();

        let candidates: Vec<Candidate> = sample
            .iter()
            .map(|(word, book, _)| Candidate {
                word: word.to_string(),
                book_id: book.to_string(),
            })
            .collect();
        let app = tauri::test::mock_app();
        let stored = classify_all(app.handle(), &db, &secrets, candidates)
            .await
            .unwrap();
        eprintln!("stored {stored} of {} verdicts", sample.len());

        let verdicts = cached_verdicts(&db.reader()).unwrap();
        let mut correct = 0;
        for (word, book, expected) in &sample {
            let got = verdicts.get(&(word.to_string(), book.to_string()));
            let ok = got == Some(expected);
            if ok {
                correct += 1;
            }
            eprintln!(
                "  {:<12} {:<7} expected {:?}, got {:?}{}",
                word,
                book,
                expected,
                got,
                if ok { "" } else { "   << MISS" }
            );
        }
        eprintln!("accuracy: {correct}/{}", sample.len());
        drop(dir);

        // The bar for shipping AI as the default: every verdict answered,
        // and at least 17 of 20 right. The local heuristic gets 0 of the
        // 10 topical words here (none have exposure evidence), so anything
        // clearing this bar is far ahead of what local mode could do.
        assert_eq!(stored, sample.len());
        assert!(
            correct >= 17,
            "only {correct}/{} correct — below the bar for an AI default",
            sample.len()
        );
    }
}

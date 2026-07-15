//! MCP server handler + stdio entry point.
//!
//! This file owns:
//!   - `QuillMcpHandler` — the per-process MCP service. Carries
//!     `McpState` so tool methods (defined across `mcp/tools/*.rs` via
//!     `#[tool_router]` impl blocks) can read the DB.
//!   - `tool_router()` — aggregator merging every per-file router.
//!   - `ServerHandler` impl (annotated `#[tool_handler]`) which
//!     auto-generates `call_tool` / `list_tools` against the merged
//!     router.
//!   - `serve_stdio()` — drives the handler over `(stdin, stdout)` for
//!     the `quill mcp` subcommand. The Tauri app does NOT run an MCP
//!     server in-process; AI clients (Claude Code, Codex) launch this
//!     subprocess themselves.

use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::ServerHandler;
use rmcp::model::{Implementation, ProtocolVersion, ServerCapabilities, ServerInfo};
use rmcp::transport::io::stdio;
use rmcp::{tool_handler, ServiceExt};

use super::state::McpState;

#[derive(Clone)]
pub(crate) struct QuillMcpHandler {
    pub(crate) state: McpState,
}

impl QuillMcpHandler {
    pub(crate) fn new(state: McpState) -> Self {
        Self { state }
    }

    /// Aggregator merging every per-file router into one. The
    /// `#[tool_handler]` macro on the `ServerHandler` impl below invokes
    /// this on every `call_tool` / `list_tools`, so keep it cheap —
    /// only fixed `with_route` inserts, no I/O.
    ///
    /// New tool files must add a `r.merge(Self::<name>_router());` line
    /// here AND register themselves in `tools/mod.rs`'s forbidden-
    /// surfaces audit comment.
    pub(crate) fn tool_router() -> ToolRouter<Self> {
        let mut r = ToolRouter::new();
        r.merge(Self::library_router());
        r.merge(Self::library_write_router());
        r.merge(Self::library_batch_router());
        r.merge(Self::content_router());
        r.merge(Self::learning_router());
        r.merge(Self::highlights_router());
        r.merge(Self::bookmarks_router());
        r.merge(Self::vocab_router());
        r.merge(Self::chats_router());
        r.merge(Self::collections_write_router());
        r
    }
}

#[tool_handler]
impl ServerHandler for QuillMcpHandler {
    fn get_info(&self) -> ServerInfo {
        // `ServerInfo` and `Implementation` are both `#[non_exhaustive]`.
        // Use the public constructors / builder methods rather than
        // struct literals.
        let implementation = Implementation::new("quill", env!("CARGO_PKG_VERSION"));
        let capabilities = ServerCapabilities::builder().enable_tools().build();
        ServerInfo::new(capabilities)
            .with_protocol_version(ProtocolVersion::LATEST)
            .with_server_info(implementation)
            .with_instructions(
                "Lantern MCP server. Read the local library, collections, full-text book \
                 search with citations, existing book summaries, highlights, bookmarks, \
                 notes, vocabulary with FSRS state, lookup history, word marks, the user's \
                 CEFR language profile, and chat history. Full-text search and summaries \
                 respect Lantern's spoiler guard and never invoke embedding or AI services. \
                 Batch library/collection writes and local index builds are available only \
                 when write access is enabled in Lantern settings.",
            )
    }
}

/// Drive the handler over `(stdin, stdout)` until the client closes the
/// pipe (or sends a shutdown notification). Returns when the session
/// ends; the binary's `main` should exit afterward.
///
/// Called from `mcp_stdio_main()` in `lib.rs`; not used by the Tauri
/// app side.
pub(crate) async fn serve_stdio(state: McpState) -> Result<(), Box<dyn std::error::Error>> {
    let handler = QuillMcpHandler::new(state);
    let server = handler.serve(stdio()).await?;
    // `waiting` resolves when the peer disconnects or sends shutdown.
    let _quit_reason = server.waiting().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    //! Unit tests for the `QuillMcpHandler` surface. We exercise tool
    //! methods directly against a seeded in-memory-on-disk SQLite via
    //! `Db::init` on a `TempDir`, asserting on the JSON payload each
    //! tool returns. The transport itself (stdin/stdout, rmcp's
    //! framing) is verified separately by the binary integration test
    //! in `tests/mcp_binary.rs`.
    use super::*;
    use crate::db::Db;
    use crate::sync::writer::SyncWriter;
    use rmcp::handler::server::wrapper::Parameters;
    use rusqlite::params;
    use tempfile::TempDir;

    fn seeded() -> (TempDir, McpState) {
        let dir = TempDir::new().unwrap();
        let db = Db::init(dir.path()).unwrap();
        {
            let conn = db.conn.lock().unwrap();
            // Seed every read surface so tool tests can assert response shape,
            // redaction, pagination, and spoiler behavior from one fixture.
            let now: i64 = 1_700_000_000_000;
            conn.execute(
                "INSERT INTO books (id, title, author, file_path, status, progress, created_at, updated_at)
                 VALUES ('b1','Test Title','Test Author','books/test.epub','reading',42,?1,?1)",
                params![now],
            ).unwrap();
            conn.execute(
                "UPDATE books SET current_cfi = 'epubcfi(/6/2)' WHERE id = 'b1'",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO collections (id, name, sort_order, created_at, updated_at)
                 VALUES ('c1','Favorites',0,?1,?1)",
                params![now],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO bookmarks (id, book_id, cfi, label, created_at, updated_at)
                 VALUES ('bm1','b1','epubcfi(/6/2!/4)','Ch1',?1,?1)",
                params![now],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO highlights (id, book_id, cfi_range, color, note, text_content, created_at, updated_at)
                 VALUES ('h1','b1','epubcfi(/6/4!/2,/4)','yellow','my note','quoted passage',?1,?1)",
                params![now],
            ).unwrap();
            conn.execute(
                "INSERT INTO vocab_words (id, book_id, word, definition, context_sentence, cfi, mastery, review_count, next_review_at, created_at, updated_at)
                 VALUES ('v1','b1','ostensibly','outwardly appearing as such','He was ostensibly happy.','epubcfi(/6/4!/8)','learning',0,NULL,?1,?1)",
                params![now],
            ).unwrap();
            conn.execute(
                "INSERT INTO chats (id, book_id, title, model, pinned, metadata, created_at, updated_at)
                 VALUES ('ch1','b1','First chat','gpt-test',0,NULL,?1,?1)",
                params![now],
            ).unwrap();
            conn.execute(
                "INSERT INTO chat_messages (id, chat_id, role, content, context, metadata, created_at, updated_at)
                 VALUES ('m1','ch1','user','hello',NULL,NULL,?1,?1)",
                params![now],
            ).unwrap();
            conn.execute(
                "INSERT INTO collection_books (collection_id, book_id, created_at, updated_at)
                 VALUES ('c1','b1',?1,?1)",
                params![now],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO notes (id, book_id, anchor_kind, normalized_word, scope, location, selected_text, content, content_format, created_at, updated_at)
                 VALUES ('n1','b1','word','ostensibly','book',NULL,NULL,'word note','plain_text',?1,?1),
                        ('n2','b1','selection',NULL,'book','epubcfi(/6/2)','selected text','selection note','plain_text',?1,?1)",
                params![now],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO lookup_records (id, book_id, lookup_text, normalized_text, context_sentence, chapter, cfi, definition, context_explanation, result_json, provider_profile_id, model, created_at, last_looked_up_at, updated_at, lookup_count)
                 VALUES ('l1','b1','Ostensibly','ostensibly','He was ostensibly happy.','One','epubcfi(/6/2)','outwardly','Used to qualify appearances','{\"raw\":true}','profile-secret','gpt-test',?1,?1,?1,2)",
                params![now],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO word_mark_rules (id, book_id, normalized_word, display_word, match_mode, color, enabled, created_at, updated_at)
                 VALUES ('wm1','b1','ostensibly','Ostensibly','exact','lookup',1,?1,?1)",
                params![now],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO word_mark_exceptions (id, rule_id, book_id, normalized_word, location, excluded, created_at, updated_at)
                 VALUES ('wme1','wm1','b1','ostensibly','epubcfi(/6/2)',1,?1,?1)",
                params![now],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO language_assessments (id, exam_type, overall_score, reading_score, exam_date, mapping_version, estimated_cefr, confidence, created_at, updated_at)
                 VALUES ('la1','ielts',6.5,7.0,'2025-03-09','test-v1','B2','official_band_approximation',?1,?1)",
                params![now],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO book_index_state (book_id, source_sha256, index_version, chunk_count, status, error, indexed_at)
                 VALUES ('b1','hash-1',1,3,'ready',NULL,?1)",
                params![now],
            )
            .unwrap();
            for (id, chunk_index, section_index, text, snippet) in [
                (
                    "bc1",
                    0_i64,
                    0_i64,
                    "present signal in chapter one",
                    "present signal",
                ),
                (
                    "bc2",
                    1,
                    0,
                    "nearby context in chapter one",
                    "nearby context",
                ),
                (
                    "bc3",
                    2,
                    1,
                    "future secret after the cutoff",
                    "future secret",
                ),
            ] {
                conn.execute(
                    "INSERT INTO book_chunks (id, book_id, chunk_index, section_index, section_href, section_title, char_start, char_end, text, snippet, token_estimate, created_at)
                     VALUES (?1,'b1',?2,?3,?4,?5,?6,?7,?8,?9,8,?10)",
                    params![
                        id,
                        chunk_index,
                        section_index,
                        format!("section-{section_index}.xhtml"),
                        format!("Section {section_index}"),
                        chunk_index * 100,
                        chunk_index * 100 + 99,
                        text,
                        snippet,
                        now
                    ],
                )
                .unwrap();
                conn.execute(
                    "INSERT INTO book_chunks_fts (seg_text, chunk_id, book_id) VALUES (?1,?2,'b1')",
                    params![text, id],
                )
                .unwrap();
            }
            conn.execute(
                "INSERT INTO book_summaries (id, book_id, scope, section_index, section_title, content, language, model, source_sha256, created_at, updated_at)
                 VALUES ('bs-book','b1','book',NULL,NULL,'whole book secret','en','gpt-test','hash-1',?1,?1),
                        ('bs-0','b1','section',0,'Section 0','safe section summary','en','gpt-test','hash-1',?1,?1),
                        ('bs-1','b1','section',1,'Section 1','future section summary','en','gpt-test','hash-1',?1,?1)",
                params![now],
            )
            .unwrap();
        }
        (dir, McpState::new(db, None, None))
    }

    fn seeded_writable() -> (TempDir, McpState) {
        let (dir, state) = seeded();
        {
            let conn = state.db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO settings (key, value) VALUES ('mcp_write_enabled', 'true')
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [],
            )
            .unwrap();
            let now: i64 = 1_700_000_000_001;
            conn.execute(
                "INSERT INTO books (id, title, author, file_path, status, progress, created_at, updated_at)
                 VALUES ('b2','Second Title','Second Author','books/test2.epub','unread',0,?1,?1)",
                params![now],
            )
            .unwrap();
        }
        let writable = McpState::new(
            state.db.clone(),
            Some(SyncWriter::new("mcp-test".to_string())),
            None,
        );
        (dir, writable)
    }

    fn text_of(result: rmcp::model::CallToolResult) -> String {
        assert_eq!(result.is_error, Some(false), "tool returned is_error=true");
        let first = result
            .content
            .into_iter()
            .next()
            .expect("tool returned no content");
        match first.raw {
            rmcp::model::RawContent::Text(t) => t.text,
            other => panic!("expected text content, got {other:?}"),
        }
    }

    #[test]
    fn tool_router_registers_all_tools() {
        let router = QuillMcpHandler::tool_router();
        let names: std::collections::BTreeSet<_> = router
            .list_all()
            .into_iter()
            .map(|t| t.name.to_string())
            .collect();
        let expected: std::collections::BTreeSet<_> = [
            "list_books",
            "get_book",
            "get_collections",
            "get_highlights",
            "get_bookmarks",
            "get_vocab_words",
            "get_vocab_stats",
            "get_chat_history",
            "add_book",
            "update_book",
            "delete_book",
            "create_collection",
            "rename_collection",
            "delete_collection",
            "add_book_to_collection",
            "remove_book_from_collection",
            "import_books",
            "delete_books",
            "add_books_to_collection",
            "remove_books_from_collection",
            "get_collection_books",
            "search_book_content",
            "get_book_summaries",
            "get_book_index_status",
            "request_book_index",
            "get_notes",
            "get_lookup_history",
            "get_word_marks",
            "get_language_profile",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(names, expected, "tool registry diverged from spec");
    }

    #[tokio::test]
    async fn get_info_advertises_tools_capability() {
        let (_dir, state) = seeded();
        let handler = QuillMcpHandler::new(state);
        let info = handler.get_info();
        assert!(
            info.capabilities.tools.is_some(),
            "tools capability missing"
        );
        assert_eq!(info.server_info.name, "quill");
    }

    #[tokio::test]
    async fn list_books_returns_seeded_book_without_available_field() {
        let (_dir, state) = seeded();
        let handler = QuillMcpHandler::new(state);
        let args = crate::mcp::tools::library::ListBooksArgs {
            filter: None,
            search: None,
        };
        let result = handler.list_books(Parameters(args)).await.unwrap();
        let body = text_of(result);
        let arr: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(arr[0]["id"], serde_json::json!("b1"));
        assert_eq!(arr[0]["title"], serde_json::json!("Test Title"));
        assert_eq!(arr[0]["file_path"], serde_json::json!("books/test.epub"));
        assert!(
            arr[0].get("available").is_none(),
            "MCP response must not include `available` — see McpBook DTO"
        );
    }

    #[tokio::test]
    async fn get_book_returns_relative_paths_only() {
        let (_dir, state) = seeded();
        let handler = QuillMcpHandler::new(state);
        let args = crate::mcp::tools::library::GetBookArgs {
            book_id: "b1".to_string(),
        };
        let body = text_of(handler.get_book(Parameters(args)).await.unwrap());
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["file_path"], serde_json::json!("books/test.epub"));
        assert!(
            !v["file_path"].as_str().unwrap().starts_with('/'),
            "file_path must be relative — leaks home dir layout if absolute"
        );
    }

    #[tokio::test]
    async fn get_collections_returns_book_count() {
        let (_dir, state) = seeded();
        let handler = QuillMcpHandler::new(state);
        let body = text_of(handler.get_collections().await.unwrap());
        let arr: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(arr[0]["name"], serde_json::json!("Favorites"));
        assert_eq!(arr[0]["book_count"], serde_json::json!(1));
    }

    #[tokio::test]
    async fn get_highlights_includes_text_content() {
        let (_dir, state) = seeded();
        let handler = QuillMcpHandler::new(state);
        let args = crate::mcp::tools::highlights::GetHighlightsArgs {
            book_id: "b1".to_string(),
        };
        let body = text_of(handler.get_highlights(Parameters(args)).await.unwrap());
        let arr: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(arr[0]["text_content"], serde_json::json!("quoted passage"));
        assert_eq!(arr[0]["note"], serde_json::json!("my note"));
    }

    #[tokio::test]
    async fn get_bookmarks_returns_label() {
        let (_dir, state) = seeded();
        let handler = QuillMcpHandler::new(state);
        let args = crate::mcp::tools::bookmarks::GetBookmarksArgs {
            book_id: "b1".to_string(),
        };
        let body = text_of(handler.get_bookmarks(Parameters(args)).await.unwrap());
        let arr: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(arr[0]["label"], serde_json::json!("Ch1"));
    }

    #[tokio::test]
    async fn get_vocab_words_and_stats_align() {
        let (_dir, state) = seeded();
        let handler = QuillMcpHandler::new(state);
        let words_body = text_of(
            handler
                .get_vocab_words(Parameters(crate::mcp::tools::vocab::GetVocabWordsArgs {
                    book_id: Some("b1".to_string()),
                    due_only: None,
                }))
                .await
                .unwrap(),
        );
        let words: serde_json::Value = serde_json::from_str(&words_body).unwrap();
        assert_eq!(words[0]["word"], serde_json::json!("ostensibly"));
        assert_eq!(words[0]["mastery"], serde_json::json!("learning"));

        let stats_body = text_of(handler.get_vocab_stats().await.unwrap());
        let stats: serde_json::Value = serde_json::from_str(&stats_body).unwrap();
        assert_eq!(stats["total"], serde_json::json!(1));
        assert_eq!(stats["learning_count"], serde_json::json!(1));
    }

    #[tokio::test]
    async fn get_chat_history_bundles_messages() {
        let (_dir, state) = seeded();
        let handler = QuillMcpHandler::new(state);
        let args = crate::mcp::tools::chats::GetChatHistoryArgs {
            book_id: "b1".to_string(),
            chat_id: None,
        };
        let body = text_of(handler.get_chat_history(Parameters(args)).await.unwrap());
        let arr: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(arr[0]["title"], serde_json::json!("First chat"));
        assert_eq!(arr[0]["messages"][0]["content"], serde_json::json!("hello"));
    }

    #[tokio::test]
    async fn get_collection_books_returns_full_book_projection() {
        let (_dir, state) = seeded();
        let handler = QuillMcpHandler::new(state);
        let body = text_of(
            handler
                .get_collection_books(Parameters(
                    crate::mcp::tools::library_batch::GetCollectionBooksArgs {
                        collection_id: "c1".to_string(),
                        filter: None,
                        search: None,
                    },
                ))
                .await
                .unwrap(),
        );
        let books: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(books.as_array().unwrap().len(), 1);
        assert_eq!(books[0]["id"], "b1");
        assert!(books[0].get("available").is_none());
    }

    #[tokio::test]
    async fn content_tools_apply_spoiler_cutoff_and_report_index_details() {
        let (_dir, state) = seeded();
        let handler = QuillMcpHandler::new(state);

        let safe_body = text_of(
            handler
                .search_book_content(Parameters(
                    crate::mcp::tools::content::SearchBookContentArgs {
                        book_id: "b1".to_string(),
                        query: "present signal".to_string(),
                        top_k: Some(5),
                    },
                ))
                .await
                .unwrap(),
        );
        let safe: serde_json::Value = serde_json::from_str(&safe_body).unwrap();
        assert_eq!(safe["index_status"], "ready");
        assert_eq!(safe["spoiler_guard_active"], true);
        assert!(!safe["results"].as_array().unwrap().is_empty());

        let blocked_body = text_of(
            handler
                .search_book_content(Parameters(
                    crate::mcp::tools::content::SearchBookContentArgs {
                        book_id: "b1".to_string(),
                        query: "future secret".to_string(),
                        top_k: None,
                    },
                ))
                .await
                .unwrap(),
        );
        let blocked: serde_json::Value = serde_json::from_str(&blocked_body).unwrap();
        assert!(blocked["results"].as_array().unwrap().is_empty());

        let summary_body = text_of(
            handler
                .get_book_summaries(Parameters(
                    crate::mcp::tools::content::GetBookSummariesArgs {
                        book_id: "b1".to_string(),
                        scope: None,
                        section_index: None,
                    },
                ))
                .await
                .unwrap(),
        );
        let summaries: serde_json::Value = serde_json::from_str(&summary_body).unwrap();
        assert!(summaries["overview"].is_null());
        assert_eq!(summaries["sections"].as_array().unwrap().len(), 1);
        assert_eq!(summaries["sections"][0]["section_index"], 0);

        let status_body = text_of(
            handler
                .get_book_index_status(Parameters(crate::mcp::tools::content::BookIdArgs {
                    book_id: "b1".to_string(),
                }))
                .await
                .unwrap(),
        );
        let status: serde_json::Value = serde_json::from_str(&status_body).unwrap();
        assert_eq!(status["chunk_count"], 3);
        assert_eq!(status["index_version"], 1);

        handler
            .state
            .db
            .conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO settings (key, value) VALUES ('book_spoiler_guard_b1', 'off')",
                [],
            )
            .unwrap();
        let unlocked_body = text_of(
            handler
                .search_book_content(Parameters(
                    crate::mcp::tools::content::SearchBookContentArgs {
                        book_id: "b1".to_string(),
                        query: "future secret".to_string(),
                        top_k: None,
                    },
                ))
                .await
                .unwrap(),
        );
        let unlocked: serde_json::Value = serde_json::from_str(&unlocked_body).unwrap();
        assert_eq!(unlocked["spoiler_guard_active"], false);
        assert!(!unlocked["results"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn learning_tools_return_safe_projections() {
        let (_dir, state) = seeded();
        let handler = QuillMcpHandler::new(state);

        let notes_body = text_of(
            handler
                .get_notes(Parameters(crate::mcp::tools::learning::GetNotesArgs {
                    book_id: Some("b1".to_string()),
                    word: Some("Ostensibly".to_string()),
                    cursor: None,
                    limit: None,
                }))
                .await
                .unwrap(),
        );
        let notes: serde_json::Value = serde_json::from_str(&notes_body).unwrap();
        assert_eq!(notes["notes"].as_array().unwrap().len(), 1);
        assert_eq!(notes["notes"][0]["content"], "word note");

        let lookup_body = text_of(
            handler
                .get_lookup_history(Parameters(
                    crate::mcp::tools::learning::GetLookupHistoryArgs {
                        book_id: Some("b1".to_string()),
                        cursor: None,
                        limit: None,
                    },
                ))
                .await
                .unwrap(),
        );
        let lookup: serde_json::Value = serde_json::from_str(&lookup_body).unwrap();
        assert_eq!(lookup["records"][0]["lookup_count"], 2);
        assert!(lookup["records"][0].get("result_json").is_none());
        assert!(lookup["records"][0].get("provider_profile_id").is_none());
        assert!(!lookup_body.contains("profile-secret"));

        let marks_body = text_of(
            handler
                .get_word_marks(Parameters(crate::mcp::tools::learning::GetWordMarksArgs {
                    book_id: "b1".to_string(),
                }))
                .await
                .unwrap(),
        );
        let marks: serde_json::Value = serde_json::from_str(&marks_body).unwrap();
        assert_eq!(marks["rules"][0]["normalized_word"], "ostensibly");
        assert_eq!(marks["exceptions"].as_array().unwrap().len(), 1);
        assert!(!marks_body.contains("updated_by_device"));

        let profile_body = text_of(handler.get_language_profile().await.unwrap());
        let profile: serde_json::Value = serde_json::from_str(&profile_body).unwrap();
        assert_eq!(profile["summary"]["estimated_cefr"], "B2");
        assert_eq!(profile["assessments"][0]["exam_type"], "ielts");

        handler
            .state
            .db
            .conn
            .lock()
            .unwrap()
            .execute("DELETE FROM language_assessments", [])
            .unwrap();
        let empty_body = text_of(handler.get_language_profile().await.unwrap());
        let empty: serde_json::Value = serde_json::from_str(&empty_body).unwrap();
        assert!(empty["summary"].is_null());
        assert!(empty["assessments"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn batch_collection_membership_reports_noop_success_and_missing() {
        let (_dir, state) = seeded_writable();
        let handler = QuillMcpHandler::new(state);
        let body = text_of(
            handler
                .add_books_to_collection(Parameters(
                    crate::mcp::tools::library_batch::CollectionBooksArgs {
                        collection_id: "c1".to_string(),
                        book_ids: vec!["b1".to_string(), "b2".to_string(), "missing".to_string()],
                    },
                ))
                .await
                .unwrap(),
        );
        let response: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(response["results"][0]["status"], "noop");
        assert_eq!(response["results"][1]["status"], "ok");
        assert_eq!(response["results"][2]["status"], "not_found");
        assert_eq!(response["changed"], serde_json::json!(["b2"]));
    }

    #[tokio::test]
    async fn batch_import_continues_after_unsupported_and_missing_inputs() {
        let (dir, state) = seeded_writable();
        let handler = QuillMcpHandler::new(state);
        let valid = dir.path().join("sample.txt");
        let unsupported = dir.path().join("sample.bin");
        let missing = dir.path().join("missing.txt");
        std::fs::write(&valid, "Chapter 1\n\nA short importable book.").unwrap();
        std::fs::write(&unsupported, [0_u8, 1, 2, 3]).unwrap();

        let body = text_of(
            handler
                .import_books(Parameters(
                    crate::mcp::tools::library_batch::ImportBooksArgs {
                        file_paths: vec![
                            valid.to_string_lossy().to_string(),
                            unsupported.to_string_lossy().to_string(),
                            missing.to_string_lossy().to_string(),
                        ],
                    },
                ))
                .await
                .unwrap(),
        );
        let response: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(response["imported"].as_array().unwrap().len(), 1);
        assert_eq!(response["results"][0]["status"], "ok");
        assert_eq!(response["results"][1]["status"], "unsupported");
        assert_eq!(response["results"][2]["status"], "error");
    }

    #[tokio::test]
    async fn write_tools_keep_existing_gate() {
        let (_dir, state) = seeded();
        let handler = QuillMcpHandler::new(state);
        let batch_error = handler
            .delete_books(Parameters(
                crate::mcp::tools::library_batch::DeleteBooksArgs {
                    book_ids: vec!["b1".to_string()],
                },
            ))
            .await
            .unwrap_err();
        assert!(batch_error.message.contains("Write access"));

        let index_error = handler
            .request_book_index(Parameters(crate::mcp::tools::content::BookIdArgs {
                book_id: "b1".to_string(),
            }))
            .await
            .unwrap_err();
        assert!(index_error.message.contains("Write access"));
    }
}

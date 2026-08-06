use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ContentBlock};
use rmcp::tool;
use rmcp::tool_router;
use rmcp::ErrorData;
use schemars::JsonSchema;
use serde::Deserialize;

use crate::commands::vocab;
use crate::mcp::server::LanternMcpHandler;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct GetVocabWordsArgs {
    /// Optional book ID. Omit for vocabulary across the full library.
    #[serde(default)]
    pub book_id: Option<String>,
    /// When true, return only words currently due for review.
    #[serde(default)]
    pub due_only: Option<bool>,
}

#[tool_router(router = vocab_router, vis = "pub(crate)")]
impl LanternMcpHandler {
    #[tool(
        description = "List vocabulary words for one book or the full library, optionally limited to words due for review. Includes FSRS stability, difficulty, interval, and last-review fields."
    )]
    pub async fn get_vocab_words(
        &self,
        Parameters(GetVocabWordsArgs { book_id, due_only }): Parameters<GetVocabWordsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let mut words = match (book_id.as_deref(), due_only.unwrap_or(false)) {
            // `query_vocab_words` / `query_all_vocab_words` are shared with the
            // in-text three-stage annotation path and deliberately return every
            // row regardless of `list_status` (see the doc comment on
            // `query_vocab_words` in commands/vocab.rs). The MCP tool is a
            // reader-facing surface — an AI client speaks for the reader here —
            // so the observation zone (`list_status = 'watchlist'`, see
            // docs/impls/reading-flow-decisions-2026-08-06.md §1.3/§5.3) must
            // never reach it. `query_vocab_due` already filters at the SQL
            // level; the other two are filtered below.
            (Some(book_id), false) => vocab::query_vocab_words(&self.state.db, book_id),
            (None, false) => vocab::query_all_vocab_words(&self.state.db),
            (_, true) => vocab::query_vocab_due(&self.state.db),
        }
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        words.retain(|word| word.list_status == "confirmed");
        if due_only.unwrap_or(false) {
            if let Some(book_id) = book_id.as_deref() {
                words.retain(|word| word.book_id == book_id);
            }
        }
        Ok(CallToolResult::success(vec![ContentBlock::json(&words)?]))
    }

    #[tool(
        description = "Return aggregate vocabulary counts: total, new, learning, familiar, mastered, and due_for_review across all books."
    )]
    pub async fn get_vocab_stats(&self) -> Result<CallToolResult, ErrorData> {
        // `query_vocab_stats` already filters every count to
        // `list_status = 'confirmed'` — nothing to filter here.
        let stats = vocab::query_vocab_stats(&self.state.db)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        Ok(CallToolResult::success(vec![ContentBlock::json(&stats)?]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use crate::mcp::McpState;
    use rusqlite::params;
    use serde_json::Value;

    /// One book, one confirmed word, one word still sitting in the
    /// observation zone (`list_status = 'watchlist'`) — see migration 044
    /// and docs/impls/reading-flow-decisions-2026-08-06.md §1.3/§5.3.
    fn seed_db() -> (tempfile::TempDir, Db) {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::init(dir.path()).unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO books (id, title, author, file_path, format, status, progress, created_at, updated_at)
                 VALUES ('book', 'Book', 'Author', 'books/book.epub', 'epub', 'reading', 0, 1, 1)",
                [],
            )
            .unwrap();
            for (id, word, list_status) in [
                ("v-confirmed", "steadfast", "confirmed"),
                ("v-watchlist", "ephemeral", "watchlist"),
            ] {
                conn.execute(
                    "INSERT INTO vocab_words
                     (id, book_id, word, definition, mastery, review_count, list_status,
                      created_at, updated_at)
                     VALUES (?1, 'book', ?2, 'a definition', 'new', 0, ?3, 1, 1)",
                    params![id, word, list_status],
                )
                .unwrap();
            }
        }
        (dir, db)
    }

    fn text_of(result: CallToolResult) -> String {
        assert_eq!(result.is_error, Some(false), "tool returned is_error=true");
        match result.content.into_iter().next().expect("no content") {
            ContentBlock::Text(t) => t.text,
            other => panic!("expected text content, got {other:?}"),
        }
    }

    /// Regression for the MCP watchlist leak: an AI client asking for a
    /// book's vocabulary (or the whole library's) must never see a word
    /// still sitting in the observation zone, even though the underlying
    /// `query_vocab_words` / `query_all_vocab_words` helpers stay
    /// unfiltered for the in-text annotation path.
    #[tokio::test]
    async fn get_vocab_words_excludes_the_observation_zone() {
        let (_dir, db) = seed_db();
        let handler = LanternMcpHandler::new(McpState::new(db, None, None));

        let by_book = handler
            .get_vocab_words(Parameters(GetVocabWordsArgs {
                book_id: Some("book".into()),
                due_only: None,
            }))
            .await
            .unwrap();
        let words: Value = serde_json::from_str(&text_of(by_book)).unwrap();
        let words = words.as_array().unwrap();
        assert_eq!(
            words.len(),
            1,
            "watchlist row leaked through get_vocab_words(book_id): {words:?}"
        );
        assert_eq!(words[0]["word"], "steadfast");

        let across_library = handler
            .get_vocab_words(Parameters(GetVocabWordsArgs {
                book_id: None,
                due_only: None,
            }))
            .await
            .unwrap();
        let words: Value = serde_json::from_str(&text_of(across_library)).unwrap();
        let words = words.as_array().unwrap();
        assert_eq!(
            words.len(),
            1,
            "watchlist row leaked through get_vocab_words(全库): {words:?}"
        );
        assert_eq!(words[0]["word"], "steadfast");
    }

    #[tokio::test]
    async fn get_vocab_stats_excludes_the_observation_zone() {
        let (_dir, db) = seed_db();
        let handler = LanternMcpHandler::new(McpState::new(db, None, None));

        let result = handler.get_vocab_stats().await.unwrap();
        let stats: Value = serde_json::from_str(&text_of(result)).unwrap();
        assert_eq!(
            stats["total"], 1,
            "watchlist row inflated get_vocab_stats total: {stats:?}"
        );
    }
}

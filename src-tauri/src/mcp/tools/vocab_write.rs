use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ContentBlock};
use rmcp::{tool, tool_router, ErrorData};
use rusqlite::OptionalExtension;
use schemars::JsonSchema;
use serde::Deserialize;
use std::collections::HashSet;

use crate::commands::{lookup_history, vocab, word_marks};
use crate::mcp::server::LanternMcpHandler;
use crate::mcp::tools::annotations_write::{validate_ids, DeleteIdsArgs};
use crate::mcp::tools::library::require_sync;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct CreateVocabWordArgs {
    pub book_id: String,
    pub word: String,
    pub definition: String,
    #[serde(default)]
    pub context_sentence: Option<String>,
    #[serde(default)]
    pub context_explanation: Option<String>,
    #[serde(default)]
    pub cfi: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum VocabReviewRatingArg {
    Again,
    Hard,
    Good,
    Easy,
}

impl From<VocabReviewRatingArg> for vocab::VocabReviewRating {
    fn from(value: VocabReviewRatingArg) -> Self {
        match value {
            VocabReviewRatingArg::Again => Self::Again,
            VocabReviewRatingArg::Hard => Self::Hard,
            VocabReviewRatingArg::Good => Self::Good,
            VocabReviewRatingArg::Easy => Self::Easy,
        }
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct RecordVocabReviewArgs {
    pub id: String,
    pub rating: VocabReviewRatingArg,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SetVocabMasteryArgs {
    /// Vocabulary IDs to update. Accepts one or many IDs.
    pub ids: Vec<String>,
    /// One of `new`, `learning`, or `mastered`.
    pub mastery: String,
    #[serde(default)]
    pub next_review_at: Option<i64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SetWordFormsArgs {
    pub word: String,
    pub forms: Vec<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SetWordMarkRuleArgs {
    pub book_id: String,
    pub word: String,
    pub enabled: bool,
    #[serde(default)]
    pub color: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SetWordMarkExceptionArgs {
    pub book_id: String,
    pub word: String,
    pub location: String,
    pub excluded: bool,
    #[serde(default)]
    pub match_forms: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SetLookupOccurrenceMarkArgs {
    pub book_id: String,
    pub word: String,
    pub location: String,
    pub enabled: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DeleteWordFormsArgs {
    /// Words whose saved form sets will be permanently deleted.
    pub words: Vec<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ClearWordMarksArgs {
    /// Book whose whole-book rules, occurrence marks, and exclusions will be cleared.
    pub book_id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ClearLookupHistoryArgs {
    /// Limit clearing to one book. Omit to clear all lookup history.
    #[serde(default)]
    pub book_id: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SaveLookupRecordArgs {
    pub book_id: String,
    pub lookup_text: String,
    #[serde(default)]
    pub context_sentence: Option<String>,
    #[serde(default)]
    pub chapter: Option<String>,
    #[serde(default)]
    pub cfi: Option<String>,
    pub definition: String,
    #[serde(default)]
    pub context_explanation: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum VocabImportFormatArg {
    Json,
    Csv,
}

impl From<VocabImportFormatArg> for vocab::VocabImportFormat {
    fn from(value: VocabImportFormatArg) -> Self {
        match value {
            VocabImportFormatArg::Json => Self::Json,
            VocabImportFormatArg::Csv => Self::Csv,
        }
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum VocabImportConflictPolicyArg {
    Skip,
    Merge,
    Overwrite,
}

impl From<VocabImportConflictPolicyArg> for vocab::VocabImportConflictPolicy {
    fn from(value: VocabImportConflictPolicyArg) -> Self {
        match value {
            VocabImportConflictPolicyArg::Skip => Self::Skip,
            VocabImportConflictPolicyArg::Merge => Self::Merge,
            VocabImportConflictPolicyArg::Overwrite => Self::Overwrite,
        }
    }
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum VocabImportMode {
    Preview,
    #[default]
    Execute,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ImportVocabArgs {
    /// Complete Lantern vocabulary backup contents.
    pub data: String,
    pub format: VocabImportFormatArg,
    #[serde(default)]
    pub mode: VocabImportMode,
    #[serde(default = "default_vocab_import_conflict_policy")]
    pub conflict_policy: VocabImportConflictPolicyArg,
}

fn default_vocab_import_conflict_policy() -> VocabImportConflictPolicyArg {
    VocabImportConflictPolicyArg::Skip
}

fn delete_lookup_records_inner(
    ids: &[String],
    db: &crate::db::Db,
) -> crate::error::AppResult<usize> {
    let mut conn = db
        .conn
        .lock()
        .map_err(|error| crate::error::AppError::Other(error.to_string()))?;
    let transaction = conn.transaction()?;
    let mut deleted = 0;
    for id in ids {
        deleted += transaction.execute(
            "DELETE FROM lookup_records WHERE id = ?1",
            rusqlite::params![id],
        )?;
    }
    transaction.commit()?;
    Ok(deleted)
}

fn save_lookup_record_inner(
    args: SaveLookupRecordArgs,
    db: &crate::db::Db,
) -> crate::error::AppResult<lookup_history::LookupRecord> {
    let normalized_text = args
        .lookup_text
        .trim_matches(|character: char| !character.is_alphanumeric() && character != '\'')
        .to_lowercase();
    if normalized_text.is_empty() {
        return Err(crate::error::AppError::Other(
            "Lookup text cannot be empty".to_string(),
        ));
    }
    let now = chrono::Utc::now().timestamp_millis();
    let conn = db
        .conn
        .lock()
        .map_err(|error| crate::error::AppError::Other(error.to_string()))?;
    let existing = args
        .cfi
        .as_deref()
        .filter(|cfi| !cfi.is_empty())
        .map(|cfi| {
            conn.query_row(
                "SELECT id, created_at, lookup_count FROM lookup_records
                 WHERE book_id = ?1 AND cfi = ?2 AND normalized_text = ?3 LIMIT 1",
                rusqlite::params![args.book_id, cfi, normalized_text],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .optional()
        })
        .transpose()?
        .flatten();
    let (id, created_at, lookup_count) = match existing {
        Some((id, created_at, lookup_count)) => {
            conn.execute(
                "UPDATE lookup_records SET lookup_text = ?1, context_sentence = ?2,
                 chapter = ?3, definition = ?4, context_explanation = ?5,
                 result_json = NULL, provider_profile_id = NULL, model = ?6,
                 last_looked_up_at = ?7, updated_at = ?7,
                 lookup_count = lookup_count + 1 WHERE id = ?8",
                rusqlite::params![
                    args.lookup_text,
                    args.context_sentence,
                    args.chapter,
                    args.definition,
                    args.context_explanation,
                    args.model,
                    now,
                    id
                ],
            )?;
            (id, created_at, lookup_count + 1)
        }
        None => {
            let id = uuid::Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO lookup_records
                 (id, book_id, lookup_text, normalized_text, context_sentence, chapter,
                  cfi, definition, context_explanation, result_json, provider_profile_id,
                  model, created_at, last_looked_up_at, updated_at, lookup_count)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, NULL, ?10,
                         ?11, ?11, ?11, 1)",
                rusqlite::params![
                    id,
                    args.book_id,
                    args.lookup_text,
                    normalized_text,
                    args.context_sentence,
                    args.chapter,
                    args.cfi,
                    args.definition,
                    args.context_explanation,
                    args.model,
                    now
                ],
            )?;
            (id, now, 1)
        }
    };
    let retention_days = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'lookup_history_retention_days'",
            [],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|days| *days > 0);
    if let Some(days) = retention_days {
        let cutoff = now - days.saturating_mul(24 * 60 * 60 * 1000);
        conn.execute(
            "DELETE FROM lookup_records WHERE last_looked_up_at < ?1",
            rusqlite::params![cutoff],
        )?;
    }
    Ok(lookup_history::LookupRecord {
        id,
        book_id: args.book_id,
        lookup_text: args.lookup_text,
        normalized_text,
        context_sentence: args.context_sentence,
        chapter: args.chapter,
        cfi: args.cfi,
        definition: args.definition,
        context_explanation: args.context_explanation,
        created_at,
        last_looked_up_at: now,
        lookup_count,
        result_json: None,
        provider_profile_id: None,
        model: args.model,
        updated_at: now,
        book_title: None,
    })
}

fn clear_lookup_history_inner(
    book_id: Option<&str>,
    db: &crate::db::Db,
) -> crate::error::AppResult<usize> {
    let conn = db
        .conn
        .lock()
        .map_err(|error| crate::error::AppError::Other(error.to_string()))?;
    match book_id.filter(|id| !id.trim().is_empty()) {
        Some(book_id) => Ok(conn.execute(
            "DELETE FROM lookup_records WHERE book_id = ?1",
            rusqlite::params![book_id],
        )?),
        None => Ok(conn.execute("DELETE FROM lookup_records", [])?),
    }
}

#[tool_router(router = vocab_write_router, vis = "pub(crate)")]
impl LanternMcpHandler {
    #[tool(
        description = "Save or refresh one dictionary lookup-history record without invoking an AI service. Raw provider result data and provider identifiers are not accepted."
    )]
    pub async fn save_lookup_record(
        &self,
        Parameters(args): Parameters<SaveLookupRecordArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        require_sync(self)?;
        let record = save_lookup_record_inner(args, &self.state.db)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        self.state.notify("lookup_history", "updated", &record.id);
        Ok(CallToolResult::success(vec![ContentBlock::json(&record)?]))
    }

    #[tool(
        description = "Save a vocabulary word for a book. If the same word already exists for that book, returns the existing entry without changing it."
    )]
    pub async fn create_vocab_word(
        &self,
        Parameters(CreateVocabWordArgs {
            book_id,
            word,
            definition,
            context_sentence,
            context_explanation,
            cfi,
        }): Parameters<CreateVocabWordArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let sync = require_sync(self)?;
        let entry = vocab::add_vocab_word_inner(
            &book_id,
            &word,
            &definition,
            context_sentence,
            context_explanation,
            cfi,
            &self.state.db,
            sync,
        )
        .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        self.state.notify("vocabulary", "created", &entry.id);
        Ok(CallToolResult::success(vec![ContentBlock::json(&entry)?]))
    }

    #[tool(
        description = "Record an FSRS vocabulary review with a rating of `again`, `hard`, `good`, or `easy`."
    )]
    pub async fn record_vocab_review(
        &self,
        Parameters(RecordVocabReviewArgs { id, rating }): Parameters<RecordVocabReviewArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let sync = require_sync(self)?;
        let entry = vocab::record_vocab_review_inner(&id, rating.into(), &self.state.db, sync)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        self.state.notify("vocabulary", "reviewed", &entry.id);
        Ok(CallToolResult::success(vec![ContentBlock::json(&entry)?]))
    }

    #[tool(
        description = "Set a vocabulary word's mastery state and optional next review timestamp without recording a review."
    )]
    pub async fn set_vocab_mastery(
        &self,
        Parameters(SetVocabMasteryArgs {
            ids,
            mastery,
            next_review_at,
        }): Parameters<SetVocabMasteryArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let ids = validate_ids(ids, "ids")?;
        let sync = require_sync(self)?;
        vocab::bulk_update_vocab_mastery_inner(
            &ids,
            &mastery,
            next_review_at,
            &self.state.db,
            sync,
        )
        .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        let requested = ids.iter().collect::<HashSet<_>>();
        let entries = vocab::query_all_vocab_words(&self.state.db)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?
            .into_iter()
            .filter(|entry| requested.contains(&entry.id))
            .collect::<Vec<_>>();
        self.state
            .notify("vocabulary", "updated", &entries.len().to_string());
        Ok(CallToolResult::success(vec![ContentBlock::json(&entries)?]))
    }

    #[tool(
        description = "Set user-maintained alternate forms for a word. This local setting does not invoke an AI model."
    )]
    pub async fn set_word_forms(
        &self,
        Parameters(SetWordFormsArgs { word, forms }): Parameters<SetWordFormsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        if forms.is_empty() {
            return Err(ErrorData::invalid_params(
                "`forms` must contain at least one item",
                None,
            ));
        }
        require_sync(self)?;
        let forms = word_marks::set_word_forms_inner(
            &word,
            forms,
            Some("user".to_string()),
            &self.state.db,
        )
        .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        self.state.notify("word_forms", "updated", &word);
        Ok(CallToolResult::success(vec![ContentBlock::json(
            serde_json::json!({ "word": word, "forms": forms, "source": "user" }),
        )?]))
    }

    #[tool(
        description = "Create or update a whole-book word-mark rule, including whether the mark is enabled."
    )]
    pub async fn set_word_mark_rule(
        &self,
        Parameters(SetWordMarkRuleArgs {
            book_id,
            word,
            enabled,
            color,
        }): Parameters<SetWordMarkRuleArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let sync = require_sync(self)?;
        let rule = word_marks::set_word_mark_rule_enabled_inner(
            &book_id,
            &word,
            enabled,
            color.as_deref(),
            &self.state.db,
            sync,
        )
        .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        self.state.notify("word_marks", "updated", &book_id);
        Ok(CallToolResult::success(vec![ContentBlock::json(&rule)?]))
    }

    #[tool(
        description = "Set whether one occurrence is excluded from an enabled whole-book word mark."
    )]
    pub async fn set_word_mark_exception(
        &self,
        Parameters(SetWordMarkExceptionArgs {
            book_id,
            word,
            location,
            excluded,
            match_forms,
        }): Parameters<SetWordMarkExceptionArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let sync = require_sync(self)?;
        let exception = word_marks::set_word_mark_exception_inner(
            &book_id,
            &word,
            &location,
            excluded,
            match_forms,
            &self.state.db,
            sync,
        )
        .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        self.state.notify("word_marks", "updated", &book_id);
        Ok(CallToolResult::success(vec![ContentBlock::json(
            &exception,
        )?]))
    }

    #[tool(description = "Set whether one lookup-created word occurrence mark is enabled.")]
    pub async fn set_lookup_occurrence_mark(
        &self,
        Parameters(SetLookupOccurrenceMarkArgs {
            book_id,
            word,
            location,
            enabled,
        }): Parameters<SetLookupOccurrenceMarkArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let sync = require_sync(self)?;
        let mark = word_marks::set_lookup_occurrence_mark_inner(
            &book_id,
            &word,
            &location,
            enabled,
            &self.state.db,
            sync,
        )
        .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        self.state.notify("word_marks", "updated", &book_id);
        Ok(CallToolResult::success(vec![ContentBlock::json(&mark)?]))
    }

    #[tool(
        description = "Permanently delete one or more vocabulary entries and their review state. This action cannot be undone."
    )]
    pub async fn delete_vocab_words(
        &self,
        Parameters(DeleteIdsArgs { ids }): Parameters<DeleteIdsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let ids = validate_ids(ids, "ids")?;
        let sync = require_sync(self)?;
        let deleted = vocab::delete_vocab_words_inner(&ids, &self.state.db, sync)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        self.state
            .notify("vocabulary", "deleted", &deleted.to_string());
        Ok(CallToolResult::success(vec![ContentBlock::json(
            serde_json::json!({ "requested": ids.len(), "deleted": deleted }),
        )?]))
    }

    // Reading vocabulary out is a read: it returns the same rows
    // `query_vocabulary` already returns, only in re-importable form. The write
    // switch guards changes to the library, so it does not apply here.
    #[tool(description = "Return a complete Lantern vocabulary backup as structured JSON.")]
    pub async fn export_vocabulary(&self) -> Result<CallToolResult, ErrorData> {
        let backup = vocab::export_vocab_backup_inner(&self.state.db)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        Ok(CallToolResult::success(vec![ContentBlock::json(&backup)?]))
    }

    #[tool(
        description = "Preview or import vocabulary JSON or CSV. Skip preserves conflicts, merge keeps existing conflicts while importing nonconflicting entries, and overwrite permanently replaces conflicts."
    )]
    pub async fn import_vocabulary(
        &self,
        Parameters(ImportVocabArgs {
            data,
            format,
            mode,
            conflict_policy,
        }): Parameters<ImportVocabArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let sync = require_sync(self)?;
        if matches!(mode, VocabImportMode::Preview) {
            let preview = vocab::preview_vocab_import_inner(&data, format.into(), &self.state.db)
                .map_err(|error| ErrorData::invalid_params(error.to_string(), None))?;
            return Ok(CallToolResult::success(vec![ContentBlock::json(&preview)?]));
        }
        let result = vocab::do_import_vocab_backup(
            &data,
            format.into(),
            conflict_policy.into(),
            false,
            &self.state.db,
            sync,
        )
        .map_err(|error| ErrorData::invalid_params(error.to_string(), None))?;
        self.state.notify("vocabulary", "imported", "backup");
        Ok(CallToolResult::success(vec![ContentBlock::json(&result)?]))
    }

    #[tool(
        description = "Permanently delete saved word-form sets for one or more words. This action cannot be undone."
    )]
    pub async fn delete_word_forms(
        &self,
        Parameters(DeleteWordFormsArgs { words }): Parameters<DeleteWordFormsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        if words.is_empty()
            || words.len() > 500
            || words.iter().any(|word| word.trim().is_empty())
            || words.iter().collect::<HashSet<_>>().len() != words.len()
        {
            return Err(ErrorData::invalid_params(
                "`words` must contain 1 to 500 unique non-empty words",
                None,
            ));
        }
        require_sync(self)?;
        let deleted = word_marks::delete_word_forms_inner(&words, &self.state.db)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        self.state
            .notify("word_forms", "deleted", &deleted.to_string());
        Ok(CallToolResult::success(vec![ContentBlock::json(
            serde_json::json!({ "requested": words.len(), "deleted": deleted }),
        )?]))
    }

    #[tool(
        description = "Clear all whole-book word marks, occurrence marks, and exclusions for one book. This action cannot be undone as one operation."
    )]
    pub async fn clear_word_marks(
        &self,
        Parameters(ClearWordMarksArgs { book_id }): Parameters<ClearWordMarksArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let sync = require_sync(self)?;
        word_marks::clear_lookup_marks_for_book_inner(&book_id, &self.state.db, sync)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        self.state.notify("word_marks", "cleared", &book_id);
        Ok(CallToolResult::success(vec![ContentBlock::json(
            serde_json::json!({ "book_id": book_id, "cleared": true }),
        )?]))
    }

    #[tool(
        description = "Permanently delete one or more dictionary lookup-history records. This action cannot be undone."
    )]
    pub async fn delete_lookup_records(
        &self,
        Parameters(DeleteIdsArgs { ids }): Parameters<DeleteIdsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let ids = validate_ids(ids, "ids")?;
        require_sync(self)?;
        let deleted = delete_lookup_records_inner(&ids, &self.state.db)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        self.state
            .notify("lookup_history", "deleted", &deleted.to_string());
        Ok(CallToolResult::success(vec![ContentBlock::json(
            serde_json::json!({ "requested": ids.len(), "deleted": deleted }),
        )?]))
    }

    #[tool(
        description = "Permanently clear dictionary lookup history for one book or the entire library. This action cannot be undone."
    )]
    pub async fn clear_lookup_history(
        &self,
        Parameters(ClearLookupHistoryArgs { book_id }): Parameters<ClearLookupHistoryArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        if book_id.as_deref().is_some_and(|id| id.trim().is_empty()) {
            return Err(ErrorData::invalid_params(
                "`book_id` must be a non-empty string or null",
                None,
            ));
        }
        require_sync(self)?;
        let deleted = clear_lookup_history_inner(book_id.as_deref(), &self.state.db)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        self.state
            .notify("lookup_history", "cleared", &deleted.to_string());
        Ok(CallToolResult::success(vec![ContentBlock::json(
            serde_json::json!({ "book_id": book_id, "deleted": deleted }),
        )?]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use tempfile::TempDir;

    fn lookup_db() -> (TempDir, Db) {
        let directory = TempDir::new().unwrap();
        let db = Db::init(directory.path()).unwrap();
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO books
                 (id, title, author, file_path, format, status, progress,
                  created_at, updated_at)
                 VALUES ('book', 'Book', 'Author', 'books/book.epub', 'epub',
                         'reading', 0, 1, 1)",
                [],
            )
            .unwrap();
        (directory, db)
    }

    fn lookup_args(definition: &str) -> SaveLookupRecordArgs {
        SaveLookupRecordArgs {
            book_id: "book".into(),
            lookup_text: "Wonder".into(),
            context_sentence: Some("A sentence.".into()),
            chapter: Some("One".into()),
            cfi: Some("epubcfi(/6/2)".into()),
            definition: definition.into(),
            context_explanation: Some("Context".into()),
            model: Some("local".into()),
        }
    }

    #[test]
    fn safe_lookup_write_updates_the_same_occurrence_without_provider_fields() {
        let (_directory, db) = lookup_db();
        let first = save_lookup_record_inner(lookup_args("first"), &db).unwrap();
        let second = save_lookup_record_inner(lookup_args("second"), &db).unwrap();

        assert_eq!(second.id, first.id);
        assert_eq!(second.lookup_count, 2);
        assert_eq!(second.definition, "second");
        assert!(second.result_json.is_none());
        assert!(second.provider_profile_id.is_none());
    }

    #[test]
    fn lookup_delete_helpers_report_exact_affected_rows() {
        let (_directory, db) = lookup_db();
        let first = save_lookup_record_inner(lookup_args("first"), &db).unwrap();
        assert_eq!(delete_lookup_records_inner(&[first.id], &db).unwrap(), 1);
        assert_eq!(clear_lookup_history_inner(None, &db).unwrap(), 0);
    }
}

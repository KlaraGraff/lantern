use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ContentBlock};
use rmcp::{tool, tool_router, ErrorData};
use schemars::JsonSchema;
use serde::Deserialize;

use crate::commands::word_marks;
use crate::mcp::server::LanternMcpHandler;
use crate::mcp::tools::annotations_write::DeleteIdsArgs;
use crate::mcp::tools::content::{BookIdArgs, GetBookContentArgs, SearchBookContentArgs};
use crate::mcp::tools::learning::{GetLookupHistoryArgs, GetWordMarksArgs};
use crate::mcp::tools::library::{GetBookArgs, ListBooksArgs, SetReadingStateArgs, UpdateBookArgs};
use crate::mcp::tools::vocab::GetVocabWordsArgs;
use crate::mcp::tools::vocab_write::{
    ClearLookupHistoryArgs, CreateVocabWordArgs, RecordVocabReviewArgs,
    SetLookupOccurrenceMarkArgs, SetVocabMasteryArgs, SetWordFormsArgs, SetWordMarkExceptionArgs,
    SetWordMarkRuleArgs,
};

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(tag = "query", rename_all = "snake_case")]
pub enum QueryBooksKind {
    List {
        #[serde(default)]
        filter: Option<String>,
        #[serde(default)]
        search: Option<String>,
    },
    Get {
        book_id: String,
    },
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct QueryBooksArgs {
    #[serde(flatten)]
    pub query: QueryBooksKind,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum UpdateBooksAction {
    Metadata {
        book_id: String,
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        author: Option<String>,
        #[serde(default)]
        genre: Option<String>,
        #[serde(default)]
        status: Option<String>,
    },
    ReadingState {
        book_id: String,
        #[serde(default)]
        status: Option<String>,
        #[serde(default)]
        progress: Option<i32>,
        #[serde(default)]
        current_cfi: Option<String>,
        #[serde(default)]
        clear_current_cfi: bool,
    },
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct UpdateBooksArgs {
    #[serde(flatten)]
    pub action: UpdateBooksAction,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum QueryBookContentKind {
    Sections {
        book_id: String,
    },
    Read {
        book_id: String,
        section_start: i64,
        #[serde(default)]
        section_end: Option<i64>,
        #[serde(default)]
        max_tokens: Option<usize>,
    },
    Search {
        book_id: String,
        query: String,
        #[serde(default)]
        top_k: Option<usize>,
    },
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct QueryBookContentArgs {
    #[serde(flatten)]
    pub query: QueryBookContentKind,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(tag = "query", rename_all = "snake_case")]
pub enum QueryVocabularyKind {
    Entries {
        #[serde(default)]
        book_id: Option<String>,
        #[serde(default)]
        due_only: Option<bool>,
    },
    Stats,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct QueryVocabularyArgs {
    #[serde(flatten)]
    pub query: QueryVocabularyKind,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum SaveVocabularyAction {
    Create {
        book_id: String,
        word: String,
        definition: String,
        #[serde(default)]
        context_sentence: Option<String>,
        #[serde(default)]
        context_explanation: Option<String>,
        #[serde(default)]
        cfi: Option<String>,
    },
    RecordReview {
        id: String,
        rating: crate::mcp::tools::vocab_write::VocabReviewRatingArg,
    },
    SetMastery {
        ids: Vec<String>,
        mastery: String,
        #[serde(default)]
        next_review_at: Option<i64>,
    },
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SaveVocabularyArgs {
    #[serde(flatten)]
    pub action: SaveVocabularyAction,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum DeleteLookupHistoryAction {
    Records {
        ids: Vec<String>,
    },
    Clear {
        #[serde(default)]
        book_id: Option<String>,
    },
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DeleteLookupHistoryArgs {
    #[serde(flatten)]
    pub action: DeleteLookupHistoryAction,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(tag = "query", rename_all = "snake_case")]
pub enum QueryWordFormsKind {
    List,
    Get { words: Vec<String> },
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct QueryWordFormsArgs {
    #[serde(flatten)]
    pub query: QueryWordFormsKind,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum UpdateWordMarksAction {
    Rule {
        book_id: String,
        word: String,
        enabled: bool,
        #[serde(default)]
        color: Option<String>,
    },
    Exception {
        book_id: String,
        word: String,
        location: String,
        excluded: bool,
    },
    Occurrence {
        book_id: String,
        word: String,
        location: String,
        enabled: bool,
    },
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct UpdateWordMarksArgs {
    #[serde(flatten)]
    pub action: UpdateWordMarksAction,
}

#[tool_router(router = local_catalog_router, vis = "pub(crate)")]
impl LanternMcpHandler {
    #[tool(
        description = "List or inspect Lantern books, including reading and local file-preparation state.",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = false
        )
    )]
    pub async fn query_books(
        &self,
        Parameters(QueryBooksArgs { query }): Parameters<QueryBooksArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        match query {
            QueryBooksKind::List { filter, search } => {
                self.list_books(Parameters(ListBooksArgs { filter, search }))
                    .await
            }
            QueryBooksKind::Get { book_id } => {
                self.get_book(Parameters(GetBookArgs { book_id })).await
            }
        }
    }

    #[tool(
        description = "Update book metadata or saved reading state without deleting the book.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = false
        )
    )]
    pub async fn update_books(
        &self,
        Parameters(UpdateBooksArgs { action }): Parameters<UpdateBooksArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        match action {
            UpdateBooksAction::Metadata {
                book_id,
                title,
                author,
                genre,
                status,
            } => {
                self.update_book(Parameters(UpdateBookArgs {
                    book_id,
                    title,
                    author,
                    genre,
                    status,
                }))
                .await
            }
            UpdateBooksAction::ReadingState {
                book_id,
                status,
                progress,
                current_cfi,
                clear_current_cfi,
            } => {
                self.set_reading_state(Parameters(SetReadingStateArgs {
                    book_id,
                    status,
                    progress,
                    current_cfi,
                    clear_current_cfi,
                }))
                .await
            }
        }
    }

    #[tool(
        description = "List sections, read a bounded section range, or search a book's local prepared content.",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = false
        )
    )]
    pub async fn query_book_content(
        &self,
        Parameters(QueryBookContentArgs { query }): Parameters<QueryBookContentArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        match query {
            QueryBookContentKind::Sections { book_id } => {
                self.list_book_sections(Parameters(BookIdArgs { book_id }))
                    .await
            }
            QueryBookContentKind::Read {
                book_id,
                section_start,
                section_end,
                max_tokens,
            } => {
                self.get_book_content(Parameters(GetBookContentArgs {
                    book_id,
                    section_start,
                    section_end,
                    max_tokens,
                }))
                .await
            }
            QueryBookContentKind::Search {
                book_id,
                query,
                top_k,
            } => {
                self.search_book_content(Parameters(SearchBookContentArgs {
                    book_id,
                    query,
                    top_k,
                }))
                .await
            }
        }
    }

    #[tool(
        description = "Query vocabulary entries, due reviews, or aggregate review statistics.",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = false
        )
    )]
    pub async fn query_vocabulary(
        &self,
        Parameters(QueryVocabularyArgs { query }): Parameters<QueryVocabularyArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        match query {
            QueryVocabularyKind::Entries { book_id, due_only } => {
                self.get_vocab_words(Parameters(GetVocabWordsArgs { book_id, due_only }))
                    .await
            }
            QueryVocabularyKind::Stats => self.get_vocab_stats().await,
        }
    }

    #[tool(
        description = "Create vocabulary entries, set mastery, or record FSRS review results.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = false
        )
    )]
    pub async fn save_vocabulary(
        &self,
        Parameters(SaveVocabularyArgs { action }): Parameters<SaveVocabularyArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        match action {
            SaveVocabularyAction::Create {
                book_id,
                word,
                definition,
                context_sentence,
                context_explanation,
                cfi,
            } => {
                self.create_vocab_word(Parameters(CreateVocabWordArgs {
                    book_id,
                    word,
                    definition,
                    context_sentence,
                    context_explanation,
                    cfi,
                }))
                .await
            }
            SaveVocabularyAction::RecordReview { id, rating } => {
                self.record_vocab_review(Parameters(RecordVocabReviewArgs { id, rating }))
                    .await
            }
            SaveVocabularyAction::SetMastery {
                ids,
                mastery,
                next_review_at,
            } => {
                self.set_vocab_mastery(Parameters(SetVocabMasteryArgs {
                    ids,
                    mastery,
                    next_review_at,
                }))
                .await
            }
        }
    }

    #[tool(
        name = "delete_vocabulary",
        description = "Permanently delete one or more vocabulary entries and their review state.",
        annotations(
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = false,
            open_world_hint = false
        )
    )]
    pub async fn delete_vocabulary_catalog(
        &self,
        args: Parameters<DeleteIdsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        self.delete_vocab_words(args).await
    }

    #[tool(
        name = "query_lookup_history",
        description = "Return paginated dictionary and reading-action lookup history.",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = false
        )
    )]
    pub async fn query_lookup_history_catalog(
        &self,
        args: Parameters<GetLookupHistoryArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        self.get_lookup_history(args).await
    }

    #[tool(
        description = "Permanently delete selected lookup-history records or clear a book or the full library history.",
        annotations(
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = false,
            open_world_hint = false
        )
    )]
    pub async fn delete_lookup_history(
        &self,
        Parameters(DeleteLookupHistoryArgs { action }): Parameters<DeleteLookupHistoryArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        match action {
            DeleteLookupHistoryAction::Records { ids } => {
                self.delete_lookup_records(Parameters(DeleteIdsArgs { ids }))
                    .await
            }
            DeleteLookupHistoryAction::Clear { book_id } => {
                self.clear_lookup_history(Parameters(ClearLookupHistoryArgs { book_id }))
                    .await
            }
        }
    }

    #[tool(
        description = "List saved word-form sets or return sets for specific words.",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = false
        )
    )]
    pub async fn query_word_forms(
        &self,
        Parameters(QueryWordFormsArgs { query }): Parameters<QueryWordFormsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let forms = match query {
            QueryWordFormsKind::List => word_marks::query_word_forms(&self.state.db),
            QueryWordFormsKind::Get { words } => {
                word_marks::query_word_forms_for(&self.state.db, words)
            }
        }
        .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        Ok(CallToolResult::success(vec![ContentBlock::json(&forms)?]))
    }

    #[tool(
        name = "save_word_forms",
        description = "Create or replace an explicitly supplied local word-form set.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = false
        )
    )]
    pub async fn save_word_forms_catalog(
        &self,
        args: Parameters<SetWordFormsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        self.set_word_forms(args).await
    }

    #[tool(
        name = "query_word_marks",
        description = "Return whole-book word-mark rules and occurrence exceptions for one book.",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = false
        )
    )]
    pub async fn query_word_marks_catalog(
        &self,
        args: Parameters<GetWordMarksArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        self.get_word_marks(args).await
    }

    #[tool(
        description = "Create or update whole-book rules, occurrence exceptions, or lookup-created occurrence marks.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = false
        )
    )]
    pub async fn update_word_marks(
        &self,
        Parameters(UpdateWordMarksArgs { action }): Parameters<UpdateWordMarksArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        match action {
            UpdateWordMarksAction::Rule {
                book_id,
                word,
                enabled,
                color,
            } => {
                self.set_word_mark_rule(Parameters(SetWordMarkRuleArgs {
                    book_id,
                    word,
                    enabled,
                    color,
                }))
                .await
            }
            UpdateWordMarksAction::Exception {
                book_id,
                word,
                location,
                excluded,
            } => {
                self.set_word_mark_exception(Parameters(SetWordMarkExceptionArgs {
                    book_id,
                    word,
                    location,
                    excluded,
                }))
                .await
            }
            UpdateWordMarksAction::Occurrence {
                book_id,
                word,
                location,
                enabled,
            } => {
                self.set_lookup_occurrence_mark(Parameters(SetLookupOccurrenceMarkArgs {
                    book_id,
                    word,
                    location,
                    enabled,
                }))
                .await
            }
        }
    }
}

//! MCP server handler + stdio entry point.
//!
//! This file owns:
//!   - `LanternMcpHandler` — the per-process MCP service. Carries
//!     `McpState` so tool methods (defined across `mcp/tools/*.rs` via
//!     `#[tool_router]` impl blocks) can read the DB.
//!   - `tool_router()` — aggregator merging every per-file router.
//!   - `ServerHandler` impl: `call_tool` applies the high-risk approval
//!     gate before routing, while `#[tool_handler]` generates the catalog
//!     methods against the merged router.
//!   - `serve_stdio()` — drives the handler over `(stdin, stdout)` for
//!     the `lantern mcp` subcommand. The Tauri app does NOT run an MCP
//!     server in-process; AI clients (Claude Code, Codex) launch this
//!     subprocess themselves.

use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::tool::ToolCallContext;
use rmcp::handler::server::ServerHandler;
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, ElicitRequest,
    ElicitRequestParams, ElicitResult, ElicitationAction, ElicitationSchema, Implementation,
    InputRequest, InputRequests, InputRequiredResult, JsonObject, ProtocolVersion,
    ServerCapabilities, ServerInfo,
};
use rmcp::service::RequestContext;
use rmcp::transport::io::stdio;
use rmcp::{tool_handler, ErrorData, RoleServer, ServiceExt};
use serde_json::{json, Value};

use super::approval::{
    ApprovalConfirmation, ApprovalGateOutcome, ApprovalRequest, ApprovalRequestInput,
};
use super::state::McpState;

/// MRTR is the multi-round tool response added in MCP 2026-07-28: the server
/// answers a `tools/call` with `input_required` instead of a result, the client
/// renders the form, and the client calls the tool again carrying the answer.
/// Lantern uses it to ask for deletion confirmation inside the AI client. A
/// client that does not support it falls back to a dialog in the Lantern window.
const MRTR_APPROVAL_INPUT_ID: &str = "lantern_high_risk_confirmation";

#[derive(Clone)]
pub(crate) struct LanternMcpHandler {
    pub(crate) state: McpState,
}

impl LanternMcpHandler {
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
        r.merge(Self::annotations_write_router());
        r.merge(Self::vocab_write_router());
        r.merge(Self::chats_write_router());
        for name in [
            "get_collections",
            "create_collection",
            "rename_collection",
            "delete_collection",
            "reorder_collections",
            "get_collection_books",
            "update_collection_membership",
            "get_bookmarks",
            "get_highlights",
            "get_notes",
            "create_bookmark",
            "create_highlight",
            "update_highlight",
            "save_note",
            "delete_bookmarks",
            "delete_highlights",
            "delete_notes",
            "get_chat_history",
            "create_chat",
            "rename_chat",
            "save_chat_message",
            "replace_chat_message",
            "list_books",
            "get_book",
            "update_book",
            "set_reading_state",
            "list_book_sections",
            "get_book_content",
            "search_book_content",
            "get_vocab_words",
            "get_vocab_stats",
            "create_vocab_word",
            "record_vocab_review",
            "set_vocab_mastery",
            "delete_vocab_words",
            "get_lookup_history",
            "save_lookup_record",
            "delete_lookup_records",
            "clear_lookup_history",
            "set_word_forms",
            "get_word_marks",
            "set_word_mark_rule",
            "set_word_mark_exception",
            "set_lookup_occurrence_mark",
            "request_book_index",
            "preview_vocabulary_import",
            "delete_lookup_history",
        ] {
            r.remove_route(name);
        }
        r.merge(Self::collections_catalog_router());
        r.merge(Self::annotations_catalog_router());
        r.merge(Self::chats_catalog_router());
        r.merge(Self::local_catalog_router());
        r.merge(Self::open_reader_router());
        r
    }

    async fn dispatch_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let tcc = ToolCallContext::new(self, request, context);
        Self::tool_router().call(tcc).await
    }
}

fn approval_input_for_tool(
    name: &str,
    arguments: &JsonObject,
) -> Result<Option<ApprovalRequestInput>, ErrorData> {
    let confirmation = match name {
        "delete_books" => {
            let book_ids = required_string_array(arguments, "book_ids")?;
            if book_ids.is_empty() {
                return Err(ErrorData::invalid_params(
                    "`book_ids` must contain at least one item",
                    None,
                ));
            }
            ApprovalConfirmation::IrreversibleData {
                effect:
                    "Permanently delete the selected book files and their associated reading data."
                        .to_string(),
                scope: format!("{} book(s): {}.", book_ids.len(), book_ids.join(", ")),
            }
        }
        "delete_collections" => {
            let collection_ids = required_non_empty_string_array(arguments, "ids")?;
            ApprovalConfirmation::IrreversibleData {
                effect: "Permanently delete the collection and its saved membership grouping. Books are not deleted."
                    .to_string(),
                scope: format!(
                    "{} collection(s): {}.",
                    collection_ids.len(),
                    collection_ids.join(", ")
                ),
            }
        }
        "delete_annotations" => {
            let (effect, label) = match arguments.get("kind").and_then(Value::as_str) {
                Some("bookmark") => ("Permanently delete the selected bookmarks.", "bookmark"),
                Some("highlight") => (
                    "Permanently delete the selected highlights and their attached legacy note text.",
                    "highlight",
                ),
                Some("note") => ("Permanently delete the selected first-class notes.", "note"),
                _ => {
                    return Err(ErrorData::invalid_params(
                        "`kind` must be bookmark, highlight, or note",
                        None,
                    ));
                }
            };
            irreversible_ids_confirmation(arguments, effect, label)?
        }
        "delete_chats" => irreversible_ids_confirmation(
            arguments,
            "Permanently delete the selected chats and all messages they contain.",
            "chat",
        )?,
        "delete_vocabulary" => irreversible_ids_confirmation(
            arguments,
            "Permanently delete the selected vocabulary entries and their review state.",
            "vocabulary entry",
        )?,
        "delete_word_forms" => {
            let words = required_non_empty_string_array(arguments, "words")?;
            ApprovalConfirmation::IrreversibleData {
                effect: "Permanently delete the saved word-form sets for the selected words."
                    .to_string(),
                scope: format!("{} word(s): {}.", words.len(), words.join(", ")),
            }
        }
        "clear_word_marks" => {
            let book_id = required_string(arguments, "book_id")?;
            ApprovalConfirmation::IrreversibleData {
                effect: "Permanently clear all whole-book word marks, occurrence marks, and exclusions for the book."
                    .to_string(),
                scope: format!("Book {book_id}."),
            }
        }
        "import_vocabulary"
            if arguments.get("mode").and_then(Value::as_str) != Some("preview")
                && arguments.get("conflict_policy").and_then(Value::as_str)
                    == Some("overwrite") =>
        {
            let data_size = required_string(arguments, "data")?.len();
            let format = required_string(arguments, "format")?;
            ApprovalConfirmation::IrreversibleData {
                effect:
                    "Import vocabulary data and permanently replace conflicting existing entries."
                        .to_string(),
                scope: format!("One {format} import containing {data_size} bytes."),
            }
        }
        _ => return Ok(None),
    };
    Ok(Some(ApprovalRequestInput {
        action: name.to_string(),
        confirmation,
        arguments: Value::Object(arguments.clone()),
    }))
}

fn required_string<'a>(arguments: &'a JsonObject, name: &str) -> Result<&'a str, ErrorData> {
    arguments
        .get(name)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            ErrorData::invalid_params(format!("`{name}` must be a non-empty string"), None)
        })
}

fn required_string_array(arguments: &JsonObject, name: &str) -> Result<Vec<String>, ErrorData> {
    let values = arguments
        .get(name)
        .and_then(Value::as_array)
        .ok_or_else(|| ErrorData::invalid_params(format!("`{name}` must be an array"), None))?;
    values
        .iter()
        .map(|value| {
            value
                .as_str()
                .filter(|value| !value.trim().is_empty())
                .map(str::to_string)
                .ok_or_else(|| {
                    ErrorData::invalid_params(
                        format!("`{name}` must contain only non-empty strings"),
                        None,
                    )
                })
        })
        .collect()
}

fn required_non_empty_string_array(
    arguments: &JsonObject,
    name: &str,
) -> Result<Vec<String>, ErrorData> {
    let values = required_string_array(arguments, name)?;
    if values.is_empty() {
        return Err(ErrorData::invalid_params(
            format!("`{name}` must contain at least one item"),
            None,
        ));
    }
    Ok(values)
}

fn irreversible_ids_confirmation(
    arguments: &JsonObject,
    effect: &str,
    item_name: &str,
) -> Result<ApprovalConfirmation, ErrorData> {
    let ids = required_non_empty_string_array(arguments, "ids")?;
    Ok(ApprovalConfirmation::IrreversibleData {
        effect: effect.to_string(),
        scope: format!("{} {item_name}(s): {}.", ids.len(), ids.join(", ")),
    })
}

fn supports_mrtr_confirmation(context: &RequestContext<RoleServer>) -> bool {
    let supports_protocol = context
        .protocol_version()
        .is_some_and(|version| version.as_str() >= ProtocolVersion::V_2026_07_28.as_str());
    let supports_form = context.client_capabilities().is_some_and(|capabilities| {
        capabilities
            .elicitation
            .is_some_and(|elicitation| elicitation.form.is_some())
    });
    supports_protocol && supports_form
}

fn confirmation_message(confirmation: &ApprovalConfirmation) -> String {
    match confirmation {
        ApprovalConfirmation::IrreversibleData { effect, scope } => {
            format!("{effect} Scope: {scope} This action cannot be undone.")
        }
    }
}

fn mrtr_confirmation(request: &ApprovalRequest) -> Result<CallToolResponse, ErrorData> {
    let requested_schema = ElicitationSchema::builder()
        .title("Confirm high-risk operation")
        .description(confirmation_message(&request.confirmation))
        .required_bool_property("confirmed", |schema| {
            schema
                .title("Confirm")
                .description("Approve this exact operation.")
                .with_default(false)
        })
        .build()
        .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
    let elicitation = InputRequest::Elicitation(ElicitRequest::new(
        ElicitRequestParams::FormElicitationParams {
            meta: None,
            message: confirmation_message(&request.confirmation),
            requested_schema,
        },
    ));
    let mut inputs = InputRequests::new();
    inputs.insert(MRTR_APPROVAL_INPUT_ID.to_string(), elicitation);
    Ok(InputRequiredResult::new(Some(inputs), Some(request.id.clone())).into())
}

fn parse_mrtr_acceptance(request: &CallToolRequestParams) -> Result<bool, ErrorData> {
    let responses = request
        .input_responses
        .as_ref()
        .ok_or_else(|| ErrorData::invalid_params("confirmation response is missing", None))?;
    if responses.len() != 1 {
        return Err(ErrorData::invalid_params(
            "confirmation response does not match the request",
            None,
        ));
    }
    let response: ElicitResult =
        serde_json::from_value(responses.get(MRTR_APPROVAL_INPUT_ID).cloned().ok_or_else(
            || ErrorData::invalid_params("confirmation response does not match the request", None),
        )?)
        .map_err(|error| ErrorData::invalid_params(error.to_string(), None))?;
    match response.action {
        ElicitationAction::Accept => Ok(response
            .content
            .as_ref()
            .and_then(|content| content.get("confirmed"))
            .and_then(Value::as_bool)
            == Some(true)),
        ElicitationAction::Decline | ElicitationAction::Cancel => Ok(false),
        _ => Ok(false),
    }
}

fn approval_status_result(status: &str, request: &ApprovalRequest) -> CallToolResponse {
    CallToolResult::success(vec![ContentBlock::json(json!({
        "status": status,
        "approval_id": request.id,
        "confirmation": request.confirmation,
    }))
    .expect("approval status JSON must serialize")])
    .into()
}

fn approval_error(error: crate::error::AppError) -> ErrorData {
    let message = error.to_string();
    if message.contains("MCP_APPROVAL_INVALID_")
        || message.contains("MCP_APPROVAL_NOT_FOUND")
        || message.contains("MCP_APPROVAL_BINDING_MISMATCH")
        || message.contains("MCP_APPROVAL_ALREADY_CONSUMED")
    {
        ErrorData::invalid_params(message, None)
    } else {
        ErrorData::internal_error(message, None)
    }
}

#[tool_handler]
impl ServerHandler for LanternMcpHandler {
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let arguments = request.arguments.clone().unwrap_or_default();
        let Some(approval_input) = approval_input_for_tool(request.name.as_ref(), &arguments)?
        else {
            return self.dispatch_tool(request, context).await;
        };
        if matches!(
            &approval_input.confirmation,
            ApprovalConfirmation::IrreversibleData { .. }
        ) {
            crate::mcp::tools::library::require_sync(self)?;
        }
        let approvals = self.state.approvals.as_ref().ok_or_else(|| {
            ErrorData::internal_error("MCP approval storage is unavailable", None)
        })?;
        let uses_mrtr = supports_mrtr_confirmation(&context);

        if request.request_state.is_some() || request.input_responses.is_some() {
            if !uses_mrtr {
                return Err(ErrorData::invalid_params(
                    "interactive confirmation requires MCP 2026-07-28 and form elicitation",
                    None,
                ));
            }
            let approval_id = request.request_state.as_deref().ok_or_else(|| {
                ErrorData::invalid_params("confirmation request state is missing", None)
            })?;
            let accepted = parse_mrtr_acceptance(&request)?;
            return match approvals
                .complete_interactive(
                    approval_id,
                    request.name.as_ref(),
                    &approval_input.arguments,
                    accepted,
                )
                .map_err(approval_error)?
            {
                ApprovalGateOutcome::Execute(_) => self.dispatch_tool(request, context).await,
                ApprovalGateOutcome::Rejected(request) => {
                    Ok(approval_status_result("rejected", &request))
                }
                ApprovalGateOutcome::Pending(_) => unreachable!("MRTR resolution is final"),
            };
        }

        let outcome = if uses_mrtr {
            approvals.claim_mrtr(approval_input)
        } else {
            approvals.claim_application(approval_input)
        }
        .map_err(approval_error)?;
        match outcome {
            ApprovalGateOutcome::Execute(_) => self.dispatch_tool(request, context).await,
            ApprovalGateOutcome::Rejected(request) => {
                Ok(approval_status_result("rejected", &request))
            }
            ApprovalGateOutcome::Pending(request) if uses_mrtr => mrtr_confirmation(&request),
            ApprovalGateOutcome::Pending(request) => {
                Ok(approval_status_result("approval_required", &request))
            }
        }
    }

    fn get_info(&self) -> ServerInfo {
        // `ServerInfo` and `Implementation` are both `#[non_exhaustive]`.
        // Use the public constructors / builder methods rather than
        // struct literals.
        let implementation = Implementation::new("lantern", env!("CARGO_PKG_VERSION"));
        let capabilities = ServerCapabilities::builder().enable_tools().build();
        ServerInfo::new(capabilities)
            .with_protocol_version(ProtocolVersion::V_2026_07_28)
            .with_server_info(implementation)
            .with_instructions(
                "Lantern MCP server. Inspect and control Lantern through the tools exposed \
                 by this server. Tool descriptions state their effects and whether they use \
                 local reading data. Permanent deletion and destructive overwrites require \
                 approval before execution. Other writes require MCP write access.",
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
    let handler = LanternMcpHandler::new(state);
    let server = handler.serve(stdio()).await?;
    // `waiting` resolves when the peer disconnects or sends shutdown.
    let _quit_reason = server.waiting().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    //! Unit tests for the `LanternMcpHandler` surface. We exercise tool
    //! methods directly against a seeded in-memory-on-disk SQLite via
    //! `Db::init` on a `TempDir`, asserting on the JSON payload each
    //! tool returns. The transport itself (stdin/stdout, rmcp's
    //! framing) is verified separately by the binary integration test
    //! in `tests/mcp_binary.rs`.
    use super::*;
    use crate::db::Db;
    use crate::sync::writer::SyncWriter;
    use rmcp::handler::server::wrapper::Parameters;
    use rmcp::model::{
        ClientCapabilities, ClientInfo, ElicitationCapability, FormElicitationCapability,
        InputResponses, RequestId,
    };
    use rusqlite::params;
    use tempfile::TempDir;

    #[derive(Clone, Default)]
    struct ContextPeer;

    impl ServerHandler for ContextPeer {}

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
            Some(dir.path()),
        );
        (dir, writable)
    }

    fn request_context(
        protocol: ProtocolVersion,
        form_elicitation: bool,
    ) -> RequestContext<RoleServer> {
        let mut capabilities = ClientCapabilities::default();
        if form_elicitation {
            capabilities.elicitation =
                Some(ElicitationCapability::new().with_form(FormElicitationCapability::new()));
        }
        let client_info = ClientInfo::new(
            capabilities.clone(),
            Implementation::new("lantern-test-client", "0.0.0"),
        )
        .with_protocol_version(protocol.clone());
        let (server_transport, _client_transport) = tokio::io::duplex(64);
        let running = rmcp::service::serve_directly::<RoleServer, _, _, _, _>(
            ContextPeer,
            server_transport,
            Some(client_info),
        );
        let mut context = RequestContext::new(RequestId::Number(1), running.peer().clone());
        context.meta.set_protocol_version(protocol);
        context.meta.set_client_capabilities(capabilities);
        context
    }

    fn call(name: &'static str, arguments: Value) -> CallToolRequestParams {
        CallToolRequestParams::new(name).with_arguments(arguments.as_object().unwrap().clone())
    }

    fn book_exists(state: &McpState, id: &str) -> bool {
        state
            .db
            .reader()
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM books WHERE id = ?1)",
                params![id],
                |row| row.get(0),
            )
            .unwrap()
    }

    fn text_of(result: rmcp::model::CallToolResult) -> String {
        assert_eq!(result.is_error, Some(false), "tool returned is_error=true");
        let first = result
            .content
            .into_iter()
            .next()
            .expect("tool returned no content");
        match first {
            ContentBlock::Text(t) => t.text,
            other => panic!("expected text content, got {other:?}"),
        }
    }

    #[test]
    fn tool_router_registers_all_tools() {
        let router = LanternMcpHandler::tool_router();
        let names: std::collections::BTreeSet<_> = router
            .list_all()
            .into_iter()
            .map(|t| t.name.to_string())
            .collect();
        let expected: std::collections::BTreeSet<_> = [
            "query_books",
            "query_collections",
            "update_collections",
            "delete_collections",
            "query_annotations",
            "query_vocabulary",
            "query_chats",
            "update_books",
            "import_books",
            "delete_books",
            "query_book_content",
            "get_book_intelligence",
            "query_lookup_history",
            "query_word_forms",
            "query_word_marks",
            "get_language_profile",
            "save_annotations",
            "delete_annotations",
            "save_vocabulary",
            "delete_vocabulary",
            "save_word_forms",
            "update_word_marks",
            "export_vocabulary",
            "import_vocabulary",
            "delete_word_forms",
            "clear_word_marks",
            "save_chats",
            "delete_chats",
            "open_in_reader",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(expected.len(), 29, "the frozen MCP catalog has 29 tools");
        assert_eq!(names, expected, "tool registry diverged from spec");
    }

    #[test]
    fn every_catalog_tool_has_an_object_schema_and_fact_description() {
        for tool in LanternMcpHandler::tool_router().list_all() {
            assert!(
                tool.description
                    .as_deref()
                    .is_some_and(|description| !description.is_empty()),
                "{} has no description",
                tool.name
            );
            assert_eq!(
                tool.input_schema.get("type").and_then(Value::as_str),
                Some("object"),
                "{} has no object input schema",
                tool.name
            );
        }
    }

    #[test]
    fn irreversible_catalog_covers_every_current_permanent_data_operation() {
        for (name, arguments) in [
            ("delete_books", json!({ "book_ids": ["b1"] })),
            ("delete_collections", json!({ "ids": ["c1"] })),
            (
                "delete_annotations",
                json!({ "kind": "bookmark", "ids": ["bm1"] }),
            ),
            (
                "delete_annotations",
                json!({ "kind": "highlight", "ids": ["h1"] }),
            ),
            (
                "delete_annotations",
                json!({ "kind": "note", "ids": ["n1"] }),
            ),
            ("delete_chats", json!({ "ids": ["ch1"] })),
            ("delete_vocabulary", json!({ "ids": ["v1"] })),
            ("delete_word_forms", json!({ "words": ["word"] })),
            ("clear_word_marks", json!({ "book_id": "b1" })),
            (
                "import_vocabulary",
                json!({
                    "data": "{}",
                    "format": "json",
                    "conflict_policy": "overwrite"
                }),
            ),
        ] {
            let input = approval_input_for_tool(name, arguments.as_object().unwrap())
                .unwrap()
                .unwrap_or_else(|| panic!("{name} must require confirmation"));
            assert!(matches!(
                input.confirmation,
                ApprovalConfirmation::IrreversibleData { .. }
            ));
        }
    }

    #[test]
    fn ordinary_operations_and_non_overwriting_import_do_not_require_confirmation() {
        for (name, arguments) in [
            (
                "update_collections",
                json!({ "action": "create", "name": "Direct" }),
            ),
            (
                "save_annotations",
                json!({
                    "action": "save_note",
                    "anchor_kind": "selection",
                    "scope": "book",
                    "content": "ordinary edit"
                }),
            ),
            (
                "update_collections",
                json!({
                    "action": "update_membership",
                    "collection_id": "c1",
                    "book_ids": ["b1"],
                    "operation": "remove"
                }),
            ),
            (
                "import_vocabulary",
                json!({
                    "data": "{}",
                    "format": "json",
                    "conflict_policy": "skip"
                }),
            ),
        ] {
            assert!(
                approval_input_for_tool(name, arguments.as_object().unwrap())
                    .unwrap()
                    .is_none(),
                "{name} must execute without high-risk confirmation"
            );
        }
    }

    #[tokio::test]
    async fn get_info_advertises_tools_capability() {
        let (_dir, state) = seeded();
        let handler = LanternMcpHandler::new(state);
        let info = handler.get_info();
        assert!(
            info.capabilities.tools.is_some(),
            "tools capability missing"
        );
        assert_eq!(info.server_info.name, "lantern");
        assert_eq!(info.protocol_version, ProtocolVersion::V_2026_07_28);
    }

    #[tokio::test]
    async fn legacy_client_approval_executes_once_and_cannot_be_replayed() {
        let (_dir, state) = seeded_writable();
        let handler = LanternMcpHandler::new(state.clone());
        let arguments = json!({ "book_ids": ["b2"] });

        let first = ServerHandler::call_tool(
            &handler,
            call("delete_books", arguments.clone()),
            request_context(ProtocolVersion::V_2025_11_25, false),
        )
        .await
        .unwrap();
        let CallToolResponse::Complete(first) = first else {
            panic!("legacy client must receive a complete fallback result");
        };
        let first: Value = serde_json::from_str(&text_of(first)).unwrap();
        assert_eq!(first["status"], "approval_required");
        assert!(book_exists(&state, "b2"));

        let approval_id = first["approval_id"].as_str().unwrap();
        state
            .approvals
            .as_ref()
            .unwrap()
            .approve(approval_id)
            .unwrap();
        let second = ServerHandler::call_tool(
            &handler,
            call("delete_books", arguments.clone()),
            request_context(ProtocolVersion::V_2025_11_25, false),
        )
        .await
        .unwrap();
        assert!(matches!(second, CallToolResponse::Complete(_)));
        assert!(!book_exists(&state, "b2"));

        let third = ServerHandler::call_tool(
            &handler,
            call("delete_books", arguments),
            request_context(ProtocolVersion::V_2025_11_25, false),
        )
        .await
        .unwrap();
        let CallToolResponse::Complete(third) = third else {
            panic!("legacy replay must return a new fallback request");
        };
        let third: Value = serde_json::from_str(&text_of(third)).unwrap();
        assert_eq!(third["status"], "approval_required");
        assert_ne!(third["approval_id"], first["approval_id"]);
    }

    #[tokio::test]
    async fn mrtr_confirmation_binds_arguments_and_rejects_replay() {
        let (_dir, state) = seeded_writable();
        let handler = LanternMcpHandler::new(state.clone());
        let arguments = json!({ "book_ids": ["b2"] });

        let first = ServerHandler::call_tool(
            &handler,
            call("delete_books", arguments.clone()),
            request_context(ProtocolVersion::V_2026_07_28, true),
        )
        .await
        .unwrap();
        let CallToolResponse::InputRequired(first) = first else {
            panic!("2026 client must receive MRTR input_required");
        };
        assert!(first
            .input_requests
            .as_ref()
            .unwrap()
            .contains_key(MRTR_APPROVAL_INPUT_ID));
        let approval_id = first.request_state.unwrap();
        assert!(book_exists(&state, "b2"));
        assert!(
            state
                .approvals
                .as_ref()
                .unwrap()
                .list_pending()
                .unwrap()
                .is_empty(),
            "native MCP confirmation must not also appear in the Lantern approval queue"
        );

        let mut responses = InputResponses::new();
        responses.insert(
            MRTR_APPROVAL_INPUT_ID.to_string(),
            json!({ "action": "accept", "content": { "confirmed": true } }),
        );
        let tampered = call("delete_books", json!({ "book_ids": ["b1"] }))
            .with_request_state(approval_id.clone())
            .with_input_responses(responses.clone());
        let error = ServerHandler::call_tool(
            &handler,
            tampered,
            request_context(ProtocolVersion::V_2026_07_28, true),
        )
        .await
        .unwrap_err();
        assert!(error.message.contains("MCP_APPROVAL_BINDING_MISMATCH"));
        assert!(book_exists(&state, "b1"));
        assert!(book_exists(&state, "b2"));

        let approved = call("delete_books", arguments.clone())
            .with_request_state(approval_id.clone())
            .with_input_responses(responses.clone());
        let result = ServerHandler::call_tool(
            &handler,
            approved,
            request_context(ProtocolVersion::V_2026_07_28, true),
        )
        .await
        .unwrap();
        assert!(matches!(result, CallToolResponse::Complete(_)));
        assert!(!book_exists(&state, "b2"));

        let replay = call("delete_books", arguments)
            .with_request_state(approval_id)
            .with_input_responses(responses);
        let error = ServerHandler::call_tool(
            &handler,
            replay,
            request_context(ProtocolVersion::V_2026_07_28, true),
        )
        .await
        .unwrap_err();
        assert!(error.message.contains("MCP_APPROVAL_ALREADY_CONSUMED"));
    }

    #[tokio::test]
    async fn ordinary_write_executes_without_confirmation_for_2026_client() {
        let (_dir, state) = seeded_writable();
        let handler = LanternMcpHandler::new(state.clone());
        let result = ServerHandler::call_tool(
            &handler,
            call(
                "update_collections",
                json!({ "action": "create", "name": "Direct" }),
            ),
            request_context(ProtocolVersion::V_2026_07_28, true),
        )
        .await
        .unwrap();
        assert!(matches!(result, CallToolResponse::Complete(_)));
        assert!(state
            .approvals
            .as_ref()
            .unwrap()
            .list_pending()
            .unwrap()
            .is_empty());
        let count: i64 = state
            .db
            .reader()
            .query_row(
                "SELECT COUNT(*) FROM collections WHERE name = 'Direct'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn list_books_returns_seeded_book_without_available_field() {
        let (_dir, state) = seeded();
        let handler = LanternMcpHandler::new(state);
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
        let handler = LanternMcpHandler::new(state);
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
        let handler = LanternMcpHandler::new(state);
        let body = text_of(handler.get_collections().await.unwrap());
        let arr: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(arr[0]["name"], serde_json::json!("Favorites"));
        assert_eq!(arr[0]["book_count"], serde_json::json!(1));
    }

    #[tokio::test]
    async fn get_highlights_includes_text_content() {
        let (_dir, state) = seeded();
        let handler = LanternMcpHandler::new(state);
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
        let handler = LanternMcpHandler::new(state);
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
        let handler = LanternMcpHandler::new(state);
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
        let handler = LanternMcpHandler::new(state);
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
        let handler = LanternMcpHandler::new(state);
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
        let handler = LanternMcpHandler::new(state);

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
                .get_book_intelligence(Parameters(
                    crate::mcp::tools::content::GetBookIntelligenceArgs {
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
        assert_eq!(summaries["embeddings"]["indexed_chunks"], 3);
        assert_eq!(summaries["embeddings"]["embedded_chunks"], 0);

        let status_body = text_of(
            handler
                .get_book(Parameters(crate::mcp::tools::library::GetBookArgs {
                    book_id: "b1".to_string(),
                }))
                .await
                .unwrap(),
        );
        let status: serde_json::Value = serde_json::from_str(&status_body).unwrap();
        assert_eq!(status["index"]["chunk_count"], 3);
        assert_eq!(status["index"]["index_version"], 1);

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
        let handler = LanternMcpHandler::new(state);

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
        let handler = LanternMcpHandler::new(state);
        let body = text_of(
            handler
                .update_collection_membership(Parameters(
                    crate::mcp::tools::library_batch::CollectionBooksArgs {
                        collection_id: "c1".to_string(),
                        book_ids: vec!["b1".to_string(), "b2".to_string(), "missing".to_string()],
                        operation:
                            crate::mcp::tools::library_batch::CollectionMembershipOperation::Add,
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
        let handler = LanternMcpHandler::new(state);
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
    async fn every_write_tool_checks_the_write_switch() {
        let (_dir, state) = seeded();
        let handler = LanternMcpHandler::new(state);
        // Every write tool, driven the way a client drives it: by name and raw
        // arguments, through the same entry point that runs the approval gate.
        // The arguments below are well-formed on purpose — a schema rejection
        // would pass this test without ever reaching the switch.
        let writes = [
            ("import_books", json!({ "file_paths": ["/tmp/x.epub"] })),
            (
                "update_books",
                json!({ "action": "metadata", "book_id": "b1", "title": "Renamed" }),
            ),
            ("delete_books", json!({ "book_ids": ["b1"] })),
            (
                "update_collections",
                json!({ "action": "create", "name": "New collection" }),
            ),
            ("delete_collections", json!({ "ids": ["c1"] })),
            (
                "save_annotations",
                json!({ "action": "create_bookmark", "book_id": "b1", "cfi": "epubcfi(/6/2)" }),
            ),
            (
                "delete_annotations",
                json!({ "kind": "bookmark", "ids": ["bm1"] }),
            ),
            (
                "save_vocabulary",
                json!({ "action": "create", "book_id": "b1", "word": "w", "definition": "d" }),
            ),
            ("delete_vocabulary", json!({ "ids": ["v1"] })),
            (
                "import_vocabulary",
                json!({ "data": "[]", "format": "json", "mode": "preview" }),
            ),
            (
                "save_word_forms",
                json!({ "word": "run", "forms": ["ran", "running"] }),
            ),
            ("delete_word_forms", json!({ "words": ["run"] })),
            (
                "update_word_marks",
                json!({ "action": "rule", "book_id": "b1", "word": "w", "enabled": true }),
            ),
            ("clear_word_marks", json!({ "book_id": "b1" })),
            ("save_chats", json!({ "action": "create", "book_id": "b1" })),
            ("delete_chats", json!({ "ids": ["ch1"] })),
        ];
        assert_eq!(writes.len(), 16, "every write tool must be covered here");

        for (name, arguments) in writes {
            let error = ServerHandler::call_tool(
                &handler,
                call(name, arguments),
                request_context(ProtocolVersion::V_2026_07_28, false),
            )
            .await
            .unwrap_err();
            assert!(
                error.message.contains("Write access"),
                "{name} did not check the write switch: {}",
                error.message
            );
        }

        // Exporting vocabulary only reads rows back out, so the switch must not
        // stand in its way.
        handler.export_vocabulary().await.unwrap();
    }

    #[tokio::test]
    async fn open_in_reader_reports_an_unconfirmed_request_without_an_app_watcher() {
        let (_dir, state) = seeded();
        let handler = LanternMcpHandler::new(state);
        let body = text_of(
            handler
                .open_in_reader(Parameters(
                    crate::mcp::tools::open_reader::OpenInReaderArgs {
                        book_id: "b1".to_string(),
                        cfi: Some("epubcfi(/6/2)".to_string()),
                    },
                ))
                .await
                .unwrap(),
        );
        let result: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(result["status"], "unavailable");
        assert_eq!(result["delivery_confirmed"], false);
    }
}

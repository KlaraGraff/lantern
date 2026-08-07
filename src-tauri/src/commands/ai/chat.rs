//! `ai_chat` — the conversational route. Owns the history and source budgets,
//! the system content assembled per route, and the metadata the reader is shown
//! about what the answer was allowed to see.

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use super::intent;
use super::prompt::{book_reference_block, truncate_utf8, MARKUP_GUIDE};
use super::routing::*;
use super::stream::{ensure_stream_credentials_ready, spawn_routed_stream};
use super::vocabulary::{
    spawn_vocabulary_scan_stream, vocabulary_context_metadata, VocabularyScanPlan,
};
use super::ChatMessage;
use crate::ai::grounding::{
    self, CitedSource, IndexStatus, RetrievedChunk, OVERVIEW_BUDGET_TOKENS, RETRIEVAL_BUDGET_TOKENS,
};
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::secrets::Secrets;

const CHAT_MAX_MESSAGES: usize = 64;
const CHAT_MAX_MESSAGE_BYTES: usize = 16_000;
/// One history budget for every route. Scoped routes used to get a quarter of
/// this so section excerpts would always fit, which meant the conversation was
/// the first thing sacrificed — the opposite of the right order. Losing a turn
/// is immediately visible to the reader ("it forgot what I asked"); losing a
/// trailing excerpt only makes an answer less detailed and can be re-retrieved
/// by asking again. So source text yields to history now, not the reverse.
pub(super) const CHAT_MAX_TOTAL_BYTES: usize = 512_000;
/// Floor under the injected-source budget, so a reader who sets the full-text
/// threshold very low still gets the excerpts the retrieval routes assume.
const CHAT_SOURCE_FLOOR_BYTES: usize = 64_000;
/// Rough upper bound on bytes per token, used only to convert a token-denominated
/// setting into the byte-denominated budget. Erring high is the safe direction:
/// it makes the budget looser, and the budget is a backstop, not a target.
const CHAT_BYTES_PER_TOKEN: usize = 4;
const VIEWPORT_MAX_BYTES: usize = 8_192;
const SECTION_CONTEXT_BUDGET_TOKENS: usize = 12_000;

/// Returns the newest window that fits, plus how many older messages it left
/// behind. The count is surfaced to the reader: a conversation quietly losing
/// its beginning looks like the assistant going senile, so when it happens the
/// UI has to be able to say so.
pub(super) fn bounded_chat_history_with_limit(
    messages: Vec<ChatMessage>,
    max_total_bytes: usize,
) -> (Vec<ChatMessage>, usize) {
    let total_messages = messages.len();
    let mut total_bytes = 0;
    let mut bounded = Vec::new();
    for mut message in messages.into_iter().rev() {
        if !matches!(message.role.as_str(), "user" | "assistant") {
            continue;
        }
        let content = truncate_utf8(&message.content, CHAT_MAX_MESSAGE_BYTES);
        if content.is_empty() {
            continue;
        }
        // Stop once a message would exceed the budget rather than skipping it
        // and keeping older, smaller ones — that would punch a hole in the
        // user/assistant alternation and some strict endpoints 4xx on it. We
        // want the most recent *contiguous* window that fits.
        if total_bytes + content.len() > max_total_bytes {
            break;
        }
        message.content = content.to_string();
        total_bytes += message.content.len();
        bounded.push(message);
        if bounded.len() == CHAT_MAX_MESSAGES {
            break;
        }
    }
    bounded.reverse();
    let omitted = total_messages.saturating_sub(bounded.len());
    (bounded, omitted)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SystemContent {
    stable: String,
    variable: String,
}

impl SystemContent {
    #[cfg(test)]
    fn combined(&self) -> String {
        format!("{}{}", self.stable, self.variable)
    }
}

/// How a chat answer is delivered, how a challenge to it is handled, and when
/// it is conceded. The grounding and scope instructions elsewhere decide where
/// an answer's facts may come from; without these rules the model falls back to
/// restating a rejected answer in new wording, inventing a rule to defend it,
/// and then conceding wholesale once the user insists.
///
/// The verdict rule leads because paragraph order turned out to matter more
/// than wording. Measured over 16 samples per cell on five models, moving it
/// here took deepseek-v4-pro from 7/16 to 14/16 on conceding a parse that was
/// genuinely available, and its use of "it's a fixed expression" as proof
/// against the user from 5/16 to 0/16. Shortening the block instead of
/// reordering it was tried and was worse almost everywhere. The closing
/// sentence of that paragraph is load-bearing in the other direction: without
/// it the rule invites agreement with readings that do not parse at all.
const ANSWER_DISCIPLINE: &str = "\n\nWhen the user proposes a reading of their own, including a translation they call odd, do not treat it as a mistake to correct until you have tested it. Say in your first sentence whether their reading is grammatically possible — a different question from whether it is the right one here — and only then give the reading the context supports, with the reason. Never offer a fixed phrase, a collocation, or \"this is a common expression\" as proof that a competing parse is impossible: an idiom tells the user what is usual, not what the grammar permits. Before citing a missing word as proof against their reading, check whether the reading you favor leaves the same word missing. Treat \"I don't understand this sentence\" the same way whenever the sentence admits more than one reading. When their reading genuinely does not work, say so just as plainly: what is required is a verdict, not agreement.\n\nAnswer the specific gap the user names, not the general topic around it.\n\nWhen the user pushes back or asks again, treat your previous answer as having failed. Do not restate it in new wording or with more examples. Name the step they are challenging and address that step in your first sentence. If they ask why it is X and not Y, supply the evidence that rules Y out — citing a fixed phrase or a convention is not evidence.\n\nHold positions on evidence, not on pressure. Never invent a rule to defend an answer. If you cannot rule out the user's reading, say so plainly and separate what is structurally possible from what is the natural reading here and why. If they are right, say which sentence of yours was wrong, once — no repeated apologies, no re-running your whole earlier answer, and never concede merely because they are insistent. If they are wrong, say so directly and show what settles it. An argument that would apply just as well to your own reading is not an argument — drop it instead of hedging it into a tendency.\n\nMatch length to the question. Do not re-translate, re-quote, or re-explain what the user has already shown they understand, do not translate a sentence you already translated earlier in this conversation, and do not add example lists, tables, or alternative phrasings nobody asked for.";

#[allow(clippy::too_many_arguments)]
fn build_chat_system_content(
    book_title: Option<&str>,
    book_author: Option<&str>,
    current_chapter: Option<&str>,
    language: &str,
    overview: Option<&grounding::summarize::BookOverview>,
    excerpts: &[RetrievedChunk],
    excerpts_are_stable: bool,
    spoiler_guard_active: bool,
) -> (SystemContent, Vec<CitedSource>) {
    let mut stable = "You are a helpful reading assistant. Help the user understand and discuss the book they are reading.".to_string();
    if let Some(reference) = book_reference_block(book_title, book_author, current_chapter) {
        stable.push_str("\n\n");
        stable.push_str(&reference);
    }
    if let Some(overview) = overview {
        stable.push_str(&format_book_overview(overview));
    }
    if language == "zh" {
        stable.push_str(" Always respond in Chinese (Simplified).");
    }
    if spoiler_guard_active {
        stable.push_str(
            " Spoiler protection is active. Only discuss events supported by the provided excerpts and read-section summaries. Never reveal, infer, or complete later events from your own knowledge of the book or from the user's request. State that the protected reading range does not contain the answer when necessary.",
        );
    }

    let mut sources = Vec::new();
    let mut excerpts_block = String::new();
    if !excerpts.is_empty() {
        excerpts_block.push_str(
            "\n\nThe following are excerpts from the book, retrieved because they may be relevant to the user's question. Cite an excerpt marker like [S2] immediately after any claim it supports. If the excerpts and overview do not contain the answer, say so rather than inventing details.",
        );
        for (index, excerpt) in excerpts.iter().enumerate() {
            let marker = format!("S{}", index + 1);
            sources.push(excerpt.cited_source(marker.clone()));
            excerpts_block.push_str(&format!(
                "\n\n[{marker}] (section: {})\n{}",
                excerpt.section_title.as_deref().unwrap_or("—"),
                excerpt.text,
            ));
        }
    }
    let content = if excerpts_are_stable {
        stable.push_str(&excerpts_block);
        SystemContent {
            stable,
            variable: String::new(),
        }
    } else {
        SystemContent {
            stable,
            variable: excerpts_block,
        }
    };
    (content, sources)
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SectionContextMetadata {
    pub total_chunks: usize,
    pub total_tokens: usize,
    pub visible_chunks: usize,
    pub visible_tokens: usize,
    pub selected_chunks: usize,
    pub selected_tokens: usize,
    pub truncated: bool,
    pub spoiler_limited: bool,
    /// `complete`, `partial_budget`, `partial_reading_protection`,
    /// `partial_budget_and_reading_protection`, or `unavailable`.
    pub coverage: String,
}

impl SectionContextMetadata {
    fn from_retrieval(value: &grounding::retrieve::SectionRetrieval) -> Self {
        let coverage = if value.total_chunks == 0 || value.visible_chunks == 0 {
            "unavailable"
        } else if value.truncated && value.spoiler_limited {
            "partial_budget_and_reading_protection"
        } else if value.truncated {
            "partial_budget"
        } else if value.spoiler_limited {
            "partial_reading_protection"
        } else {
            "complete"
        };
        Self {
            total_chunks: value.total_chunks,
            total_tokens: value.total_tokens,
            visible_chunks: value.visible_chunks,
            visible_tokens: value.visible_tokens,
            selected_chunks: value.selected_chunks,
            selected_tokens: value.selected_tokens,
            truncated: value.truncated,
            spoiler_limited: value.spoiler_limited,
            coverage: coverage.to_string(),
        }
    }
}

/// Inject the reader's currently visible text as evidence. It changes with
/// every page turn, so it goes into the `variable` half of the system content
/// to keep the `stable` half cacheable.
fn append_viewport_evidence(system_content: &mut SystemContent, viewport_text: &str) {
    system_content.variable.push_str(&format!(
        "\n\nThe following is the text currently visible in the user's reader:\n[Visible reading area]\n{viewport_text}\n[/Visible reading area]",
    ));
}

/// Append the route's scope rules, then the invariant answer rules. The answer
/// rules go last on purpose: with them at the top of the system content, live
/// testing showed the first answer of a conversation ignoring them — asserting
/// one reading of an ambiguous sentence and opening by negating the user's —
/// while later answers in the same conversation obeyed.
/// Where this turn's selected passage comes from, if anywhere.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SelectionState {
    /// Attached to the turn being answered.
    Attached,
    /// Inherited from an earlier turn because this one attached nothing. The
    /// reader asking a follow-up has not stopped talking about the passage.
    Carried,
    /// The route says "selected passage" but no turn ever attached one.
    Missing,
}

/// Full conversation history is sent, so the model has to be told what it is
/// allowed to do with it. This replaces the old approach of deleting earlier
/// turns outright, which bought the same guarantee at the cost of every
/// follow-up question losing its referent.
const HISTORY_IS_NOT_EVIDENCE: &str = "\n\nEarlier turns of this conversation are included in full. They are there so you can resolve what the user is referring to — \"this word\", \"that passage\", \"your second point\" — and they are not source evidence. A passage the reader attached to an earlier turn and has since moved on from appears between [Earlier passage] markers; your own earlier replies are your wording, not the book's. Every claim about what the book says must rest on this turn's supplied source material, never on the conversation. Resolve references from the conversation freely; never present it as source text.";

#[allow(clippy::too_many_arguments)]
fn append_chat_route_instructions(
    system_content: &mut SystemContent,
    route: ChatRoute,
    section_context: Option<&SectionContextMetadata>,
    viewport_text: Option<&str>,
    live_scope_ambiguous: bool,
    quoted_reply: bool,
    selection: SelectionState,
    has_history: bool,
) {
    if has_history {
        system_content.stable.push_str(HISTORY_IS_NOT_EVIDENCE);
    }
    if quoted_reply {
        system_content.stable.push_str(
            "\n\nThe user has quoted something you said earlier. That quote is your own wording, not book text and not evidence: never cite it as a source, and never treat it as a claim you now have to defend. Answer what they are asking about it — and if the quoted wording was wrong or overstated, say so.",
        );
    }
    if matches!(
        route,
        ChatRoute::CurrentSection | ChatRoute::CurrentSectionVocabulary
    ) {
        system_content.stable.push_str(
            "\n\nThe user is asking about the current reading section. The supplied section excerpts are the indexed original book text, not a summary. Use only these excerpts for section-specific claims. Scan the excerpts in reading order before answering. If the excerpts are empty or incomplete because of reading protection or the context budget, say so instead of filling the gaps from memory.",
        );
        if route == ChatRoute::CurrentSectionVocabulary {
            system_content.stable.push_str(
                "\n\nThis is a vocabulary request. Extract vocabulary from the primary language of the supplied original section text unless the user explicitly asks for a different source language. The language used for the user's question or the configured response language does not change which source-language words to extract. List only words or phrases that literally appear in the original section text; do not turn themes, historical concepts, places, or explanations into vocabulary items. For every item give the exact form as it appears, lemma when applicable, part of speech when applicable, pronunciation when applicable, meaning in the configured response language, an exact short source sentence or quote, its meaning in context, and a supporting source marker such as [S2]. Cover the useful difficult words across the whole supplied section, not just the first passage. Never invent a word, sentence, or definition that is unsupported by the supplied text.",
            );
        }
        if let Some(context) = section_context {
            if context.spoiler_limited {
                system_content.stable.push_str(&format!(
                    "\n\nReading protection limits this section: only {} of {} indexed chunks ({} of {} estimated tokens) are visible. Protected unread material was omitted; do not describe this as the complete section.",
                    context.visible_chunks,
                    context.total_chunks,
                    context.visible_tokens,
                    context.total_tokens,
                ));
            }
            if context.truncated {
                system_content.stable.push_str(&format!(
                    "\n\nThe section context budget supplied only {} of {} visible chunks ({} of {} estimated tokens). The returned text is a reading-order prefix; say that the supplied section context is partial rather than claiming complete chapter coverage.",
                    context.selected_chunks,
                    context.visible_chunks,
                    context.selected_tokens,
                    context.visible_tokens,
                ));
            }
            if context.total_chunks == 0 {
                system_content.stable.push_str(
                    "\n\nNo indexed source chunks were available for this section. Do not infer section-specific content from memory or earlier assistant messages.",
                );
            }
        }
    } else if matches!(
        route,
        ChatRoute::SelectedContext | ChatRoute::SelectedContextVocabulary
    ) {
        match selection {
            SelectionState::Attached => system_content.stable.push_str(
                "\n\nThe user's selected passage is the primary source for this request. Do not broaden the answer to unrelated book sections unless the user explicitly asks for that.",
            ),
            // Without this the prompt named a selected passage that no message
            // in the request contained, and the model — correctly — answered
            // that it could not see what the user meant.
            SelectionState::Carried => system_content.stable.push_str(
                "\n\nThe user asked a follow-up without attaching a new selection, so the passage between [Carried passage] markers in the conversation is still the passage under discussion. Treat it as the selected passage for this request, and do not broaden the answer to unrelated book sections unless the user explicitly asks for that.",
            ),
            // Nothing was ever selected. Fall back to what the reader can see
            // rather than insisting on a source that does not exist.
            SelectionState::Missing => {
                system_content.stable.push_str(
                    "\n\nNo passage is attached to this request. Answer from the visible reading area below when it covers the question, and say plainly when it does not — never claim to be reading a selection.",
                );
                if let Some(viewport_text) = viewport_text {
                    append_viewport_evidence(system_content, viewport_text);
                }
            }
        }
        if route == ChatRoute::SelectedContextVocabulary {
            system_content.stable.push_str(
                "\n\nThis is a vocabulary request. List only words or phrases that literally appear in the selected passage, using the passage's primary language unless the user explicitly asks for another source language. Do not turn themes, historical concepts, places, or explanations into vocabulary items. For every item give the exact form, lemma when applicable, part of speech when applicable, pronunciation when applicable, meaning in the configured response language, an exact short quote from the passage, and its meaning in context. Never invent a word, quote, or definition that is unsupported by the selected passage.",
            );
        }
    } else if matches!(route, ChatRoute::WholeBook | ChatRoute::WholeBookVocabulary) {
        system_content.stable.push_str(
            "\n\nThe user explicitly requested whole-book scope. Use the supplied full book text when it is present. If only retrieved excerpts or generated overviews are supplied, treat them as non-exhaustive evidence and do not claim complete coverage.",
        );
        if route == ChatRoute::WholeBookVocabulary {
            system_content.stable.push_str(
                "\n\nThis is a whole-book vocabulary request. List only words or phrases that literally appear in the supplied original book text, using the source text's primary language unless the user explicitly names another source language. Do not turn themes, historical concepts, places, or explanations into vocabulary items. If the supplied material is not the complete book, state that the vocabulary list is not exhaustive.",
            );
        }
    } else if matches!(
        route,
        ChatRoute::ViewportContext | ChatRoute::ViewportContextVocabulary
    ) {
        system_content.stable.push_str(
            "\n\nThe text currently visible in the user's reader (supplied below as the visible reading area) is the primary source for this request. When the user says \"this passage\" or similar, they mean that visible text. Do not broaden the answer to unrelated book sections unless the user explicitly asks for that.",
        );
        if route == ChatRoute::ViewportContextVocabulary {
            system_content.stable.push_str(
                "\n\nThis is a vocabulary request. List only words or phrases that literally appear in the visible reading area, using its primary language unless the user explicitly asks for another source language. Do not turn themes, historical concepts, places, or explanations into vocabulary items. For every item give the exact form, lemma when applicable, part of speech when applicable, pronunciation when applicable, meaning in the configured response language, an exact short quote from the visible text, and its meaning in context. Never invent a word, quote, or definition that is unsupported by the visible text.",
            );
        }
        if let Some(viewport_text) = viewport_text {
            append_viewport_evidence(system_content, viewport_text);
        }
    } else if route == ChatRoute::CurrentSectionUnavailable {
        // Ungrounded-answer policy: reliable source text is missing, but the
        // user still deserves an answer. Mandatory disclosure instead of a
        // refusal; supplied partial evidence stays preferred.
        system_content.stable.push_str(
            "\n\nThe user asked about their current reading position, but the application could not supply reliable section source text (the index may still be building, or this book's format does not support it). Do not claim to have loaded the section. Still answer as helpfully as you can: prefer any evidence supplied in this conversation (a visible reading area, a quoted selection), and beyond that draw on your own knowledge of this book if you are confident you know it. You MUST open your answer with one brief sentence disclosing that it is not based on the book's actual text. If you do not know this book well enough, say so plainly and suggest selecting a passage — never invent plot details, quotes, or page contents.",
        );
        if live_scope_ambiguous {
            system_content.stable.push_str(
                " In this case the table of contents maps several entries to one source file, so the chapter boundaries are ambiguous; avoid claims about where this chapter starts or ends.",
            );
        }
        if let Some(context) = section_context {
            if context.total_chunks > 0 && context.visible_chunks == 0 {
                system_content.stable.push_str(
                    " The indexed section exists, but its source text is outside the currently readable range.",
                );
            }
        }
        if let Some(viewport_text) = viewport_text {
            append_viewport_evidence(system_content, viewport_text);
        }
    } else if route == ChatRoute::WholeBookUnavailable {
        system_content.stable.push_str(
            "\n\nThe user asked about the whole book, but no reliable original-text source bundle is available. Do not pretend to quote or scan the text. Still answer as helpfully as you can from your own knowledge of this book if you are confident you know it, and from any evidence supplied in this conversation. You MUST open your answer with one brief sentence disclosing that it is not based on the book's actual text. If you do not know this book well enough, say so plainly — never invent plot details or quotes.",
        );
        if let Some(viewport_text) = viewport_text {
            append_viewport_evidence(system_content, viewport_text);
        }
    } else if route == ChatRoute::WholeBookVocabularyUnavailable {
        system_content.stable.push_str(
            "\n\nThe user requested a whole-book vocabulary scan, but a complete original-text source bundle is unavailable, so an actual scan is impossible. Do not fabricate a scan or claim coverage. If you know this book, you may offer a short list of words such a book is likely to make difficult, clearly presented as recalled examples from general knowledge rather than as a scan of the text, with a brief opening disclosure. Otherwise explain that a scan needs the book's index and suggest scanning the current chapter or a selection instead.",
        );
        if let Some(viewport_text) = viewport_text {
            append_viewport_evidence(system_content, viewport_text);
        }
    }
    system_content.stable.push_str(ANSWER_DISCIPLINE);
    system_content.stable.push_str(MARKUP_GUIDE);
}

fn should_inject_full_text(total_tokens: usize, threshold: usize) -> bool {
    total_tokens <= threshold
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SpoilerGuardMetadata {
    pub active: bool,
    pub whole_book_intent: bool,
    pub progress: i32,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiChatResult {
    pub sources: Vec<CitedSource>,
    pub spoiler_guard: SpoilerGuardMetadata,
    pub route: String,
    pub section_index: Option<i64>,
    pub section_end_index: Option<i64>,
    pub section_context: Option<SectionContextMetadata>,
    /// Hash of the indexed source used for this routing decision. A follow-up
    /// may inherit a scope only when its snapshot matches this hash.
    pub source_hash: Option<String>,
    pub context_budget: ContextBudgetMetadata,
}

/// What the request budget had to leave out. Reported rather than applied
/// silently: a reader who cannot see that the conversation was shortened
/// experiences it as the assistant losing the thread for no reason.
#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContextBudgetMetadata {
    /// Oldest conversation messages dropped to fit the history budget.
    pub history_omitted: usize,
    /// Trailing source excerpts dropped to fit the request ceiling.
    pub excerpts_omitted: usize,
}

/// How many bytes of book text this request may inject.
///
/// Derived from the reader's own `ai_full_text_threshold` rather than guessed
/// from a model name. Model windows are not discoverable here — Lantern talks
/// to arbitrary OpenAI-compatible endpoints, including local models with far
/// smaller windows than the hosted ones — but that setting is the reader
/// stating, in tokens, how much source text their model can swallow. Deriving
/// from it makes the budget structurally incapable of contradicting the
/// full-text injection it is supposed to bound: whatever the threshold admits,
/// this budget has room for.
fn chat_source_budget_bytes(full_text_threshold_tokens: usize) -> usize {
    full_text_threshold_tokens
        .saturating_mul(CHAT_BYTES_PER_TOKEN)
        .max(CHAT_SOURCE_FLOOR_BYTES)
}

/// Drop trailing excerpts until injected source text fits its budget,
/// returning how many went. Trailing rather than arbitrary: excerpts arrive in
/// reading order, and a prefix stays coherent where a bag of holes would not.
fn trim_excerpts_to_budget(excerpts: &mut Vec<RetrievedChunk>, budget: usize) -> usize {
    let mut used = 0usize;
    let mut keep = 0usize;
    for excerpt in excerpts.iter() {
        let next = used.saturating_add(excerpt.text.len());
        if next > budget {
            break;
        }
        used = next;
        keep += 1;
    }
    let omitted = excerpts.len().saturating_sub(keep);
    excerpts.truncate(keep);
    omitted
}

pub(super) fn ready_index_source_hash(db: &Db, book_id: &str) -> AppResult<Option<String>> {
    grounding::index::ready_source_sha256(db, book_id)
}

fn truncate_chars(value: &str, maximum: usize) -> String {
    value
        .chars()
        .take(maximum)
        .collect::<String>()
        .trim_end()
        .to_string()
}

fn format_book_overview(overview: &grounding::summarize::BookOverview) -> String {
    let mut book_content = overview.content.clone();
    let mut sections = overview.sections.clone();
    let render = |book: &str, sections: &[grounding::summarize::SectionOverview]| {
        let section_lines = sections
            .iter()
            .map(|section| {
                format!(
                    "- [{}] {}: {}",
                    section.section_index,
                    section.section_title.as_deref().unwrap_or("Untitled"),
                    truncate_chars(&section.content, 100),
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        if section_lines.is_empty() {
            format!("\n\nBook overview (generated summary, not the book's own words):\n{book}")
        } else if book.is_empty() {
            format!("\n\nRead-section summaries (generated summaries, not the book's own words):\n{section_lines}")
        } else {
            format!("\n\nBook overview (generated summary, not the book's own words):\n{book}\n\nSections:\n{section_lines}")
        }
    };
    while grounding::chunk::estimate_tokens(&render(&book_content, &sections))
        > OVERVIEW_BUDGET_TOKENS
        && !sections.is_empty()
    {
        sections.remove(sections.len() / 2);
    }
    let mut rendered = render(&book_content, &sections);
    while grounding::chunk::estimate_tokens(&rendered) > OVERVIEW_BUDGET_TOKENS
        && !book_content.is_empty()
    {
        let next_len = book_content.chars().count().saturating_sub(100).max(1);
        let next = truncate_chars(&book_content, next_len);
        if next == book_content {
            break;
        }
        book_content = next;
        rendered = render(&book_content, &sections);
    }
    rendered
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ai_chat(
    messages: Vec<ChatMessage>,
    book_id: Option<String>,
    book_title: Option<String>,
    book_author: Option<String>,
    current_chapter: Option<String>,
    current_section_index: Option<i64>,
    current_scope_start_index: Option<i64>,
    current_scope_end_index: Option<i64>,
    current_scope_ambiguous: Option<bool>,
    previous_route: Option<String>,
    previous_section_index: Option<i64>,
    previous_section_end_index: Option<i64>,
    previous_source_hash: Option<String>,
    request_id: String,
    spoiler_override: Option<bool>,
    // `true` only when the user asked again after a failure, so the router may
    // look past a cooldown it recorded itself.
    retry: Option<bool>,
    scope_override: Option<String>,
    viewport_text: Option<String>,
    app: AppHandle,
    db: State<'_, Db>,
    secrets: State<'_, Secrets>,
) -> AppResult<AiChatResult> {
    // The visible reading area, captured by the reader at send time. Used as
    // the implicit passage for viewport routes and as partial evidence for
    // ungrounded answers. Never persisted with the message.
    let viewport_text = viewport_text
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| truncate_utf8(value, VIEWPORT_MAX_BYTES).to_string());
    let has_viewport = viewport_text.is_some();
    let manual_scope = scope_override.as_deref().and_then(parse_scope_override);
    let current_index_status = book_id
        .as_deref()
        .map(|book_id| grounding::index::index_status(&db, book_id))
        .transpose()?
        .unwrap_or(IndexStatus::Missing);
    let current_index_ready = current_index_status == IndexStatus::Ready;
    let current_source_hash = match book_id.as_deref() {
        Some(book_id) => match ready_index_source_hash(&db, book_id) {
            Ok(hash) => hash,
            Err(error) => {
                log::warn!("AI scope snapshot unavailable for {book_id}: {error}");
                None
            }
        },
        None => None,
    };
    let scope_snapshot_matches = current_index_ready
        && previous_source_hash
            .as_deref()
            .zip(current_source_hash.as_deref())
            .is_some_and(|(previous, current)| previous == current);
    let latest_user_index = messages.iter().rposition(|message| message.role == "user");
    let latest_question = latest_user_index
        .and_then(|index| messages.get(index))
        .map(|message| message.content.as_str())
        .unwrap_or_default();
    let latest_instruction = routing_instruction(latest_question);
    let current_section_index = current_section_index.filter(|value| *value >= 0);
    let current_scope_start_index = current_scope_start_index
        .filter(|value| *value >= 0)
        .or(current_section_index);
    let current_scope_end_index = current_scope_end_index
        .filter(|value| *value >= 0)
        .filter(|value| current_scope_start_index.is_some_and(|start| *value >= start));
    let current_scope_ambiguous = current_scope_ambiguous.unwrap_or(false);
    let (structured_previous_route, inherited_route) = resolve_inherited_route(
        previous_route.as_deref(),
        scope_snapshot_matches,
        &messages,
        latest_user_index,
        current_scope_start_index,
    );
    let inherited_section_index = structured_previous_route
        .filter(|route| {
            matches!(
                route,
                ChatRoute::CurrentSection
                    | ChatRoute::CurrentSectionVocabulary
                    | ChatRoute::CurrentSectionUnavailable
            )
        })
        .and(previous_section_index.filter(|value| *value >= 0));
    let inherited_section_end_index = structured_previous_route
        .filter(|route| {
            matches!(
                route,
                ChatRoute::CurrentSection
                    | ChatRoute::CurrentSectionVocabulary
                    | ChatRoute::CurrentSectionUnavailable
            )
        })
        .and(previous_section_end_index.filter(|value| *value >= 0));
    // A manual scope chip is an explicit scope: it pins the request to the
    // live reader position and ignores inherited section indexes.
    let latest_has_explicit_scope = manual_scope.is_some() || has_explicit_scope(latest_question);
    let effective_section_index = if !latest_has_explicit_scope {
        inherited_section_index.or(current_scope_start_index)
    } else {
        current_scope_start_index
    };
    let effective_section_end_index =
        if !latest_has_explicit_scope && inherited_section_index.is_some() {
            inherited_section_end_index
        } else {
            current_scope_end_index
        };
    // A vague follow-up may intentionally inherit the previous, already
    // resolved section even after the viewport moves into an ambiguous TOC
    // fragment. Apply the live ambiguity guard only when this request uses the
    // current reader scope.
    let live_scope_ambiguous =
        current_scope_ambiguous && (latest_has_explicit_scope || inherited_section_index.is_none());
    let mut route = manual_scope
        .and_then(|scope| {
            route_for_override(
                scope,
                latest_question,
                effective_section_index,
                has_viewport,
            )
        })
        .unwrap_or_else(|| {
            classify_chat_route(
                latest_question,
                effective_section_index,
                inherited_route,
                has_viewport,
            )
        });
    // Keyword routing came up empty-handed on an in-book question: let the
    // provider break the tie. Any classifier failure keeps the keyword route.
    if route == ChatRoute::Generic
        && manual_scope.is_none()
        && !latest_has_explicit_scope
        && inherited_route.is_none()
        && book_id.is_some()
    {
        route = match intent::classify_ambiguous_intent(&app, &db, &secrets, &latest_instruction)
            .await
        {
            Some(intent::IntentScope::Passage) if has_viewport => ChatRoute::ViewportContext,
            Some(intent::IntentScope::Section) => {
                if effective_section_index.is_some() {
                    ChatRoute::CurrentSection
                } else {
                    ChatRoute::CurrentSectionUnavailable
                }
            }
            Some(intent::IntentScope::Book) => ChatRoute::WholeBook,
            _ => ChatRoute::Generic,
        };
    }
    let whole_book_intent = has_whole_book_intent(&latest_instruction)
        || matches!(
            route,
            ChatRoute::WholeBook
                | ChatRoute::WholeBookUnavailable
                | ChatRoute::WholeBookVocabulary
                | ChatRoute::WholeBookVocabularyUnavailable
        );
    let requested_section_route = matches!(
        route,
        ChatRoute::CurrentSection | ChatRoute::CurrentSectionVocabulary
    );
    let (language, grounding_enabled, full_text_threshold, vector_retrieval_enabled) = {
        let conn = db.reader();
        let get = |key: &str| -> Option<String> {
            conn.query_row(
                "SELECT value FROM settings WHERE key = ?1",
                rusqlite::params![key],
                |row| row.get(0),
            )
            .ok()
        };
        (
            get("language").unwrap_or_else(|| "en".to_string()),
            get("ai_grounding_enabled")
                .map(|value| value != "false")
                .unwrap_or(true),
            get("ai_full_text_threshold")
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(30_000),
            get("ai_vector_retrieval")
                .map(|value| value == "true")
                .unwrap_or(false),
        )
    };

    // A section route is only valid when the application can provide indexed
    // source text. Keep the effective route explicit if grounding or the book
    // identity is unavailable; this prevents a generic answer from being
    // presented as a chapter-grounded one.
    if requested_section_route && (!grounding_enabled || book_id.is_none()) {
        route = ChatRoute::CurrentSectionUnavailable;
    }
    if live_scope_ambiguous
        && matches!(
            route,
            ChatRoute::CurrentSection | ChatRoute::CurrentSectionVocabulary
        )
    {
        route = ChatRoute::CurrentSectionUnavailable;
    }
    if route == ChatRoute::WholeBook && (!grounding_enabled || book_id.is_none()) {
        route = ChatRoute::WholeBookUnavailable;
    }
    if route == ChatRoute::WholeBookVocabulary && (!grounding_enabled || book_id.is_none()) {
        // An exhaustive vocabulary task has no safe fallback. Do not let the
        // provider manufacture a list from the book title, summaries, or chat
        // history when the original-text index is unavailable.
        route = ChatRoute::WholeBookVocabularyUnavailable;
    }

    let (spoiler_guard_active, spoiler_cutoff, reading_progress) =
        if let Some(book_id) = book_id.as_deref() {
            let resolution = grounding::spoiler::resolve_cutoff(&db, book_id)?;
            if spoiler_override.unwrap_or(false) {
                (false, None, resolution.progress)
            } else {
                (resolution.active, resolution.cutoff, resolution.progress)
            }
        } else {
            (false, None, 0)
        };

    let mut excerpts = Vec::new();
    let mut overview = None;
    let mut full_text = false;
    let mut scoped_text = false;
    let mut section_context = None;
    let mut vocabulary_scan_plan = None;
    if grounding_enabled {
        if let Some(book_id) = book_id.as_deref() {
            // A ready row with a different source snapshot is not usable. Let
            // the normal missing/building path schedule a rebuild instead of
            // sending stale chunks to the provider.
            let index_status = if current_index_ready && current_source_hash.is_none() {
                IndexStatus::Missing
            } else {
                current_index_status
            };
            match index_status {
                IndexStatus::Ready => {
                    if requested_section_route && route != ChatRoute::CurrentSectionUnavailable {
                        if let Some(section_index) = effective_section_index {
                            let db = db.inner().clone();
                            let book_id = book_id.to_string();
                            let retrieval_book_id = book_id.clone();
                            let retrieval_budget = if route == ChatRoute::CurrentSectionVocabulary {
                                usize::MAX
                            } else {
                                SECTION_CONTEXT_BUDGET_TOKENS
                            };
                            let retrieval = tauri::async_runtime::spawn_blocking(move || {
                                let conn = db.reader();
                                grounding::retrieve::retrieve_section_range_with_budget(
                                    &conn,
                                    &retrieval_book_id,
                                    section_index,
                                    effective_section_end_index,
                                    retrieval_budget,
                                    spoiler_cutoff,
                                )
                            })
                            .await
                            .map_err(|error| AppError::Other(error.to_string()))??;
                            section_context =
                                Some(SectionContextMetadata::from_retrieval(&retrieval));
                            if retrieval.total_chunks == 0 || retrieval.visible_chunks == 0 {
                                route = ChatRoute::CurrentSectionUnavailable;
                            } else if route == ChatRoute::CurrentSectionVocabulary {
                                let all_batches = grounding::vocabulary::batches(
                                    &retrieval.chunks,
                                    grounding::vocabulary::BATCH_TOKEN_BUDGET,
                                );
                                let total_batches = all_batches.len();
                                let partial = total_batches
                                    > grounding::vocabulary::MAX_MAP_BATCHES
                                    || retrieval.spoiler_limited;
                                let batches = all_batches
                                    .into_iter()
                                    .take(grounding::vocabulary::MAX_MAP_BATCHES)
                                    .collect::<Vec<_>>();
                                let source_chunks = batches
                                    .iter()
                                    .flat_map(|batch| batch.chunks.iter().cloned())
                                    .collect::<Vec<_>>();
                                let selected_tokens =
                                    source_chunks.iter().fold(0usize, |sum, chunk| {
                                        sum.saturating_add(chunk.token_estimate)
                                    });
                                section_context = Some(vocabulary_context_metadata(
                                    &retrieval,
                                    source_chunks.len(),
                                    selected_tokens,
                                ));
                                vocabulary_scan_plan = Some(VocabularyScanPlan {
                                    book_id: book_id.to_string(),
                                    source_hash: current_source_hash.clone(),
                                    batches,
                                    source_chunks,
                                    total_batches,
                                    partial,
                                });
                            } else {
                                excerpts = retrieval.chunks;
                                scoped_text = true;
                            }
                        }
                    } else if route == ChatRoute::WholeBookVocabulary {
                        let total_tokens = {
                            let conn = db.reader();
                            grounding::retrieve::total_book_tokens(&conn, book_id)?
                        };
                        if spoiler_cutoff.is_some()
                            || !should_inject_full_text(total_tokens, full_text_threshold)
                        {
                            route = ChatRoute::WholeBookVocabularyUnavailable;
                        } else {
                            let db = db.inner().clone();
                            let book_id = book_id.to_string();
                            let (next_excerpts, next_full_text) =
                                tauri::async_runtime::spawn_blocking(move || {
                                    let conn = db.reader();
                                    Ok::<(Vec<RetrievedChunk>, bool), AppError>((
                                        grounding::retrieve::retrieve_all(&conn, &book_id, None)?,
                                        true,
                                    ))
                                })
                                .await
                                .map_err(|error| AppError::Other(error.to_string()))??;
                            excerpts = next_excerpts;
                            full_text = next_full_text;
                        }
                    } else if !matches!(
                        route,
                        ChatRoute::SelectedContext
                            | ChatRoute::SelectedContextVocabulary
                            | ChatRoute::ViewportContext
                            | ChatRoute::ViewportContextVocabulary
                            | ChatRoute::CurrentSectionUnavailable
                    ) {
                        if let Some(question) =
                            messages.iter().rev().find(|message| message.role == "user")
                        {
                            let db = db.inner().clone();
                            let book_id = book_id.to_string();
                            let query =
                                truncate_utf8(&routing_instruction(&question.content), 2_000)
                                    .to_string();
                            let use_full_text = {
                                let conn = db.reader();
                                should_inject_full_text(
                                    grounding::retrieve::total_book_tokens(&conn, &book_id)?,
                                    full_text_threshold,
                                )
                            };
                            let query_vector = if vector_retrieval_enabled && !use_full_text {
                                match grounding::vector::source(&db, &secrets) {
                                    Ok(Some(source)) => {
                                        match grounding::vector::has_complete_embeddings(
                                            &db, &book_id, &source,
                                        ) {
                                            Ok(true) => {
                                                match grounding::vector::query_embedding(
                                                    &source,
                                                    query.clone(),
                                                )
                                                .await
                                                {
                                                    Ok(embedding) => Some(embedding),
                                                    Err(error) => {
                                                        log::warn!("grounding vector query embedding failed: {error}");
                                                        None
                                                    }
                                                }
                                            }
                                            Ok(false) => {
                                                let index_app = app.clone();
                                                let index_db = db.clone();
                                                let index_secrets = secrets.inner().clone();
                                                let index_book_id = book_id.clone();
                                                tauri::async_runtime::spawn(async move {
                                                    // Stage ② before stage ③, same as the
                                                    // manual reindex path — but its failure
                                                    // must not skip the embedding backfill:
                                                    // this book still needs to become
                                                    // searchable even with no identity
                                                    // sentences.
                                                    if let Err(error) =
                                                        grounding::context::ensure_context_lines(
                                                            &index_app,
                                                            &index_db,
                                                            &index_secrets,
                                                            &index_book_id,
                                                        )
                                                        .await
                                                    {
                                                        log::warn!(
                                                        "grounding context line backfill failed: {error}"
                                                    );
                                                    }
                                                    if let Err(error) =
                                                        grounding::vector::ensure_embeddings(
                                                            &index_db,
                                                            &index_book_id,
                                                            &source,
                                                        )
                                                        .await
                                                    {
                                                        log::warn!(
                                                        "grounding vector backfill failed: {error}"
                                                    );
                                                    }
                                                });
                                                None
                                            }
                                            Err(error) => {
                                                log::warn!(
                                                    "grounding vector state check failed: {error}"
                                                );
                                                None
                                            }
                                        }
                                    }
                                    Ok(None) => None,
                                    Err(error) => {
                                        log::warn!("grounding vector source unavailable: {error}");
                                        None
                                    }
                                }
                            } else {
                                None
                            };
                            let (next_excerpts, next_full_text) = tauri::async_runtime::spawn_blocking(
                                move || {
                                    let conn = db.reader();
                                    if use_full_text {
                                        Ok::<(Vec<RetrievedChunk>, bool), AppError>((
                                            grounding::retrieve::retrieve_all(
                                                &conn,
                                                &book_id,
                                                spoiler_cutoff,
                                            )?,
                                            true,
                                        ))
                                    } else {
                                        let excerpts = if let Some(query_vector) = query_vector {
                                            match grounding::vector::hybrid_retrieve(
                                                &conn,
                                                &book_id,
                                                &query,
                                                &query_vector,
                                                RETRIEVAL_BUDGET_TOKENS,
                                                spoiler_cutoff,
                                            ) {
                                                Ok(excerpts) => excerpts,
                                                Err(error) => {
                                                    log::warn!("grounding hybrid retrieval failed, using BM25: {error}");
                                                    grounding::retrieve(
                                                        &conn,
                                                        &book_id,
                                                        &query,
                                                        RETRIEVAL_BUDGET_TOKENS,
                                                        spoiler_cutoff,
                                                    )?
                                                }
                                            }
                                        } else {
                                            grounding::retrieve(
                                                &conn,
                                                &book_id,
                                                &query,
                                                RETRIEVAL_BUDGET_TOKENS,
                                                spoiler_cutoff,
                                            )?
                                        };
                                        Ok::<(Vec<RetrievedChunk>, bool), AppError>((
                                            excerpts,
                                            false,
                                        ))
                                    }
                                },
                            )
                            .await
                            .map_err(|error| AppError::Other(error.to_string()))??;
                            excerpts = next_excerpts;
                            full_text = next_full_text;
                        }
                    }
                    if !full_text
                        && !scoped_text
                        && !matches!(
                            route,
                            ChatRoute::SelectedContext
                                | ChatRoute::SelectedContextVocabulary
                                | ChatRoute::ViewportContext
                                | ChatRoute::ViewportContextVocabulary
                                | ChatRoute::CurrentSectionVocabulary
                                | ChatRoute::WholeBookVocabulary
                                | ChatRoute::WholeBookVocabularyUnavailable
                                | ChatRoute::CurrentSectionUnavailable
                        )
                    {
                        overview = match spoiler_cutoff {
                            Some(cutoff) => {
                                grounding::summarize::load_section_overview(&db, book_id, cutoff)
                                    .unwrap_or(None)
                            }
                            None => grounding::summarize::load_book_overview(&db, book_id)
                                .unwrap_or(None),
                        };
                    }
                    if route == ChatRoute::WholeBook && excerpts.is_empty() && overview.is_none() {
                        route = ChatRoute::WholeBookUnavailable;
                    }
                }
                IndexStatus::Unsupported | IndexStatus::Failed => {
                    if requested_section_route {
                        route = ChatRoute::CurrentSectionUnavailable;
                    }
                    if route == ChatRoute::WholeBook {
                        route = ChatRoute::WholeBookUnavailable;
                    }
                    if route == ChatRoute::WholeBookVocabulary {
                        route = ChatRoute::WholeBookVocabularyUnavailable;
                    }
                    let event_name = format!("ai-grounding-status-{request_id}");
                    let _ = app.emit(&event_name, serde_json::json!({ "status": "unavailable" }));
                }
                IndexStatus::Missing | IndexStatus::Building => {
                    if requested_section_route {
                        route = ChatRoute::CurrentSectionUnavailable;
                    }
                    if route == ChatRoute::WholeBook {
                        route = ChatRoute::WholeBookUnavailable;
                    }
                    if route == ChatRoute::WholeBookVocabulary {
                        route = ChatRoute::WholeBookVocabularyUnavailable;
                    }
                    grounding::index::schedule_index(app.clone(), book_id.to_string());
                    let event_name = format!("ai-grounding-status-{request_id}");
                    let _ = app.emit(&event_name, serde_json::json!({ "status": "building" }));
                }
            }
        }
    }
    // A passage-scoped route with nothing attached to this turn keeps the last
    // one in effect; that is what a follow-up means. Decided here, after every
    // route reassignment above has settled.
    let selection = if is_selected_context(latest_question) {
        SelectionState::Attached
    } else if matches!(
        route,
        ChatRoute::SelectedContext | ChatRoute::SelectedContextVocabulary
    ) && has_earlier_selection(&messages, latest_user_index)
    {
        SelectionState::Carried
    } else {
        SelectionState::Missing
    };
    let quoted_reply = has_quoted_reply(latest_question);

    // Two independent budgets rather than one pool the conversation has to
    // compete for. History is never traded away for excerpt depth — losing a
    // turn reads as the assistant forgetting, losing a trailing excerpt only
    // costs detail — and the source budget is whatever the reader's own
    // full-text threshold already permits.
    let (history, history_omitted) = labeled_chat_history(
        messages,
        CHAT_MAX_TOTAL_BYTES,
        selection == SelectionState::Carried,
    );
    let excerpts_omitted =
        trim_excerpts_to_budget(&mut excerpts, chat_source_budget_bytes(full_text_threshold));
    if excerpts_omitted > 0 {
        if let Some(context) = section_context.as_mut() {
            context.selected_chunks = context.selected_chunks.saturating_sub(excerpts_omitted);
            context.truncated = true;
            context.coverage = if context.spoiler_limited {
                "partial_budget_and_reading_protection".to_string()
            } else {
                "partial_budget".to_string()
            };
        }
    }

    let (mut system_content, mut sources) = build_chat_system_content(
        book_title.as_deref(),
        book_author.as_deref(),
        current_chapter.as_deref(),
        &language,
        overview.as_ref(),
        &excerpts,
        (full_text && spoiler_cutoff.is_none()) || scoped_text,
        spoiler_guard_active,
    );
    if vocabulary_scan_plan.is_some() {
        sources.clear();
    }
    append_chat_route_instructions(
        &mut system_content,
        route,
        section_context.as_ref(),
        viewport_text.as_deref(),
        live_scope_ambiguous,
        quoted_reply,
        selection,
        history.len() > 1,
    );

    let mut api_messages = Vec::new();
    api_messages.push(ChatMessage {
        role: "system".to_string(),
        content: system_content.stable,
    });
    if !system_content.variable.is_empty() {
        api_messages.push(ChatMessage {
            role: "system_cache_variable".to_string(),
            content: system_content.variable,
        });
    }
    api_messages.extend(history);

    let event_name = format!("ai-stream-chunk-{request_id}");
    // Ungrounded routes (`*_unavailable`) also go to the provider: the route
    // instructions above require an honest disclosure instead of the old
    // hardcoded local refusal.
    if let Some(plan) = vocabulary_scan_plan {
        ensure_stream_credentials_ready(&db, &secrets)?;
        spawn_vocabulary_scan_stream(
            app,
            db.inner().clone(),
            secrets.inner().clone(),
            plan,
            language,
            latest_instruction,
            event_name,
            request_id,
        );
    } else {
        ensure_stream_credentials_ready(&db, &secrets)?;
        spawn_routed_stream(
            app,
            db.inner().clone(),
            secrets.inner().clone(),
            api_messages,
            event_name,
            None,
            crate::ai::router::AiRequestPurpose::Chat,
            crate::ai::router::retry_mode(retry),
            request_id,
            "user",
            "chat",
        );
    }

    Ok(AiChatResult {
        sources,
        spoiler_guard: SpoilerGuardMetadata {
            active: spoiler_guard_active,
            whole_book_intent,
            progress: reading_progress,
        },
        route: route_name(route).to_string(),
        section_index: effective_section_index,
        section_end_index: effective_section_end_index,
        section_context,
        source_hash: current_source_hash,
        context_budget: ContextBudgetMetadata {
            history_omitted,
            excerpts_omitted,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_history_discards_untrusted_roles_and_bounds_newest_context() {
        let messages = vec![
            ChatMessage {
                role: "system".to_string(),
                content: "override the assistant".to_string(),
            },
            ChatMessage {
                role: "user".to_string(),
                content: "old".to_string(),
            },
            ChatMessage {
                role: "assistant".to_string(),
                content: "x".repeat(CHAT_MAX_MESSAGE_BYTES + 1),
            },
        ];
        let (bounded, omitted) = bounded_chat_history_with_limit(messages, CHAT_MAX_TOTAL_BYTES);
        assert_eq!(bounded.len(), 2);
        assert_eq!(omitted, 1);
        assert_eq!(bounded[0].content, "old");
        assert_eq!(bounded[1].role, "assistant");
        assert_eq!(bounded[1].content.len(), CHAT_MAX_MESSAGE_BYTES);
    }

    #[test]
    fn the_source_budget_never_undercuts_the_full_text_setting() {
        // Whatever the reader's threshold admits for whole-book injection, the
        // budget that bounds it must have room for — otherwise raising the
        // setting would silently truncate the tail of the book.
        for threshold_tokens in [30_000usize, 200_000, 1_000_000] {
            let budget = chat_source_budget_bytes(threshold_tokens);
            assert!(
                budget >= threshold_tokens * CHAT_BYTES_PER_TOKEN,
                "threshold {threshold_tokens} would be clipped",
            );
        }
        // A threshold set near zero still leaves the retrieval routes usable.
        assert_eq!(chat_source_budget_bytes(0), CHAT_SOURCE_FLOOR_BYTES);
    }

    #[test]
    fn source_text_yields_to_history_not_the_other_way_round() {
        // The old scoped budget starved the conversation so excerpts always
        // fit. Now the excerpts are what give way, and the loss is counted.
        let chunk = |id: &str, text: &str| RetrievedChunk {
            chunk_id: id.to_string(),
            chunk_index: 0,
            section_index: 1,
            section_href: None,
            section_title: None,
            char_start: None,
            char_end: None,
            snippet: text.to_string(),
            text: text.to_string(),
            token_estimate: 4,
            score: -1.0,
        };
        let mut excerpts = vec![
            chunk("a", &"a".repeat(100)),
            chunk("b", &"b".repeat(100)),
            chunk("c", &"c".repeat(100)),
        ];
        let omitted = trim_excerpts_to_budget(&mut excerpts, 250);
        assert_eq!(omitted, 1);
        assert_eq!(excerpts.len(), 2);
        // Reading order is preserved: a prefix, never a bag of holes.
        assert_eq!(excerpts[0].chunk_id, "a");
        assert_eq!(excerpts[1].chunk_id, "b");
    }

    #[test]
    fn a_history_that_fits_reports_nothing_omitted() {
        let messages = vec![
            ChatMessage {
                role: "user".into(),
                content: "问题".into(),
            },
            ChatMessage {
                role: "assistant".into(),
                content: "回答".into(),
            },
        ];
        let (bounded, omitted) = bounded_chat_history_with_limit(messages, CHAT_MAX_TOTAL_BYTES);
        assert_eq!(bounded.len(), 2);
        assert_eq!(omitted, 0);
    }

    #[test]
    fn grounded_chat_system_content_injects_untrusted_excerpts_and_sources() {
        let excerpt = RetrievedChunk {
            chunk_id: "chunk-1".to_string(),
            chunk_index: 0,
            section_index: 2,
            section_href: Some("chapter.xhtml".to_string()),
            section_title: Some("A chapter".to_string()),
            char_start: None,
            char_end: None,
            snippet: "A precise fact.".to_string(),
            text: "A precise fact from the book.".to_string(),
            token_estimate: 8,
            score: -1.0,
        };
        let (content, sources) = build_chat_system_content(
            Some("Book"),
            Some("Author"),
            None,
            "en",
            None,
            &[excerpt],
            false,
            false,
        );
        let combined = content.combined();
        assert!(combined.contains("[S1] (section: A chapter)"));
        assert!(combined.contains("say so rather than inventing details"));
        assert!(content.variable.contains("[S1]"));
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].marker, "S1");
        assert_eq!(sources[0].chunk_id, "chunk-1");
    }

    #[test]
    fn metadata_only_system_content_is_unchanged_without_excerpts() {
        let (content, sources) =
            build_chat_system_content(Some("Book"), None, None, "zh", None, &[], false, false);
        assert_eq!(
            content.combined(),
            "You are a helpful reading assistant. Help the user understand and discuss the book they are reading.\n\nThe following is reference metadata for the book:\n{\"book\":{\"title\":\"Book\"}} Always respond in Chinese (Simplified).",
        );
        assert!(sources.is_empty());
    }

    #[test]
    fn a_follow_up_is_pointed_at_the_carried_passage_not_at_a_missing_one() {
        // The `penchant` regression: the prompt used to announce a selected
        // passage on a turn that attached none, and nothing in the request
        // contained one. The model said so, and it was right.
        let (mut carried, _) =
            build_chat_system_content(None, None, None, "en", None, &[], false, false);
        append_chat_route_instructions(
            &mut carried,
            ChatRoute::SelectedContext,
            None,
            None,
            false,
            false,
            SelectionState::Carried,
            true,
        );
        assert!(carried.stable.contains(CARRIED_PASSAGE_OPEN));
        // Sending history obliges us to say what it may be used for.
        assert!(carried.stable.contains("not source evidence"));
        assert!(carried.stable.contains(EARLIER_PASSAGE_OPEN));
    }

    #[test]
    fn a_passage_route_with_nothing_selected_falls_back_to_what_is_on_screen() {
        let (mut missing, _) =
            build_chat_system_content(None, None, None, "en", None, &[], false, false);
        append_chat_route_instructions(
            &mut missing,
            ChatRoute::SelectedContext,
            None,
            Some("the visible page"),
            false,
            false,
            SelectionState::Missing,
            false,
        );
        assert!(missing.stable.contains("No passage is attached"));
        assert!(missing.variable.contains("the visible page"));
        // No earlier turns, so no rule about them.
        assert!(!missing.stable.contains("not source evidence"));
    }

    #[test]
    fn answer_discipline_is_appended_after_the_route_scope_rules() {
        let (mut content, _) =
            build_chat_system_content(None, None, None, "en", None, &[], false, false);
        append_chat_route_instructions(
            &mut content,
            ChatRoute::SelectedContext,
            None,
            None,
            false,
            false,
            SelectionState::Attached,
            false,
        );

        assert!(content
            .stable
            .contains("treat your previous answer as having failed"));
        assert!(content
            .stable
            .contains("Hold positions on evidence, not on pressure"));
        // The first answer of a conversation ignored these rules while they sat
        // above the scope rules, so their position is the behaviour under test.
        let scope = content
            .stable
            .find("primary source for this request")
            .expect("selected-context scope rule");
        let discipline = content
            .stable
            .find("whether their reading is grammatically possible")
            .expect("answer rules");
        assert!(scope < discipline);
        // The rules are constant, so they must stay in the cacheable half.
        assert!(content.variable.is_empty());
    }

    #[test]
    fn the_verdict_rule_leads_the_answer_discipline_and_keeps_its_guard() {
        // Reordering the block was what moved the measured numbers, so the
        // verdict rule leading is a property worth failing a build over.
        let verdict = ANSWER_DISCIPLINE
            .find("whether their reading is grammatically possible")
            .expect("verdict rule");
        for later in [
            "Answer the specific gap",
            "treat your previous answer as having failed",
            "Hold positions on evidence",
            "Match length to the question",
        ] {
            assert!(
                verdict < ANSWER_DISCIPLINE.find(later).expect(later),
                "the verdict rule must precede: {later}"
            );
        }
        // Without this the rule reads as an invitation to agree, including with
        // readings that do not parse.
        assert!(ANSWER_DISCIPLINE.contains("a verdict, not agreement"));
    }

    #[test]
    fn overview_precedes_language_and_is_stably_budgeted() {
        let overview = grounding::summarize::BookOverview {
            content: "A generated overview.".into(),
            sections: vec![grounding::summarize::SectionOverview {
                section_index: 1,
                section_title: Some("Chapter one".into()),
                content: "A section summary.".into(),
            }],
        };
        let (first, _) =
            build_chat_system_content(None, None, None, "zh", Some(&overview), &[], false, false);
        let (second, _) =
            build_chat_system_content(None, None, None, "zh", Some(&overview), &[], false, false);
        assert_eq!(first, second);
        let first = first.combined();
        assert!(first.find("Book overview").unwrap() < first.find("Always respond").unwrap());
        assert!(
            grounding::chunk::estimate_tokens(&format_book_overview(&overview))
                <= OVERVIEW_BUDGET_TOKENS
        );
    }

    #[test]
    fn short_books_use_full_text_at_the_configured_threshold() {
        assert!(should_inject_full_text(30_000, 30_000));
        assert!(should_inject_full_text(29_999, 30_000));
        assert!(!should_inject_full_text(30_001, 30_000));
    }

    #[test]
    fn full_text_excerpts_are_stable_and_keep_markers_contiguous() {
        let excerpts = vec![
            RetrievedChunk {
                chunk_id: "chunk-1".to_string(),
                chunk_index: 0,
                section_index: 0,
                section_href: Some("one.xhtml".to_string()),
                section_title: Some("One".to_string()),
                char_start: None,
                char_end: None,
                snippet: "First".to_string(),
                text: "First passage.".to_string(),
                token_estimate: 3,
                score: 0.0,
            },
            RetrievedChunk {
                chunk_id: "chunk-2".to_string(),
                chunk_index: 1,
                section_index: 1,
                section_href: Some("two.xhtml".to_string()),
                section_title: Some("Two".to_string()),
                char_start: None,
                char_end: None,
                snippet: "Second".to_string(),
                text: "Second passage.".to_string(),
                token_estimate: 3,
                score: 0.0,
            },
        ];
        let (content, sources) = build_chat_system_content(
            Some("Short book"),
            None,
            None,
            "en",
            None,
            &excerpts,
            true,
            false,
        );

        assert!(content.stable.contains("[S1] (section: One)"));
        assert!(content.stable.contains("[S2] (section: Two)"));
        assert!(content.variable.is_empty());
        assert_eq!(
            sources
                .iter()
                .map(|source| source.marker.as_str())
                .collect::<Vec<_>>(),
            vec!["S1", "S2"]
        );
    }

    #[test]
    fn vocabulary_route_requires_literal_source_words() {
        let mut content = SystemContent {
            stable: String::new(),
            variable: String::new(),
        };
        append_chat_route_instructions(
            &mut content,
            ChatRoute::CurrentSectionVocabulary,
            None,
            None,
            false,
            false,
            SelectionState::Attached,
            false,
        );
        assert!(content.stable.contains("literally appear"));
        assert!(content.stable.contains("primary language"));
        assert!(content.stable.contains("configured response language"));
        assert!(content.stable.contains("lemma"));
        assert!(content.stable.contains("exact short source sentence"));
        assert!(content.stable.contains("source marker"));
        assert!(content.stable.contains("Never invent a word"));
        assert!(!content.stable.contains("generated overview"));

        let mut selected = SystemContent {
            stable: String::new(),
            variable: String::new(),
        };
        append_chat_route_instructions(
            &mut selected,
            ChatRoute::SelectedContextVocabulary,
            None,
            None,
            false,
            false,
            SelectionState::Attached,
            false,
        );
        assert!(selected
            .stable
            .contains("literally appear in the selected passage"));
        assert!(selected.stable.contains("exact short quote"));

        let mut unavailable = SystemContent {
            stable: String::new(),
            variable: String::new(),
        };
        append_chat_route_instructions(
            &mut unavailable,
            ChatRoute::CurrentSectionUnavailable,
            None,
            None,
            false,
            false,
            SelectionState::Attached,
            false,
        );
        assert!(unavailable
            .stable
            .contains("could not supply reliable section source text"));
        assert!(unavailable.stable.contains("disclosing"));
        assert!(!unavailable
            .stable
            .contains("The application will provide a local explanation"));
    }

    #[test]
    fn section_context_prompt_marks_budget_and_spoiler_limits() {
        let mut content = SystemContent {
            stable: String::new(),
            variable: String::new(),
        };
        let metadata = SectionContextMetadata {
            total_chunks: 12,
            total_tokens: 24_000,
            visible_chunks: 4,
            visible_tokens: 8_000,
            selected_chunks: 3,
            selected_tokens: 6_000,
            truncated: true,
            spoiler_limited: true,
            coverage: "partial_budget_and_reading_protection".into(),
        };
        append_chat_route_instructions(
            &mut content,
            ChatRoute::CurrentSection,
            Some(&metadata),
            None,
            false,
            false,
            SelectionState::Attached,
            false,
        );
        assert!(content.stable.contains("only 4 of 12 indexed chunks"));
        assert!(content.stable.contains("only 3 of 4 visible chunks"));
        assert!(content
            .stable
            .contains("do not describe this as the complete section"));
    }

    #[test]
    fn spoiler_guard_adds_a_no_external_knowledge_constraint() {
        let (content, _) = build_chat_system_content(
            Some("Known novel"),
            None,
            None,
            "en",
            None,
            &[],
            false,
            true,
        );
        assert!(content
            .stable
            .contains("Never reveal, infer, or complete later events"));
    }

    #[test]
    fn protected_overview_uses_only_read_section_label() {
        let overview = grounding::summarize::BookOverview {
            content: String::new(),
            sections: vec![grounding::summarize::SectionOverview {
                section_index: 0,
                section_title: Some("Read chapter".into()),
                content: "Known events only.".into(),
            }],
        };
        let rendered = format_book_overview(&overview);
        assert!(rendered.contains("Read-section summaries"));
        assert!(!rendered.contains("Book overview"));
    }
}

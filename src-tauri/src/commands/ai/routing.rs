//! Chat scope routing: classify what source material a chat request needs
//! (selection, current section, whole book, retrieval) from the user's
//! message, inherited conversation state, and index availability.

use super::{bounded_chat_history_with_limit, ChatMessage};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ChatRoute {
    SelectedContext,
    SelectedContextVocabulary,
    ViewportContext,
    ViewportContextVocabulary,
    CurrentSectionVocabulary,
    CurrentSection,
    CurrentSectionUnavailable,
    WholeBookUnavailable,
    WholeBookVocabularyUnavailable,
    WholeBookVocabulary,
    WholeBook,
    Generic,
}

/// A manual scope chip in the composer. Bypasses keyword classification.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ScopeOverride {
    Selection,
    Section,
    Book,
}

pub(super) fn parse_scope_override(value: &str) -> Option<ScopeOverride> {
    match value {
        "selection" => Some(ScopeOverride::Selection),
        "section" => Some(ScopeOverride::Section),
        "book" => Some(ScopeOverride::Book),
        _ => None,
    }
}

/// Map a manual scope chip to a route. Returns `None` when the override
/// cannot be satisfied (selection chip with neither an attached quote nor
/// viewport text), in which case the caller falls back to automatic routing.
pub(super) fn route_for_override(
    scope: ScopeOverride,
    question: &str,
    current_section_index: Option<i64>,
    has_viewport: bool,
) -> Option<ChatRoute> {
    let instruction = routing_instruction(question);
    let vocabulary = is_vocabulary_request(&instruction);
    match scope {
        ScopeOverride::Selection => {
            if is_selected_context(question) {
                Some(if vocabulary {
                    ChatRoute::SelectedContextVocabulary
                } else {
                    ChatRoute::SelectedContext
                })
            } else if has_viewport {
                Some(if vocabulary {
                    ChatRoute::ViewportContextVocabulary
                } else {
                    ChatRoute::ViewportContext
                })
            } else {
                None
            }
        }
        ScopeOverride::Section => Some(if current_section_index.is_some() {
            if vocabulary {
                ChatRoute::CurrentSectionVocabulary
            } else {
                ChatRoute::CurrentSection
            }
        } else {
            ChatRoute::CurrentSectionUnavailable
        }),
        ScopeOverride::Book => Some(if vocabulary {
            ChatRoute::WholeBookVocabulary
        } else {
            ChatRoute::WholeBook
        }),
    }
}

/// Detect a lookup of one specific word ("这个单词是什么意思", "what does the
/// word X mean"). Such questions mention vocabulary keywords but must not
/// trigger a list-style vocabulary scan of the section or book.
pub(super) fn is_single_word_lookup(lower: &str) -> bool {
    let list_intent = [
        "哪些",
        "列出",
        "都有什么",
        "list",
        "which words",
        "what words",
    ]
    .iter()
    .any(|pattern| lower.contains(pattern));
    if list_intent {
        return false;
    }
    if ["这个单词", "这个词", "那个单词", "那个词", "该词", "此词"]
        .iter()
        .any(|pattern| lower.contains(pattern))
    {
        return true;
    }
    // English singular references: "the word", "this word", "that word" —
    // but "the words"/plural forms keep list semantics.
    ["this word", "that word", "the word"]
        .iter()
        .any(|pattern| {
            let mut search_start = 0;
            while let Some(position) = lower[search_start..].find(pattern) {
                let after = search_start + position + pattern.len();
                if !lower[after..].starts_with('s') {
                    return true;
                }
                search_start = after;
            }
            false
        })
}

pub(super) fn is_vocabulary_request(value: &str) -> bool {
    let lower = value.to_lowercase();
    if is_single_word_lookup(&lower) {
        return false;
    }
    let vocabulary_negated = [
        "不要列难词",
        "不要列出难词",
        "不要讲难词",
        "不用列难词",
        "不需要难词",
        "不要列词汇",
        "don't list difficult words",
        "do not list difficult words",
        "don't list vocabulary",
        "do not list vocabulary",
        "no vocabulary",
    ]
    .iter()
    .any(|pattern| lower.contains(pattern));
    if vocabulary_negated {
        return false;
    }
    [
        "difficult words",
        "difficult english words",
        "hard words",
        "challenging words",
        "new words",
        "unknown words",
        "unfamiliar words",
        "which words",
        "what words",
        "explain the words",
        "vocabulary list",
        "vocabulary",
        "key words",
        "key terms",
        "word meanings",
        "难词",
        "难懂的词",
        "哪些词",
        "哪些单词",
        "陌生词",
        "生词",
        "重点词",
        "重点词汇",
        "词义",
        "词汇",
        "单词",
        "词语",
        "术语",
    ]
    .iter()
    .any(|pattern| lower.contains(pattern))
}

pub(super) fn is_current_section_request(value: &str) -> bool {
    let lower = value.to_lowercase();
    [
        "本章",
        "这章",
        "整章",
        "这一章",
        "当前这一章",
        "当前章节",
        "本节",
        "这一节",
        "当前阅读范围",
        "this chapter",
        "whole chapter",
        "entire chapter",
        "all of this chapter",
        "current chapter",
        "in this chapter",
        "of this chapter",
        "this section",
        "the section",
        "current section",
    ]
    .iter()
    .any(|pattern| lower.contains(pattern))
}

pub(super) fn is_current_passage_request(value: &str) -> bool {
    let lower = value.to_lowercase();
    [
        "本段",
        "这一段",
        "这段",
        "本篇",
        "这一篇",
        "当前段落",
        "当前内容",
        "this paragraph",
        "the paragraph",
        "this passage",
        "the passage",
        "current passage",
        "this part",
        "the current part",
    ]
    .iter()
    .any(|pattern| lower.contains(pattern))
}

/// Broader book references are a scope hint, but deliberately separate from
/// `has_whole_book_intent`: mentioning "this book" should not by itself turn
/// off spoiler protection or override an explicit current-section request.
pub(super) fn is_broad_book_scope_request(value: &str) -> bool {
    let lower = value.to_lowercase();
    [
        "本书",
        "这本书",
        "这部书",
        "书中",
        "书里",
        "this book",
        "the book",
        "in the book",
        "from the book",
        "across the book",
        "throughout the book",
        "book-wide",
        "bookwide",
    ]
    .iter()
    .any(|pattern| lower.contains(pattern))
}

pub(super) fn is_selected_context(value: &str) -> bool {
    value.contains(SELECTED_PASSAGE_OPEN)
}

/// A quote the reader took from the assistant's own earlier answer. It is not
/// book text: it must not select the passage scope, and it is never a source.
pub(super) fn has_quoted_reply(value: &str) -> bool {
    value.contains(QUOTED_REPLY_OPEN)
}

pub(super) const QUOTED_REPLY_OPEN: &str = "[Quoted from your earlier reply]";
const QUOTED_REPLY_CLOSE: &str = "[/Quoted from your earlier reply]";

/// The passage attached to the turn being answered right now. This is the only
/// marker that means "source text for this request".
pub(super) const SELECTED_PASSAGE_OPEN: &str = "[Selected passage]";
pub(super) const SELECTED_PASSAGE_CLOSE: &str = "[/Selected passage]";
/// A passage the reader attached to an *earlier* turn and has since moved on
/// from. It stays in the conversation so references like "this word" still
/// resolve, but it is history, not this turn's evidence.
pub(super) const EARLIER_PASSAGE_OPEN: &str = "[Earlier passage]";
pub(super) const EARLIER_PASSAGE_CLOSE: &str = "[/Earlier passage]";
/// An earlier passage that is still in effect because the reader asked a
/// follow-up without attaching a new selection. It is this turn's source.
pub(super) const CARRIED_PASSAGE_OPEN: &str = "[Carried passage]";
pub(super) const CARRIED_PASSAGE_CLOSE: &str = "[/Carried passage]";

/// Chat history carries selected text and learning-card output inside the
/// user message so the provider receives one coherent turn. Those blocks are
/// evidence, not instructions, and must not influence scope or task routing.
pub(super) fn routing_instruction(value: &str) -> String {
    const BLOCKS: [(&str, &str); 5] = [
        (SELECTED_PASSAGE_OPEN, SELECTED_PASSAGE_CLOSE),
        (EARLIER_PASSAGE_OPEN, EARLIER_PASSAGE_CLOSE),
        (CARRIED_PASSAGE_OPEN, CARRIED_PASSAGE_CLOSE),
        (
            "[Existing learning-card analysis]",
            "[/Existing learning-card analysis]",
        ),
        (QUOTED_REPLY_OPEN, QUOTED_REPLY_CLOSE),
    ];
    let mut result = value.to_string();
    for (open, close) in BLOCKS {
        while let Some(start) = result.find(open) {
            let end = result[start + open.len()..]
                .find(close)
                .map(|offset| start + open.len() + offset + close.len())
                .unwrap_or(result.len());
            result.replace_range(start..end, " ");
        }
    }
    result
}

pub(super) fn classify_chat_route(
    question: &str,
    current_section_index: Option<i64>,
    inherited_route: Option<ChatRoute>,
    has_viewport: bool,
) -> ChatRoute {
    let instruction = routing_instruction(question);
    if has_whole_book_intent(&instruction) {
        return if is_vocabulary_request(&instruction) {
            ChatRoute::WholeBookVocabulary
        } else {
            ChatRoute::WholeBook
        };
    }
    // Explicit scope wins over attached or inherited context. A quote can be
    // present in the composer while the user deliberately asks about the
    // current section instead.
    if is_current_section_request(&instruction) {
        if current_section_index.is_some() {
            if is_vocabulary_request(&instruction) {
                return ChatRoute::CurrentSectionVocabulary;
            }
            return ChatRoute::CurrentSection;
        }
        return ChatRoute::CurrentSectionUnavailable;
    }
    if is_selected_context(question) {
        return if is_vocabulary_request(&instruction) {
            ChatRoute::SelectedContextVocabulary
        } else {
            ChatRoute::SelectedContext
        };
    }
    if is_broad_book_scope_request(&instruction) {
        return if is_vocabulary_request(&instruction) {
            ChatRoute::WholeBookVocabulary
        } else {
            ChatRoute::WholeBook
        };
    }
    if let Some(route) = inherited_route {
        return match (route, current_section_index) {
            (ChatRoute::CurrentSection | ChatRoute::CurrentSectionVocabulary, None) => {
                ChatRoute::CurrentSectionUnavailable
            }
            (ChatRoute::SelectedContext, _) => {
                if is_vocabulary_request(&instruction) {
                    ChatRoute::SelectedContextVocabulary
                } else {
                    ChatRoute::SelectedContext
                }
            }
            (ChatRoute::SelectedContextVocabulary, _) => {
                if is_vocabulary_request(&instruction) {
                    ChatRoute::SelectedContextVocabulary
                } else {
                    ChatRoute::SelectedContext
                }
            }
            (ChatRoute::CurrentSection, Some(_)) => {
                if is_vocabulary_request(&instruction) {
                    ChatRoute::CurrentSectionVocabulary
                } else {
                    ChatRoute::CurrentSection
                }
            }
            (ChatRoute::CurrentSectionVocabulary, Some(_)) => {
                if is_vocabulary_request(&instruction) {
                    ChatRoute::CurrentSectionVocabulary
                } else {
                    ChatRoute::CurrentSection
                }
            }
            (ChatRoute::CurrentSectionUnavailable, Some(_)) => {
                if is_vocabulary_request(&instruction) {
                    ChatRoute::CurrentSectionVocabulary
                } else {
                    ChatRoute::CurrentSection
                }
            }
            // A viewport follow-up re-resolves against what is on screen NOW
            // (the reader may have scrolled); without viewport text there is
            // nothing to point at, so fall back to retrieval.
            (ChatRoute::ViewportContext | ChatRoute::ViewportContextVocabulary, _) => {
                if !has_viewport {
                    ChatRoute::Generic
                } else if is_vocabulary_request(&instruction) {
                    ChatRoute::ViewportContextVocabulary
                } else {
                    ChatRoute::ViewportContext
                }
            }
            _ => route,
        };
    }
    if is_current_passage_request(&instruction) {
        // "Explain this passage" with nothing selected: the visible reading
        // area IS the passage the user means.
        return if !has_viewport {
            ChatRoute::CurrentSectionUnavailable
        } else if is_vocabulary_request(&instruction) {
            ChatRoute::ViewportContextVocabulary
        } else {
            ChatRoute::ViewportContext
        };
    }
    if is_vocabulary_request(&instruction) {
        return if current_section_index.is_some() {
            ChatRoute::CurrentSectionVocabulary
        } else if has_viewport {
            ChatRoute::ViewportContextVocabulary
        } else {
            ChatRoute::CurrentSectionUnavailable
        };
    }
    ChatRoute::Generic
}

/// Decide which scope, if any, a vague follow-up inherits from the previous
/// turn. Section and book scopes are index-backed, so they only survive while
/// the index snapshot still matches (`scope_snapshot_matches`). Selection
/// scopes are exempt from that gate: their evidence is the quoted text inside
/// the message itself, which an index rebuild or an index-less book (e.g. a
/// scanned PDF) does not invalidate.
pub(super) fn resolve_inherited_route(
    previous_route: Option<&str>,
    scope_snapshot_matches: bool,
    messages: &[ChatMessage],
    latest_user_index: Option<usize>,
    current_scope_start_index: Option<i64>,
) -> (Option<ChatRoute>, Option<ChatRoute>) {
    let survives_snapshot_gate = |route: &ChatRoute| {
        scope_snapshot_matches
            || matches!(
                route,
                ChatRoute::SelectedContext
                    | ChatRoute::SelectedContextVocabulary
                    | ChatRoute::ViewportContext
                    | ChatRoute::ViewportContextVocabulary
            )
    };
    let structured_previous_route = previous_route
        .and_then(parse_route_name)
        .filter(survives_snapshot_gate)
        .filter(|route| {
            !matches!(
                route,
                ChatRoute::WholeBook
                    | ChatRoute::WholeBookUnavailable
                    | ChatRoute::WholeBookVocabulary
                    | ChatRoute::WholeBookVocabularyUnavailable
            )
        });
    let inherited_route = structured_previous_route.or_else(|| {
        inherited_route_from_previous_user(messages, latest_user_index, current_scope_start_index)
            .filter(survives_snapshot_gate)
    });
    (structured_previous_route, inherited_route)
}

pub(super) fn inherited_route_from_previous_user(
    messages: &[ChatMessage],
    latest_user_index: Option<usize>,
    current_section_index: Option<i64>,
) -> Option<ChatRoute> {
    let previous = latest_user_index.and_then(|index| {
        messages[..index]
            .iter()
            .rev()
            .find(|message| message.role == "user")
    })?;
    let instruction = routing_instruction(&previous.content);
    if has_whole_book_intent(&instruction) {
        // Whole-book access is never inherited implicitly, especially while
        // reading protection may be active.
        return None;
    }
    if is_current_section_request(&instruction) {
        return Some(if current_section_index.is_none() {
            ChatRoute::CurrentSectionUnavailable
        } else if is_vocabulary_request(&instruction) {
            ChatRoute::CurrentSectionVocabulary
        } else {
            ChatRoute::CurrentSection
        });
    }
    if is_selected_context(&previous.content) {
        return Some(ChatRoute::SelectedContext);
    }
    is_vocabulary_request(&instruction).then_some(if current_section_index.is_some() {
        ChatRoute::CurrentSectionVocabulary
    } else {
        ChatRoute::CurrentSectionUnavailable
    })
}

pub(super) fn route_name(route: ChatRoute) -> &'static str {
    match route {
        ChatRoute::SelectedContext => "selected_context",
        ChatRoute::SelectedContextVocabulary => "selected_context_vocabulary",
        ChatRoute::ViewportContext => "viewport_context",
        ChatRoute::ViewportContextVocabulary => "viewport_context_vocabulary",
        ChatRoute::CurrentSectionVocabulary => "current_section_vocabulary",
        ChatRoute::CurrentSection => "current_section",
        ChatRoute::CurrentSectionUnavailable => "current_section_unavailable",
        ChatRoute::WholeBookUnavailable => "whole_book_unavailable",
        ChatRoute::WholeBookVocabularyUnavailable => "whole_book_vocabulary_unavailable",
        ChatRoute::WholeBookVocabulary => "whole_book_vocabulary",
        ChatRoute::WholeBook => "whole_book",
        ChatRoute::Generic => "generic_retrieval",
    }
}

pub(super) fn parse_route_name(value: &str) -> Option<ChatRoute> {
    match value {
        "selected_context" => Some(ChatRoute::SelectedContext),
        "selected_context_vocabulary" => Some(ChatRoute::SelectedContextVocabulary),
        "viewport_context" => Some(ChatRoute::ViewportContext),
        "viewport_context_vocabulary" => Some(ChatRoute::ViewportContextVocabulary),
        "current_section_vocabulary" => Some(ChatRoute::CurrentSectionVocabulary),
        "current_section" => Some(ChatRoute::CurrentSection),
        "current_section_unavailable" => Some(ChatRoute::CurrentSectionUnavailable),
        "whole_book_unavailable" => Some(ChatRoute::WholeBookUnavailable),
        "whole_book_vocabulary_unavailable" => Some(ChatRoute::WholeBookVocabularyUnavailable),
        "whole_book_vocabulary" => Some(ChatRoute::WholeBookVocabulary),
        "whole_book" => Some(ChatRoute::WholeBook),
        "generic_retrieval" => Some(ChatRoute::Generic),
        _ => None,
    }
}

pub(super) fn has_explicit_scope(value: &str) -> bool {
    let instruction = routing_instruction(value);
    has_whole_book_intent(&instruction)
        || is_current_section_request(&instruction)
        || is_current_passage_request(&instruction)
        || is_broad_book_scope_request(&instruction)
        || is_selected_context(value)
}

pub(super) fn has_whole_book_intent(value: &str) -> bool {
    let lower = value.to_lowercase();
    let compact = lower
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect::<String>();
    let avoids_spoilers = [
        "don't spoil",
        "do not spoil",
        "no spoilers",
        "without spoilers",
        "avoid spoilers",
    ]
    .iter()
    .any(|pattern| lower.contains(pattern))
        || ["不要剧透", "别剧透", "不剧透"]
            .iter()
            .any(|pattern| compact.contains(pattern));
    let ending_request = [
        "what is the ending",
        "explain the ending",
        "tell me the ending",
        "reveal the ending",
        "story ending",
    ]
    .iter()
    .any(|pattern| lower.contains(pattern));
    // Unambiguous whole-book phrasing. These also defeat a local-scope
    // reading ("总结全书前半部分" mentioning a chapter as comparison).
    const EXPLICIT_CHINESE_SCOPE: [&str; 6] = ["全书", "整本书", "整部", "全篇", "整篇", "全文"];
    const EXPLICIT_ENGLISH_SCOPE: [&str; 7] = [
        "whole book",
        "entire book",
        "book as a whole",
        "throughout the book",
        "all chapters",
        "entire text",
        "whole story",
    ];
    // Looser phrases that imply whole-book scope only when no local scope is
    // in play — "full text" alone means the book, but "full text of this
    // chapter" must stay local, so these never defeat a local-scope reading.
    const LOOSE_ENGLISH_SCOPE: [&str; 2] = ["full text", "finale"];
    let explicit_chinese_scope = EXPLICIT_CHINESE_SCOPE
        .iter()
        .any(|pattern| compact.contains(pattern));
    let explicit_english_scope = EXPLICIT_ENGLISH_SCOPE
        .iter()
        .any(|pattern| lower.contains(pattern));
    let local_scope = is_current_section_request(value) || is_current_passage_request(value);
    let local_override = [
        "不要总结全书",
        "不要分析全书",
        "只总结本章",
        "只分析本章",
        "只讲本章",
        "just this chapter",
        "only this chapter",
        "just this section",
        "only this section",
        "summarize this chapter",
        "explain this chapter",
        "full text of this chapter",
        "full text of the chapter",
        "full text of this section",
        "full text of the section",
        "this chapter's full text",
        "this section's full text",
        "this chapter's complete text",
        "this section's complete text",
        "complete text of this chapter",
        "complete text of the chapter",
        "complete text of this section",
        "complete text of the section",
        "本章全文",
        "本章的全文",
        "本章节全文",
        "翻译本章全文",
        "这章全文",
        "这一章全文",
        "当前章节全文",
        "本节全文",
        "这一节全文",
    ]
    .iter()
    .any(|pattern| lower.contains(pattern) || compact.contains(pattern));
    // Local scope must win over loose words such as "ending", "full text",
    // or "全文". Explicit global scope can still win when the user clearly
    // asks for the whole book and mentions a chapter only as a comparison.
    if local_scope && (local_override || !(explicit_chinese_scope || explicit_english_scope)) {
        return false;
    }
    let chinese_ending_scope = ["结局", "大结局", "结尾"]
        .iter()
        .any(|pattern| compact.contains(pattern))
        && !avoids_spoilers;
    explicit_chinese_scope
        || chinese_ending_scope
        || compact
            .find("最后")
            .and_then(|index| compact.get(index + "最后".len()..))
            .is_some_and(|tail| {
                tail.chars()
                    .take(4)
                    .collect::<String>()
                    .contains(['章', '局'])
                    && !avoids_spoilers
            })
        || explicit_english_scope
        || LOOSE_ENGLISH_SCOPE
            .iter()
            .any(|pattern| lower.contains(pattern))
        || (ending_request && !avoids_spoilers)
        || ([
            "spoil it",
            "give me spoilers",
            "tell me spoilers",
            "spoil the book",
        ]
        .iter()
        .any(|pattern| lower.contains(pattern))
            && !avoids_spoilers)
        || lower
            .find("how does ")
            .and_then(|index| lower.get(index + "how does ".len()..))
            .is_some_and(|tail| tail.contains(" end") && !avoids_spoilers)
}

/// Whether a turn before the one being answered attached a passage. A
/// follow-up that attaches nothing can then keep that passage in effect
/// instead of being told to answer from a selection that is not there.
pub(super) fn has_earlier_selection(
    messages: &[ChatMessage],
    latest_user_index: Option<usize>,
) -> bool {
    let end = latest_user_index.unwrap_or(messages.len());
    messages[..end]
        .iter()
        .any(|message| message.role == "user" && is_selected_context(&message.content))
}

/// Label the conversation rather than censor it.
///
/// Earlier turns used to be replaced with placeholders so that a stale passage
/// — or the assistant's own wording — could never be mistaken for this turn's
/// source text. That also deleted everything a follow-up depends on: "this
/// word" no longer resolved to anything, and the assistant could not see what
/// it had just said, which turned every multi-turn exchange into a series of
/// unrelated single turns.
///
/// The request already carries turn structure: one message per turn, with the
/// role saying who spoke. So the only thing worth marking in the text is which
/// passage counts as evidence *now*. Everything else stays verbatim, and
/// `append_chat_route_instructions` states what history may and may not be
/// used for. Returns the labeled window and how many messages the byte budget
/// dropped, so the UI can say so instead of the loss being invisible.
pub(super) fn labeled_chat_history(
    mut messages: Vec<ChatMessage>,
    max_total_bytes: usize,
    carry_selection: bool,
) -> (Vec<ChatMessage>, usize) {
    let latest_user_index = messages.iter().rposition(|message| message.role == "user");
    // Only the newest earlier passage carries; anything older is plain history.
    let carried_index = if carry_selection {
        messages[..latest_user_index.unwrap_or(messages.len())]
            .iter()
            .rposition(|message| message.role == "user" && is_selected_context(&message.content))
    } else {
        None
    };
    // Relabel before the per-message byte cap runs. Otherwise a long passage
    // can lose its closing delimiter and swallow the question after it.
    for (index, message) in messages.iter_mut().enumerate() {
        if message.role != "user" || Some(index) == latest_user_index {
            continue;
        }
        let (open, close) = if Some(index) == carried_index {
            (CARRIED_PASSAGE_OPEN, CARRIED_PASSAGE_CLOSE)
        } else {
            (EARLIER_PASSAGE_OPEN, EARLIER_PASSAGE_CLOSE)
        };
        message.content = message
            .content
            .replace(SELECTED_PASSAGE_CLOSE, close)
            .replace(SELECTED_PASSAGE_OPEN, open);
    }
    bounded_chat_history_with_limit(messages, max_total_bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Most routing tests predate viewport capture; classify with none.
    fn classify_without_viewport(
        question: &str,
        current_section_index: Option<i64>,
        inherited_route: Option<ChatRoute>,
    ) -> ChatRoute {
        classify_chat_route(question, current_section_index, inherited_route, false)
    }

    use super::super::CHAT_MAX_TOTAL_BYTES;

    #[test]
    fn earlier_assistant_replies_survive_verbatim() {
        // The assistant has to be able to see what it just said; "explain your
        // second point" is not answerable from a placeholder.
        let messages = vec![
            ChatMessage {
                role: "user".into(),
                content: "本章有哪些难词？".into(),
            },
            ChatMessage {
                role: "assistant".into(),
                content: "奥斯维辛、希望、仁爱".into(),
            },
            ChatMessage {
                role: "user".into(),
                content: "继续列出难词".into(),
            },
        ];
        let (history, omitted) = labeled_chat_history(messages, CHAT_MAX_TOTAL_BYTES, false);
        assert_eq!(history.len(), 3);
        assert_eq!(omitted, 0);
        assert_eq!(history[1].content, "奥斯维辛、希望、仁爱");
    }

    #[test]
    fn a_superseded_passage_is_relabeled_rather_than_deleted() {
        let messages = vec![
            ChatMessage {
                role: "user".into(),
                content: "[Selected passage]\nold source\n[/Selected passage]\n解释这段".into(),
            },
            ChatMessage {
                role: "assistant".into(),
                content: "old answer".into(),
            },
            ChatMessage {
                role: "user".into(),
                content: "本章有哪些难词？".into(),
            },
        ];
        let (history, _) = labeled_chat_history(messages, CHAT_MAX_TOTAL_BYTES, false);
        assert_eq!(history.len(), 3);
        assert!(history[0].content.contains("解释这段"));
        // Still readable, so a later reference resolves — but no longer
        // wearing the marker that means "source text for this turn".
        assert!(history[0].content.contains("old source"));
        assert!(history[0].content.contains(EARLIER_PASSAGE_OPEN));
        assert!(history[0].content.contains(EARLIER_PASSAGE_CLOSE));
        assert!(!history[0].content.contains(SELECTED_PASSAGE_OPEN));
    }

    #[test]
    fn a_follow_up_without_a_new_selection_carries_the_previous_one() {
        // The `penchant` case: quote a word, ask about it, then ask again with
        // nothing attached. The passage stays in effect for this turn.
        let messages = vec![
            ChatMessage {
                role: "user".into(),
                content: "[Selected passage]\npenchant\n[/Selected passage]\nWhat's the difference between this word and \"preference\"?".into(),
            },
            ChatMessage {
                role: "assistant".into(),
                content: "penchant 更强……".into(),
            },
            ChatMessage {
                role: "user".into(),
                content: "Introduce the difference with more details.".into(),
            },
        ];
        let (history, _) = labeled_chat_history(messages, CHAT_MAX_TOTAL_BYTES, true);
        assert!(history[0].content.contains(CARRIED_PASSAGE_OPEN));
        assert!(history[0].content.contains("penchant"));
        assert!(!history[0].content.contains(EARLIER_PASSAGE_OPEN));
    }

    #[test]
    fn only_the_newest_earlier_passage_carries() {
        let messages = vec![
            ChatMessage {
                role: "user".into(),
                content: "[Selected passage]\nfirst pick\n[/Selected passage]\n这是什么".into(),
            },
            ChatMessage {
                role: "user".into(),
                content: "[Selected passage]\nsecond pick\n[/Selected passage]\n那这个呢".into(),
            },
            ChatMessage {
                role: "user".into(),
                content: "再详细一点".into(),
            },
        ];
        let (history, _) = labeled_chat_history(messages, CHAT_MAX_TOTAL_BYTES, true);
        assert!(history[0].content.contains(EARLIER_PASSAGE_OPEN));
        assert!(history[1].content.contains(CARRIED_PASSAGE_OPEN));
    }

    #[test]
    fn explicit_section_scope_keeps_the_latest_attached_selection() {
        // "How does this quote relate to the chapter?" needs both the quote
        // and the section source; only OLDER turns get relabeled.
        let messages = vec![ChatMessage {
            role: "user".into(),
            content:
                "[Selected passage]\nquoted words\n[/Selected passage]\n这段引文和本章有什么关系？"
                    .into(),
        }];
        let (history, _) = labeled_chat_history(messages, CHAT_MAX_TOTAL_BYTES, false);
        assert_eq!(history.len(), 1);
        assert!(history[0].content.contains("这段引文和本章有什么关系"));
        assert!(history[0].content.contains(SELECTED_PASSAGE_OPEN));
        assert!(history[0].content.contains("quoted words"));
    }

    #[test]
    fn dropping_history_for_the_budget_is_reported_not_silent() {
        let messages = vec![
            ChatMessage {
                role: "user".into(),
                content: "x".repeat(400),
            },
            ChatMessage {
                role: "assistant".into(),
                content: "y".repeat(400),
            },
            ChatMessage {
                role: "user".into(),
                content: "最后一问".into(),
            },
        ];
        let (history, omitted) = labeled_chat_history(messages, 500, false);
        assert_eq!(history.len(), 2);
        assert_eq!(omitted, 1);
    }
    #[test]
    fn whole_book_intent_never_implies_silent_unlock() {
        for value in [
            "总结全书前半部分",
            "结局是什么",
            "How does this story end?",
            "Explain the entire book",
        ] {
            assert!(has_whole_book_intent(value), "{value}");
        }
        for value in [
            "总结这一章",
            "解释这个人物目前的选择",
            "What happened here?",
            "Don't spoil the ending; summarize this chapter",
            "不要剧透结局，只总结本章",
            "Explain the ending of this chapter",
            "本章全文有哪些难词",
            "不要总结全书，只总结本章",
            "full text of this chapter",
            "full text of this section",
        ] {
            assert!(!has_whole_book_intent(value), "{value}");
        }
        for value in ["翻译全文", "总结全文", "translate the full text"] {
            assert!(has_whole_book_intent(value), "{value}");
        }
        assert_eq!(
            route_name(classify_without_viewport(
                "不要列出难词，改为总结本章",
                Some(3),
                None
            )),
            "current_section"
        );
    }
    #[test]
    fn chapter_requests_route_only_when_a_current_section_is_known() {
        assert_eq!(
            route_name(classify_without_viewport("本章有哪些难词？", Some(3), None)),
            "current_section_vocabulary"
        );
        assert_eq!(
            route_name(classify_without_viewport("本章有哪些难词？", None, None)),
            "current_section_unavailable"
        );
        assert_eq!(
            route_name(classify_without_viewport("请总结本章内容", Some(3), None)),
            "current_section"
        );
        assert_eq!(
            route_name(classify_without_viewport(
                "Explain difficult English words in this chapter",
                Some(3),
                None,
            )),
            "current_section_vocabulary"
        );
        assert_eq!(
            route_name(classify_without_viewport("总结全书", Some(3), None)),
            "whole_book"
        );
        assert_eq!(
            route_name(classify_without_viewport("全书有哪些难词？", Some(3), None)),
            "whole_book_vocabulary"
        );
        assert_eq!(
            route_name(classify_without_viewport(
                "这本书有哪些难词？",
                Some(3),
                None
            )),
            "whole_book_vocabulary"
        );
        // An explicit chapter scope is narrower than a generic book mention.
        assert_eq!(
            route_name(classify_without_viewport(
                "这本书的本章有哪些难词？",
                Some(3),
                None
            )),
            "current_section_vocabulary"
        );
        assert_eq!(
            route_name(classify_without_viewport(
                "[Selected passage]\nExplain this\n[/Selected passage]",
                Some(3),
                Some(ChatRoute::SelectedContext)
            )),
            "selected_context"
        );
        assert_eq!(
            route_name(classify_without_viewport(
                "What are the difficult words in this chapter?",
                Some(3),
                None
            )),
            "current_section_vocabulary"
        );
        assert_eq!(
            route_name(classify_without_viewport(
                "[Selected passage]\nQuoted chapter text.\n[/Selected passage]\nWhat are the difficult words in this chapter?",
                Some(3),
                Some(ChatRoute::SelectedContext)
            )),
            "current_section_vocabulary"
        );
        assert_eq!(
            route_name(classify_without_viewport(
                "[Selected passage]\nQuoted prose.\n[/Selected passage]\nWhat are the difficult words here?",
                Some(3),
                None,
            )),
            "selected_context_vocabulary"
        );
        assert_eq!(
            route_name(classify_without_viewport(
                "[Selected passage]\nThe book's ending.\n[/Selected passage]\nWhat does this passage in the book mean?",
                Some(3),
                None,
            )),
            "selected_context"
        );
        assert_eq!(
            route_name(classify_without_viewport("请解释这段", Some(3), None)),
            "current_section_unavailable"
        );
        // An inherited selected passage is used only for a vague follow-up.
        assert_eq!(
            route_name(classify_without_viewport(
                "请总结本章内容",
                Some(3),
                Some(ChatRoute::SelectedContext),
            )),
            "current_section"
        );
        assert_eq!(
            route_name(classify_without_viewport(
                "这是什么意思？",
                Some(3),
                Some(ChatRoute::SelectedContext),
            )),
            "selected_context"
        );
        // An explicit whole-book request remains the highest-priority scope.
        assert_eq!(
            route_name(classify_without_viewport(
                "[Selected passage]\nQuoted ending text.\n[/Selected passage]\n请总结全书",
                Some(3),
                Some(ChatRoute::SelectedContext)
            )),
            "whole_book"
        );
        assert_eq!(
            route_name(classify_without_viewport(
                "What is the ending of the whole book?",
                Some(3),
                None
            )),
            "whole_book"
        );
        assert_eq!(
            route_name(classify_without_viewport(
                "继续解释",
                Some(3),
                Some(ChatRoute::CurrentSection),
            )),
            "current_section"
        );
        assert_eq!(
            route_name(classify_without_viewport(
                "继续列出难词",
                Some(3),
                Some(ChatRoute::CurrentSectionVocabulary),
            )),
            "current_section_vocabulary"
        );
        assert_eq!(
            route_name(classify_without_viewport(
                "继续列出难词",
                Some(3),
                Some(ChatRoute::CurrentSection),
            )),
            "current_section_vocabulary"
        );
        assert_eq!(
            route_name(classify_without_viewport(
                "继续解释这段",
                Some(3),
                Some(ChatRoute::CurrentSectionVocabulary),
            )),
            "current_section"
        );
    }
    #[test]
    fn single_word_lookups_do_not_trigger_vocabulary_scans() {
        // One specific word: answer the question, don't scan the section.
        assert_eq!(
            route_name(classify_without_viewport(
                "resilience 这个单词是什么意思？",
                Some(3),
                None
            )),
            "generic_retrieval"
        );
        assert_eq!(
            route_name(classify_without_viewport(
                "这个词在这里怎么理解？",
                Some(3),
                None
            )),
            "generic_retrieval"
        );
        assert_eq!(
            route_name(classify_without_viewport(
                "What does the word 'serfdom' mean here?",
                Some(3),
                None
            )),
            "generic_retrieval"
        );
        // A selected passage keeps its scope for a single-word lookup.
        assert_eq!(
            route_name(classify_without_viewport(
                "[Selected passage]\nQuoted prose.\n[/Selected passage]\nWhat does this word mean?",
                Some(3),
                None
            )),
            "selected_context"
        );
        // Plural/list phrasing still routes to a vocabulary scan.
        assert_eq!(
            route_name(classify_without_viewport(
                "Which words in this chapter are difficult?",
                Some(3),
                None
            )),
            "current_section_vocabulary"
        );
        assert_eq!(
            route_name(classify_without_viewport(
                "把这个单词和本章其他难词都列出来",
                Some(3),
                None
            )),
            "current_section_vocabulary"
        );
    }
    #[test]
    fn selection_scope_inheritance_survives_an_index_snapshot_mismatch() {
        let messages = vec![
            ChatMessage {
                role: "user".into(),
                content: "[Selected passage]\nquoted prose\n[/Selected passage]\n解释这段".into(),
            },
            ChatMessage {
                role: "assistant".into(),
                content: "一段解释".into(),
            },
            ChatMessage {
                role: "user".into(),
                content: "再展开说说".into(),
            },
        ];
        // Structured previous route: selection scope is exempt from the gate.
        let (structured, inherited) =
            resolve_inherited_route(Some("selected_context"), false, &messages, Some(2), Some(3));
        assert_eq!(structured, Some(ChatRoute::SelectedContext));
        assert_eq!(inherited, Some(ChatRoute::SelectedContext));
        // Message-text fallback finds the quoted selection without the index.
        let (structured, inherited) =
            resolve_inherited_route(None, false, &messages, Some(2), None);
        assert_eq!(structured, None);
        assert_eq!(inherited, Some(ChatRoute::SelectedContext));
    }
    #[test]
    fn index_backed_scope_inheritance_still_requires_a_matching_snapshot() {
        let messages = vec![
            ChatMessage {
                role: "user".into(),
                content: "总结一下本章".into(),
            },
            ChatMessage {
                role: "assistant".into(),
                content: "本章讲了……".into(),
            },
            ChatMessage {
                role: "user".into(),
                content: "再展开说说".into(),
            },
        ];
        let (structured, inherited) =
            resolve_inherited_route(Some("current_section"), false, &messages, Some(2), Some(3));
        assert_eq!(structured, None);
        assert_eq!(inherited, None);
        let (structured, inherited) =
            resolve_inherited_route(Some("current_section"), true, &messages, Some(2), Some(3));
        assert_eq!(structured, Some(ChatRoute::CurrentSection));
        assert_eq!(inherited, Some(ChatRoute::CurrentSection));
        // Whole-book scope is never inherited implicitly, even when it matches.
        let (structured, _) =
            resolve_inherited_route(Some("whole_book"), true, &messages, Some(2), Some(3));
        assert_eq!(structured, None);
    }
    #[test]
    fn routing_ignores_embedded_evidence_when_classifying_intent() {
        let selected = "[Selected passage]\nThis chapter discusses the whole book's ending.\n[/Selected passage]\n请解释这段";
        assert_eq!(
            route_name(classify_without_viewport(selected, Some(3), None)),
            "selected_context"
        );
        assert!(!has_whole_book_intent(&routing_instruction(selected)));

        let analysis = "[Existing learning-card analysis]\nSummarize this chapter.\n[/Existing learning-card analysis]\n这是什么意思？";
        assert_eq!(
            route_name(classify_without_viewport(analysis, Some(3), None)),
            "generic_retrieval"
        );

        let unclosed = "[Selected passage]\nThe ending of the whole book appears here.\n请解释这段";
        assert_eq!(
            route_name(classify_without_viewport(unclosed, Some(3), None)),
            "selected_context"
        );
        assert_eq!(routing_instruction(unclosed).trim(), "");
    }
    #[test]
    fn inherited_scope_uses_only_the_immediately_previous_user_turn() {
        let messages = vec![
            ChatMessage {
                role: "user".into(),
                content: "[Selected passage]\nExplain this".into(),
            },
            ChatMessage {
                role: "assistant".into(),
                content: "answer".into(),
            },
            ChatMessage {
                role: "user".into(),
                content: "请总结本章".into(),
            },
            ChatMessage {
                role: "assistant".into(),
                content: "chapter answer".into(),
            },
            ChatMessage {
                role: "user".into(),
                content: "继续".into(),
            },
        ];
        let latest = messages.len() - 1;
        assert_eq!(
            inherited_route_from_previous_user(&messages, Some(latest), Some(2)),
            Some(ChatRoute::CurrentSection)
        );
    }

    #[test]
    fn passage_requests_use_the_viewport_when_nothing_is_selected() {
        assert_eq!(
            classify_chat_route("请解释这段", Some(3), None, true),
            ChatRoute::ViewportContext
        );
        assert_eq!(
            classify_chat_route("Explain this passage", Some(3), None, true),
            ChatRoute::ViewportContext
        );
        // Without viewport text the route stays ungrounded.
        assert_eq!(
            classify_chat_route("请解释这段", Some(3), None, false),
            ChatRoute::CurrentSectionUnavailable
        );
        // An attached selection still wins over the viewport.
        assert_eq!(
            classify_chat_route(
                "[Selected passage]\nquoted\n[/Selected passage]\n请解释这段",
                Some(3),
                None,
                true
            ),
            ChatRoute::SelectedContext
        );
        // Vocabulary without a section index falls back to the viewport too.
        assert_eq!(
            classify_chat_route("有哪些难词？", None, None, true),
            ChatRoute::ViewportContextVocabulary
        );
        // An explicit section request is about the section, not the screen.
        assert_eq!(
            classify_chat_route("总结一下本章", Some(3), None, true),
            ChatRoute::CurrentSection
        );
    }

    #[test]
    fn viewport_follow_ups_re_resolve_against_the_current_viewport() {
        let inherited = Some(ChatRoute::ViewportContext);
        assert_eq!(
            classify_chat_route("再展开说说", Some(3), inherited, true),
            ChatRoute::ViewportContext
        );
        assert_eq!(
            classify_chat_route("这里面有哪些难词？", Some(3), inherited, true),
            ChatRoute::ViewportContextVocabulary
        );
        // The reader closed or the viewport is empty: nothing to point at.
        assert_eq!(
            classify_chat_route("再展开说说", Some(3), inherited, false),
            ChatRoute::Generic
        );
    }

    #[test]
    fn viewport_scope_inheritance_survives_an_index_snapshot_mismatch() {
        let messages = vec![
            ChatMessage {
                role: "user".into(),
                content: "解释这段".into(),
            },
            ChatMessage {
                role: "assistant".into(),
                content: "an answer".into(),
            },
            ChatMessage {
                role: "user".into(),
                content: "再展开说说".into(),
            },
        ];
        let (structured, inherited) =
            resolve_inherited_route(Some("viewport_context"), false, &messages, Some(2), Some(3));
        assert_eq!(structured, Some(ChatRoute::ViewportContext));
        assert_eq!(inherited, Some(ChatRoute::ViewportContext));
    }

    #[test]
    fn manual_scope_overrides_map_to_routes() {
        // Selection chip: attached quote wins, viewport is the fallback, and
        // with neither the override abstains so Auto takes over.
        assert_eq!(
            route_for_override(
                ScopeOverride::Selection,
                "[Selected passage]\nquoted\n[/Selected passage]\n什么意思？",
                Some(3),
                true
            ),
            Some(ChatRoute::SelectedContext)
        );
        assert_eq!(
            route_for_override(ScopeOverride::Selection, "什么意思？", Some(3), true),
            Some(ChatRoute::ViewportContext)
        );
        assert_eq!(
            route_for_override(ScopeOverride::Selection, "什么意思？", Some(3), false),
            None
        );
        // Section chip follows section availability.
        assert_eq!(
            route_for_override(ScopeOverride::Section, "总结一下", Some(3), false),
            Some(ChatRoute::CurrentSection)
        );
        assert_eq!(
            route_for_override(ScopeOverride::Section, "有哪些难词？", Some(3), false),
            Some(ChatRoute::CurrentSectionVocabulary)
        );
        assert_eq!(
            route_for_override(ScopeOverride::Section, "总结一下", None, true),
            Some(ChatRoute::CurrentSectionUnavailable)
        );
        // Book chip is unconditional.
        assert_eq!(
            route_for_override(ScopeOverride::Book, "讲了什么？", None, false),
            Some(ChatRoute::WholeBook)
        );
        assert_eq!(
            route_for_override(ScopeOverride::Book, "有哪些难词？", None, false),
            Some(ChatRoute::WholeBookVocabulary)
        );
    }

    #[test]
    fn moving_to_a_viewport_question_demotes_the_old_quote_without_erasing_it() {
        // Asking about what is on screen means the old selection is no longer
        // the source — but "解释这段" upthread still has to make sense.
        let messages = vec![
            ChatMessage {
                role: "user".into(),
                content: "[Selected passage]\nold quote\n[/Selected passage]\n解释这段".into(),
            },
            ChatMessage {
                role: "assistant".into(),
                content: "old answer".into(),
            },
            ChatMessage {
                role: "user".into(),
                content: "屏幕上这段怎么理解？".into(),
            },
        ];
        let (history, omitted) = labeled_chat_history(messages, 32_000, false);
        assert_eq!(history.len(), 3);
        assert_eq!(omitted, 0);
        assert!(history[0].content.contains(EARLIER_PASSAGE_OPEN));
        assert!(history[0].content.contains("old quote"));
        assert_eq!(history[1].content, "old answer");
    }

    #[test]
    fn quoting_a_reply_is_not_a_selected_passage() {
        let question = "为什么这么说？\n\n[Quoted from your earlier reply]\n生活所能提供的\n[/Quoted from your earlier reply]";
        // The failure this guards is silent: matching here would route to the
        // passage scope, whose prompt calls the quote the book's source text.
        assert!(!is_selected_context(question));
        assert!(has_quoted_reply(question));
        // Routing keywords must come from the reader's own words, not the quote.
        let instruction = routing_instruction(question);
        assert!(!instruction.contains("生活所能提供的"));
        assert!(instruction.contains("为什么这么说"));
    }

    #[test]
    fn a_quoted_passage_still_selects_the_passage_scope() {
        let question = "这句什么意思？\n\n[Selected passage]\nfinding joy\n[/Selected passage]";
        assert!(is_selected_context(question));
        assert!(!has_quoted_reply(question));
    }

    #[test]
    fn one_turn_can_stack_several_quotes_of_mixed_kinds() {
        let question = "这两处怎么对应？\n\n[Quoted from your earlier reply]\n我先前说的\n[/Quoted from your earlier reply]\n\n[Selected passage]\nfirst pick\n[/Selected passage]\n\n[Selected passage]\nsecond pick\n[/Selected passage]";
        // Both markers are true at once: the turn really does carry book text
        // and the assistant's own words, and each keeps its own meaning.
        assert!(has_quoted_reply(question));
        assert!(is_selected_context(question));
        let instruction = routing_instruction(question);
        for quoted in ["我先前说的", "first pick", "second pick"] {
            assert!(!instruction.contains(quoted), "leaked {quoted}");
        }
        assert!(instruction.contains("这两处怎么对应"));
    }
}

//! Chat scope routing: classify what source material a chat request needs
//! (selection, current section, whole book, retrieval) from the user's
//! message, inherited conversation state, and index availability.

use super::{bounded_chat_history_with_limit, ChatMessage};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ChatRoute {
    SelectedContext,
    SelectedContextVocabulary,
    CurrentSectionVocabulary,
    CurrentSection,
    CurrentSectionUnavailable,
    WholeBookUnavailable,
    WholeBookVocabularyUnavailable,
    WholeBookVocabulary,
    WholeBook,
    Generic,
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
    value.contains("[Selected passage]")
}

/// Chat history carries selected text and learning-card output inside the
/// user message so the provider receives one coherent turn. Those blocks are
/// evidence, not instructions, and must not influence scope or task routing.
pub(super) fn routing_instruction(value: &str) -> String {
    const BLOCKS: [(&str, &str); 2] = [
        ("[Selected passage]", "[/Selected passage]"),
        (
            "[Existing learning-card analysis]",
            "[/Existing learning-card analysis]",
        ),
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
            _ => route,
        };
    }
    if is_current_passage_request(&instruction) {
        return ChatRoute::CurrentSectionUnavailable;
    }
    if is_vocabulary_request(&instruction) {
        return if current_section_index.is_some() {
            ChatRoute::CurrentSectionVocabulary
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
                ChatRoute::SelectedContext | ChatRoute::SelectedContextVocabulary
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

pub(super) fn bounded_scoped_chat_history(
    mut messages: Vec<ChatMessage>,
    max_total_bytes: usize,
    route: ChatRoute,
) -> Vec<ChatMessage> {
    let scoped = matches!(
        route,
        ChatRoute::SelectedContext
            | ChatRoute::SelectedContextVocabulary
            | ChatRoute::CurrentSection
            | ChatRoute::CurrentSectionVocabulary
            | ChatRoute::CurrentSectionUnavailable
            | ChatRoute::WholeBook
            | ChatRoute::WholeBookUnavailable
            | ChatRoute::WholeBookVocabulary
            | ChatRoute::WholeBookVocabularyUnavailable
    );
    if scoped {
        // Sanitize before applying the per-message byte cap. Otherwise a long
        // selected passage can lose its closing delimiter and make the
        // trailing user question disappear from the routed request.
        let latest_user_index = messages.iter().rposition(|message| message.role == "user");
        // Previous assistant text is conversational context, never source
        // evidence. Replacing it rather than deleting it preserves the
        // user/assistant alternation expected by strict providers and prevents
        // an old unsupported answer from becoming the vocabulary source.
        for (index, message) in messages.iter_mut().enumerate() {
            if message.role == "assistant" {
                message.content =
                    "[Prior assistant response omitted; use only the supplied source text.]"
                        .to_string();
            } else if message.role == "user" && Some(index) != latest_user_index {
                // A previous user turn can contain a quoted selection or a
                // learning-card answer. It belongs to conversation history,
                // not to the new scope's evidence bundle. The latest user
                // turn keeps its evidence even under an explicit chapter or
                // book scope: a question like "how does this quote relate to
                // the chapter" needs both the quote and the scope source.
                let instruction = routing_instruction(&message.content);
                if instruction.trim() != message.content.trim() {
                    message.content = format!(
                        "[Prior source evidence omitted; use only the current scope source.]\n{}",
                        instruction.trim()
                    );
                }
            }
        }
    }
    bounded_chat_history_with_limit(messages, max_total_bytes)
}

#[cfg(test)]
mod tests {
    use super::super::SCOPED_CHAT_MAX_TOTAL_BYTES;
    use super::*;

    #[test]
    fn scoped_history_does_not_reuse_old_assistant_evidence() {
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
        let bounded = bounded_scoped_chat_history(
            messages,
            SCOPED_CHAT_MAX_TOTAL_BYTES,
            ChatRoute::CurrentSectionVocabulary,
        );
        assert_eq!(bounded.len(), 3);
        assert!(bounded[1].content.contains("omitted"));
        assert!(!bounded[1].content.contains("奥斯维辛"));
    }
    #[test]
    fn scoped_history_redacts_previous_user_evidence_but_keeps_their_question() {
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
        let bounded = bounded_scoped_chat_history(
            messages,
            SCOPED_CHAT_MAX_TOTAL_BYTES,
            ChatRoute::CurrentSectionVocabulary,
        );
        assert_eq!(bounded.len(), 3);
        assert!(bounded[0].content.contains("解释这段"));
        assert!(!bounded[0].content.contains("old source"));
        assert!(bounded[0].content.contains("Prior source evidence omitted"));
    }
    #[test]
    fn explicit_section_scope_keeps_the_latest_attached_selection() {
        // "How does this quote relate to the chapter?" needs both the quote
        // and the section source; only OLDER turns lose their evidence.
        let messages = vec![ChatMessage {
            role: "user".into(),
            content:
                "[Selected passage]\nquoted words\n[/Selected passage]\n这段引文和本章有什么关系？"
                    .into(),
        }];
        let bounded = bounded_scoped_chat_history(
            messages,
            SCOPED_CHAT_MAX_TOTAL_BYTES,
            ChatRoute::CurrentSection,
        );
        assert_eq!(bounded.len(), 1);
        assert!(bounded[0].content.contains("这段引文和本章有什么关系"));
        assert!(bounded[0].content.contains("quoted words"));
        assert!(!bounded[0].content.contains("Prior source evidence omitted"));
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
            route_name(classify_chat_route(
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
            route_name(classify_chat_route("本章有哪些难词？", Some(3), None)),
            "current_section_vocabulary"
        );
        assert_eq!(
            route_name(classify_chat_route("本章有哪些难词？", None, None)),
            "current_section_unavailable"
        );
        assert_eq!(
            route_name(classify_chat_route("请总结本章内容", Some(3), None)),
            "current_section"
        );
        assert_eq!(
            route_name(classify_chat_route(
                "Explain difficult English words in this chapter",
                Some(3),
                None,
            )),
            "current_section_vocabulary"
        );
        assert_eq!(
            route_name(classify_chat_route("总结全书", Some(3), None)),
            "whole_book"
        );
        assert_eq!(
            route_name(classify_chat_route("全书有哪些难词？", Some(3), None)),
            "whole_book_vocabulary"
        );
        assert_eq!(
            route_name(classify_chat_route("这本书有哪些难词？", Some(3), None)),
            "whole_book_vocabulary"
        );
        // An explicit chapter scope is narrower than a generic book mention.
        assert_eq!(
            route_name(classify_chat_route(
                "这本书的本章有哪些难词？",
                Some(3),
                None
            )),
            "current_section_vocabulary"
        );
        assert_eq!(
            route_name(classify_chat_route(
                "[Selected passage]\nExplain this\n[/Selected passage]",
                Some(3),
                Some(ChatRoute::SelectedContext)
            )),
            "selected_context"
        );
        assert_eq!(
            route_name(classify_chat_route(
                "What are the difficult words in this chapter?",
                Some(3),
                None
            )),
            "current_section_vocabulary"
        );
        assert_eq!(
            route_name(classify_chat_route(
                "[Selected passage]\nQuoted chapter text.\n[/Selected passage]\nWhat are the difficult words in this chapter?",
                Some(3),
                Some(ChatRoute::SelectedContext)
            )),
            "current_section_vocabulary"
        );
        assert_eq!(
            route_name(classify_chat_route(
                "[Selected passage]\nQuoted prose.\n[/Selected passage]\nWhat are the difficult words here?",
                Some(3),
                None,
            )),
            "selected_context_vocabulary"
        );
        assert_eq!(
            route_name(classify_chat_route(
                "[Selected passage]\nThe book's ending.\n[/Selected passage]\nWhat does this passage in the book mean?",
                Some(3),
                None,
            )),
            "selected_context"
        );
        assert_eq!(
            route_name(classify_chat_route("请解释这段", Some(3), None)),
            "current_section_unavailable"
        );
        // An inherited selected passage is used only for a vague follow-up.
        assert_eq!(
            route_name(classify_chat_route(
                "请总结本章内容",
                Some(3),
                Some(ChatRoute::SelectedContext),
            )),
            "current_section"
        );
        assert_eq!(
            route_name(classify_chat_route(
                "这是什么意思？",
                Some(3),
                Some(ChatRoute::SelectedContext),
            )),
            "selected_context"
        );
        // An explicit whole-book request remains the highest-priority scope.
        assert_eq!(
            route_name(classify_chat_route(
                "[Selected passage]\nQuoted ending text.\n[/Selected passage]\n请总结全书",
                Some(3),
                Some(ChatRoute::SelectedContext)
            )),
            "whole_book"
        );
        assert_eq!(
            route_name(classify_chat_route(
                "What is the ending of the whole book?",
                Some(3),
                None
            )),
            "whole_book"
        );
        assert_eq!(
            route_name(classify_chat_route(
                "继续解释",
                Some(3),
                Some(ChatRoute::CurrentSection),
            )),
            "current_section"
        );
        assert_eq!(
            route_name(classify_chat_route(
                "继续列出难词",
                Some(3),
                Some(ChatRoute::CurrentSectionVocabulary),
            )),
            "current_section_vocabulary"
        );
        assert_eq!(
            route_name(classify_chat_route(
                "继续列出难词",
                Some(3),
                Some(ChatRoute::CurrentSection),
            )),
            "current_section_vocabulary"
        );
        assert_eq!(
            route_name(classify_chat_route(
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
            route_name(classify_chat_route(
                "resilience 这个单词是什么意思？",
                Some(3),
                None
            )),
            "generic_retrieval"
        );
        assert_eq!(
            route_name(classify_chat_route("这个词在这里怎么理解？", Some(3), None)),
            "generic_retrieval"
        );
        assert_eq!(
            route_name(classify_chat_route(
                "What does the word 'serfdom' mean here?",
                Some(3),
                None
            )),
            "generic_retrieval"
        );
        // A selected passage keeps its scope for a single-word lookup.
        assert_eq!(
            route_name(classify_chat_route(
                "[Selected passage]\nQuoted prose.\n[/Selected passage]\nWhat does this word mean?",
                Some(3),
                None
            )),
            "selected_context"
        );
        // Plural/list phrasing still routes to a vocabulary scan.
        assert_eq!(
            route_name(classify_chat_route(
                "Which words in this chapter are difficult?",
                Some(3),
                None
            )),
            "current_section_vocabulary"
        );
        assert_eq!(
            route_name(classify_chat_route(
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
            route_name(classify_chat_route(selected, Some(3), None)),
            "selected_context"
        );
        assert!(!has_whole_book_intent(&routing_instruction(selected)));

        let analysis = "[Existing learning-card analysis]\nSummarize this chapter.\n[/Existing learning-card analysis]\n这是什么意思？";
        assert_eq!(
            route_name(classify_chat_route(analysis, Some(3), None)),
            "generic_retrieval"
        );

        let unclosed = "[Selected passage]\nThe ending of the whole book appears here.\n请解释这段";
        assert_eq!(
            route_name(classify_chat_route(unclosed, Some(3), None)),
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
}

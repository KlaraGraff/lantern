//! `ai_explain` — the passage-level explanation command and its prompt.

use tauri::{AppHandle, State};

use super::prompt::{book_reference_block, explanation_strategy, normalized_explanation_mode};
use super::stream::{ensure_stream_credentials_ready, spawn_routed_stream};
use super::ChatMessage;
use crate::db::Db;
use crate::error::AppResult;
use crate::secrets::Secrets;

/// Build the system prompt for sentence/passage explanation.
///
/// Brevity is enforced by the prompt itself (2–3 sentences, no preamble) —
/// deliberately no `max_tokens` cap, which would truncate mid-sentence.
/// Unlike `ai_lookup`, there is no translation-gloss branch: that is a
/// word-level concept and makes no sense for a whole passage. The only
/// language handling comes from the shared explanation mode and CEFR level.
fn explain_system_prompt(explanation_mode: &str, cefr: &str) -> String {
    format!(
        "{}\n\nYou are a reading assistant embedded in an ebook reader. The user selected a sentence or passage and wants to understand it in context.\n\nIn 2–3 sentences, explain what it means and why it matters here — clarify any difficult phrasing, allusion, or tone. Be direct and concise. Do not restate the passage, add headers or labels, or pad with preamble. Plain prose only.",
        explanation_strategy(explanation_mode, cefr),
    )
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn ai_explain(
    passage: String,
    surrounding: Option<String>,
    book_title: Option<String>,
    book_author: Option<String>,
    chapter: Option<String>,
    request_id: String,
    // `true` only when the user asked again after a failure, so the router may
    // look past a cooldown it recorded itself.
    retry: Option<bool>,
    app: AppHandle,
    db: State<'_, Db>,
    secrets: State<'_, Secrets>,
) -> AppResult<()> {
    let (explanation_mode, cefr) = {
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
            normalized_explanation_mode(get("explanation_mode").as_deref()).to_string(),
            get("cefr_level").unwrap_or_else(|| "B1".to_string()),
        )
    };

    let mut user_content = format!("Passage: \"{}\"", passage);
    if let Some(ref ctx) = surrounding {
        if !ctx.is_empty() && ctx != &passage {
            user_content.push_str(&format!("\nSurrounding text: \"{}\"", ctx));
        }
    }
    let mut system_prompt = explain_system_prompt(&explanation_mode, &cefr);
    if let Some(reference) = book_reference_block(
        book_title.as_deref(),
        book_author.as_deref(),
        chapter.as_deref(),
    ) {
        system_prompt.push_str("\n\n");
        system_prompt.push_str(&reference);
    }

    let messages = vec![
        ChatMessage {
            role: "system".to_string(),
            content: system_prompt,
        },
        ChatMessage {
            role: "user".to_string(),
            content: user_content,
        },
    ];

    let event_name = format!("ai-lookup-chunk-{}", request_id);

    ensure_stream_credentials_ready(&db, &secrets)?;
    spawn_routed_stream(
        app,
        db.inner().clone(),
        secrets.inner().clone(),
        messages,
        event_name,
        None,
        crate::ai::router::AiRequestPurpose::Utility,
        crate::ai::router::retry_mode(retry),
        request_id,
        "user",
        "explain",
    );

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explain_prompt_asks_for_brevity_and_no_headers() {
        let p = explain_system_prompt("english_by_level", "B1");
        assert!(p.contains("2–3 sentences"), "must request a short answer");
        assert!(
            p.contains("headers or labels"),
            "must forbid headers/labels"
        );
        assert!(p.contains("in context"), "must be context-aware");
    }

    #[test]
    fn explain_prompt_english_emits_english_directive() {
        let p = explain_system_prompt("english_by_level", "A2");
        assert!(p.contains("Write explanations in English at CEFR A2."));
    }

    #[test]
    fn chinese_mode_explains_in_chinese() {
        let prompt = explain_system_prompt("chinese", "B2");
        assert!(prompt.starts_with("Write explanations in clear Chinese (Simplified)."));
    }

    #[test]
    fn explain_prompt_never_has_translation_gloss() {
        // The word-level "brief translation of the word/phrase" preamble from
        // ai_lookup must not leak into the passage-level explain prompt.
        for mode in ["english_by_level", "chinese", "adaptive_bilingual"] {
            let p = explain_system_prompt(mode, "B1");
            assert!(
                !p.to_lowercase().contains("translation of the"),
                "explain must not carry ai_lookup's word-gloss logic (mode={mode})"
            );
        }
    }
}

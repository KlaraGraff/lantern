//! `ai_word_forms` — inflectional forms of a word, used to match vocabulary
//! entries against the text the reader is looking at.

use std::collections::{BTreeMap, BTreeSet};

use tauri::{AppHandle, State};

use super::prompt::strip_single_json_fence;
use super::stream::ensure_stream_credentials_ready;
use super::ChatMessage;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::secrets::Secrets;

#[tauri::command]
pub async fn ai_word_forms(
    words: Vec<String>,
    request_id: String,
    app: AppHandle,
    db: State<'_, Db>,
    secrets: State<'_, Secrets>,
) -> AppResult<BTreeMap<String, Vec<String>>> {
    if words.is_empty()
        || words.len() > 10
        || request_id.len() > 128
        || request_id.trim().is_empty()
    {
        return Err(AppError::Other("WORD_FORMS_REQUEST_INVALID".to_string()));
    }
    let mut normalized = words
        .into_iter()
        .map(|word| crate::sync::events::normalize_learning_term(&word))
        .filter(|word| !word.is_empty() && word.chars().count() <= 256)
        .collect::<Vec<_>>();
    normalized.sort();
    normalized.dedup();
    if normalized.is_empty() || normalized.len() > 10 {
        return Err(AppError::Other("WORD_FORMS_REQUEST_INVALID".to_string()));
    }
    let messages = vec![
        ChatMessage {
            role: "system".to_string(),
            content: "For each supplied English word, list only inflectional forms of the same lexeme: plurals, verb tenses, participles, and comparative/superlative forms where applicable. Never include derivational relatives (for example nation -> national is forbidden), synonyms, phrases, or the input word itself. Return exactly one JSON object mapping each exact lowercase input word to an array of lowercase strings. Include every input key; use an empty array when there are no other forms. No Markdown or commentary.".to_string(),
        },
        ChatMessage {
            role: "user".to_string(),
            content: serde_json::to_string(&normalized).map_err(|error| AppError::Other(error.to_string()))?,
        },
    ];
    ensure_stream_credentials_ready(&db, &secrets)?;
    let completion = crate::ai::router::complete_with_failover(
        &app,
        &db,
        &secrets,
        &messages,
        Some(1_024),
        crate::ai::router::AiRequestPurpose::Utility,
        crate::ai::router::AiRetryMode::Automatic,
        Some(&request_id),
        None,
        "user",
        "word_forms",
    )
    .await?;
    let parsed: BTreeMap<String, Vec<String>> =
        serde_json::from_str(strip_single_json_fence(&completion.text))
            .map_err(|_| AppError::Ai("WORD_FORMS_PROTOCOL_INVALID".to_string()))?;
    let expected: BTreeSet<_> = normalized.iter().cloned().collect();
    if parsed.keys().any(|key| !expected.contains(key)) || parsed.len() != expected.len() {
        return Err(AppError::Ai("WORD_FORMS_PROTOCOL_INVALID".to_string()));
    }
    Ok(parsed
        .into_iter()
        .map(|(word, forms)| {
            let mut values = forms
                .into_iter()
                .map(|form| crate::sync::events::normalize_learning_term(&form))
                .filter(|form| !form.is_empty() && form != &word)
                .collect::<Vec<_>>();
            values.sort();
            values.dedup();
            (word, values)
        })
        .collect())
}

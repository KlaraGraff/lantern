//! Standard dictionary glosses from Youdao's `suggest` endpoint.
//!
//! Unlike the AI gloss, this cannot see the sentence a word was saved from, so
//! it returns every sense at once: `bank` comes back as
//! `n. 银行；储蓄罐；库存，库；河岸；…`. That makes it a good *reference* to show
//! beside the contextual meaning, and a poor replacement for it — the words a
//! learner saves are exactly the polysemous ones. It is used for the expanded
//! entry's reference row, and as a fallback gloss when no AI is configured.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Deserialize;

use crate::error::{AppError, AppResult};

const SUGGEST_ENDPOINT: &str = "https://dict.youdao.com/suggest";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_QUERY_CHARS: usize = 64;
/// Glosses are a few dozen bytes each; this is a session-lifetime convenience,
/// not a store worth spilling to disk.
const MAX_CACHE_ENTRIES: usize = 2_000;

const ERR_NOT_FOUND: &str = "DICTIONARY_NOT_FOUND";
const ERR_UNAVAILABLE: &str = "DICTIONARY_UNAVAILABLE";
const ERR_QUERY_INVALID: &str = "DICTIONARY_QUERY_INVALID";

#[derive(Deserialize)]
struct SuggestResponse {
    result: SuggestResult,
    #[serde(default)]
    data: Option<SuggestData>,
}

#[derive(Deserialize)]
struct SuggestResult {
    code: i64,
}

#[derive(Deserialize)]
struct SuggestData {
    #[serde(default)]
    entries: Vec<SuggestEntry>,
}

#[derive(Deserialize)]
struct SuggestEntry {
    #[serde(default)]
    explain: String,
}

fn cache() -> &'static Mutex<HashMap<String, String>> {
    static CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn normalize_query(word: &str) -> AppResult<String> {
    let normalized = word.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() || normalized.chars().count() > MAX_QUERY_CHARS {
        return Err(AppError::Other(ERR_QUERY_INVALID.to_string()));
    }
    Ok(normalized)
}

/// Reduces a full entry to one sense, for the row that only has space for one.
///
/// The endpoint packs part-of-speech groups with `;`, senses inside a group
/// with `；`, and sometimes numbers the senses and appends a definition after
/// `：`. This keeps the first real sense and drops the scaffolding.
pub(crate) fn first_sense(explain: &str) -> String {
    for group in explain.split(';') {
        let group = group.trim();
        // Strip a leading part-of-speech marker; `v．` uses a fullwidth stop.
        let without_pos = group
            .split_once(|c| c == '.' || c == '．')
            .map(|(head, rest)| {
                if head.chars().count() <= 4 && head.chars().all(|c| c.is_ascii_alphabetic() || c.is_ascii_digit()) {
                    rest
                } else {
                    group
                }
            })
            .unwrap_or(group)
            .trim();
        if without_pos.is_empty() {
            continue;
        }
        // `详述，叙述：详细地讲述或描述某事。` — the part before `：` is the gloss.
        let sense = without_pos
            .split('：')
            .next()
            .unwrap_or(without_pos)
            .split('；')
            .next()
            .unwrap_or(without_pos)
            .trim()
            .trim_end_matches(['。', '.', '…'])
            .trim();
        if !sense.is_empty() {
            return sense.to_string();
        }
    }
    String::new()
}

async fn fetch_explain(query: &str) -> AppResult<String> {
    let response = crate::ai::http_client()
        .get(SUGGEST_ENDPOINT)
        .query(&[("q", query), ("num", "1"), ("doctype", "json")])
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|_| AppError::Other(ERR_UNAVAILABLE.to_string()))?;

    if !response.status().is_success() {
        return Err(AppError::Other(ERR_UNAVAILABLE.to_string()));
    }

    let parsed: SuggestResponse = response
        .json()
        .await
        .map_err(|_| AppError::Other(ERR_UNAVAILABLE.to_string()))?;
    if parsed.result.code != 200 {
        return Err(AppError::Other(ERR_NOT_FOUND.to_string()));
    }

    let explain = parsed
        .data
        .and_then(|data| data.entries.into_iter().next())
        .map(|entry| entry.explain.trim().to_string())
        .filter(|explain| !explain.is_empty())
        .ok_or_else(|| AppError::Other(ERR_NOT_FOUND.to_string()))?;
    Ok(explain)
}

/// Both shapes of the entry: the full text for the reference row, and one sense
/// for the places that only have a single line. Parsing stays here rather than
/// in the frontend so the two callers cannot drift apart.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryGloss {
    pub explain: String,
    pub first_sense: String,
}

#[tauri::command]
pub async fn dictionary_gloss(word: String) -> AppResult<DictionaryGloss> {
    let query = normalize_query(&word)?;

    let cached = cache().lock().ok().and_then(|map| map.get(&query).cloned());
    let explain = match cached {
        Some(hit) => hit,
        None => {
            let fetched = fetch_explain(&query).await?;
            if let Ok(mut map) = cache().lock() {
                // Plain clear rather than an LRU: the cap bounds a session, and
                // a rebuild costs one request per word actually revisited.
                if map.len() >= MAX_CACHE_ENTRIES {
                    map.clear();
                }
                map.insert(query, fetched.clone());
            }
            fetched
        }
    };

    Ok(DictionaryGloss {
        first_sense: first_sense(&explain),
        explain,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Every sample below is a real response captured on 2026-07-31.

    #[test]
    fn first_sense_drops_the_part_of_speech_marker() {
        assert_eq!(first_sense("n. 多伦多（加拿大城市）"), "多伦多（加拿大城市）");
    }

    #[test]
    fn first_sense_takes_the_leading_sense_of_the_first_group() {
        assert_eq!(
            first_sense("v. 羡慕，忌妒；向往，渴望（别人的东西）; n. 妒忌，羡慕；令人羡慕的人（或事物）"),
            "羡慕，忌妒",
        );
        assert_eq!(
            first_sense("n. 银行；储蓄罐；库存，库；河岸；斜坡；云团，雾团"),
            "银行",
        );
    }

    // `recounted` opens with a bare `v．` group that has no sense in it.
    #[test]
    fn first_sense_skips_an_empty_leading_group() {
        assert_eq!(
            first_sense("v．; 1. 详述，叙述：详细地讲述或描述某事。; 2. 重新计算，重新计票：重新计算票数或结果，通..."),
            "详述，叙述",
        );
    }

    #[test]
    fn first_sense_keeps_an_inflection_note() {
        assert_eq!(
            first_sense("v. 使受惊（startle 的过去式和过去分词）; adj. 受惊吓了的"),
            "使受惊（startle 的过去式和过去分词）",
        );
    }

    #[test]
    fn first_sense_of_nothing_is_empty() {
        assert_eq!(first_sense(""), "");
        assert_eq!(first_sense("  ;  ; "), "");
    }

    #[test]
    fn queries_are_normalized_and_bounded() {
        assert_eq!(normalize_query("  look   up \n").unwrap(), "look up");
        assert!(normalize_query("   ").is_err());
        assert!(normalize_query(&"a".repeat(MAX_QUERY_CHARS + 1)).is_err());
    }

    #[tokio::test]
    #[ignore = "requires network"]
    async fn live_lookup_returns_an_entry() {
        let explain = fetch_explain("recounted").await.unwrap();
        assert!(explain.contains("详述"), "{explain}");
        assert_eq!(first_sense(&explain), "详述，叙述");
    }

    #[tokio::test]
    #[ignore = "requires network"]
    async fn live_lookup_of_a_non_word_reports_not_found() {
        let error = fetch_explain("zxqwvbnm").await.unwrap_err();
        assert_eq!(error.to_string(), ERR_NOT_FOUND);
    }
}

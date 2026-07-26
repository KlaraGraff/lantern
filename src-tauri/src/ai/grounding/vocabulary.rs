//! Deterministic helpers for source-grounded vocabulary scans.
//!
//! The chat command owns provider calls and streaming. This module keeps the
//! part that must remain local and testable: batching source chunks, parsing
//! the extraction worker's JSON, rejecting unsupported claims, and merging
//! duplicate terms.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use super::chunk::estimate_tokens;
use super::retrieve::RetrievedChunk;

pub const BATCH_TOKEN_BUDGET: usize = 4_500;
pub const MAX_MAP_BATCHES: usize = 200;
pub const MAX_CANDIDATES: usize = 2_000;

#[derive(Debug, Clone, PartialEq)]
pub struct VocabularyBatch {
    pub index: usize,
    pub chunks: Vec<RetrievedChunk>,
    pub token_estimate: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct VocabularyCandidate {
    pub term: String,
    pub lemma: Option<String>,
    pub part_of_speech: Option<String>,
    pub pronunciation: Option<String>,
    pub meaning: Option<String>,
    pub context: Option<String>,
    pub quote: String,
    pub chunk_id: String,
    pub section_title: Option<String>,
    pub char_start: Option<i64>,
    pub char_end: Option<i64>,
    #[serde(skip)]
    pub chunk_index: i64,
}

#[derive(Debug, Clone, Deserialize)]
struct RawVocabularyCandidate {
    #[serde(default)]
    term: Option<String>,
    #[serde(default)]
    lemma: Option<String>,
    #[serde(default, alias = "partOfSpeech", alias = "pos")]
    part_of_speech: Option<String>,
    #[serde(default)]
    pronunciation: Option<String>,
    #[serde(default)]
    meaning: Option<String>,
    #[serde(default, alias = "meaningInContext", alias = "contextMeaning")]
    context: Option<String>,
    #[serde(default)]
    quote: Option<String>,
    #[serde(default, alias = "chunkId")]
    chunk_id: Option<String>,
    #[serde(default, alias = "charStart")]
    char_start: Option<i64>,
    #[serde(default, alias = "charEnd")]
    char_end: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct RawVocabularyEnvelope {
    #[serde(default)]
    items: Vec<RawVocabularyCandidate>,
}

fn normalize_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn normalized_contains(haystack: &str, needle: &str) -> bool {
    let haystack = normalize_whitespace(haystack);
    let needle = normalize_whitespace(needle);
    !needle.is_empty() && haystack.contains(&needle)
}

fn clean_field(value: Option<String>, maximum: usize) -> Option<String> {
    value
        .map(|value| value.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|value| !value.is_empty() && value.chars().count() <= maximum)
}

/// Split chunks in reading order. A chunk that is larger than the budget gets
/// its own batch; the indexer normally keeps chunks well below this limit.
pub fn batches(chunks: &[RetrievedChunk], budget: usize) -> Vec<VocabularyBatch> {
    if chunks.is_empty() || budget == 0 {
        return Vec::new();
    }
    let mut result = Vec::new();
    let mut current = Vec::new();
    let mut used = 0usize;
    for chunk in chunks {
        let size = chunk.token_estimate.max(estimate_tokens(&chunk.text));
        if !current.is_empty() && used.saturating_add(size) > budget {
            result.push(VocabularyBatch {
                index: result.len(),
                chunks: std::mem::take(&mut current),
                token_estimate: used,
            });
            used = 0;
        }
        used = used.saturating_add(size);
        current.push(chunk.clone());
    }
    if !current.is_empty() {
        result.push(VocabularyBatch {
            index: result.len(),
            chunks: current,
            token_estimate: used,
        });
    }
    result
}

/// JSON source payload used by the extraction worker. JSON keeps source text
/// boundaries unambiguous even when a book contains delimiter-like prose.
pub fn source_payload(batch: &VocabularyBatch) -> String {
    let source = batch
        .chunks
        .iter()
        .map(|chunk| {
            serde_json::json!({
                "chunkId": chunk.chunk_id,
                "sectionTitle": chunk.section_title,
                "text": chunk.text,
            })
        })
        .collect::<Vec<_>>();
    serde_json::to_string(&source).expect("vocabulary source is serializable")
}

fn json_fragment(raw: &str) -> Option<&str> {
    let trimmed = raw.trim();
    let start_object = trimmed.find('{');
    let start_array = trimmed.find('[');
    let (start, open, close) = match (start_object, start_array) {
        (Some(object), Some(array)) if array < object => (array, '[', ']'),
        (Some(object), _) => (object, '{', '}'),
        (None, Some(array)) => (array, '[', ']'),
        _ => return None,
    };
    let end = trimmed.rfind(close)?;
    (end >= start && trimmed.as_bytes().get(start) == Some(&(open as u8)))
        .then_some(&trimmed[start..=end])
}

fn decode_items(raw: &str) -> Option<Vec<RawVocabularyCandidate>> {
    let fragment = json_fragment(raw)?;
    if fragment.starts_with('[') {
        serde_json::from_str(fragment).ok()
    } else {
        serde_json::from_str::<RawVocabularyEnvelope>(fragment)
            .ok()
            .map(|value| value.items)
    }
}

/// Parse and validate one extraction response. Every accepted item must be
/// traceable to exactly one source chunk and an exact quote from that chunk.
pub fn parse_candidates(raw: &str, batch: &VocabularyBatch) -> Vec<VocabularyCandidate> {
    let Some(items) = decode_items(raw) else {
        return Vec::new();
    };
    let chunks = batch
        .chunks
        .iter()
        .map(|chunk| (chunk.chunk_id.as_str(), chunk))
        .collect::<HashMap<_, _>>();
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for item in items {
        let Some(term) = item.term.as_deref().map(str::trim) else {
            continue;
        };
        let Some(quote) = item.quote.as_deref().map(str::trim) else {
            continue;
        };
        if term.is_empty()
            || quote.is_empty()
            || term.chars().count() > 120
            || quote.chars().count() > 800
        {
            continue;
        }
        let Some(chunk_id) = item.chunk_id.as_deref().map(str::trim) else {
            continue;
        };
        let Some(chunk) = chunks.get(chunk_id) else {
            continue;
        };
        if !normalized_contains(&chunk.text, quote) || !normalized_contains(quote, term) {
            continue;
        }
        let key = item.lemma.as_deref().unwrap_or(term).trim().to_lowercase();
        if key.is_empty() || !seen.insert(key) {
            continue;
        }
        let char_start = item
            .char_start
            .filter(|value| chunk.char_start.is_none_or(|start| *value >= start));
        let char_end = item
            .char_end
            .filter(|value| chunk.char_end.is_none_or(|end| *value <= end));
        result.push(VocabularyCandidate {
            term: term.to_string(),
            lemma: clean_field(item.lemma, 120),
            part_of_speech: clean_field(item.part_of_speech, 80),
            pronunciation: clean_field(item.pronunciation, 120),
            meaning: clean_field(item.meaning, 500),
            context: clean_field(item.context, 500),
            quote: normalize_whitespace(quote),
            chunk_id: chunk.chunk_id.clone(),
            section_title: chunk.section_title.clone(),
            char_start,
            char_end,
            chunk_index: chunk.chunk_index,
        });
        if result.len() >= MAX_CANDIDATES {
            break;
        }
    }
    result
}

/// Deterministically merge map outputs. The earliest occurrence wins, so the
/// final answer remains in reading order and duplicate terms cannot multiply
/// just because they appeared in adjacent batches.
pub fn merge_candidates(candidates: Vec<VocabularyCandidate>) -> Vec<VocabularyCandidate> {
    let mut candidates = candidates;
    // Map responses normally arrive in batch order, but sorting first makes
    // the "earliest occurrence wins" guarantee independent of provider
    // completion order or future parallelization.
    candidates.sort_by_key(|candidate| candidate.chunk_index);
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    for candidate in candidates {
        let key = candidate
            .lemma
            .as_deref()
            .unwrap_or(&candidate.term)
            .trim()
            .to_lowercase();
        if key.is_empty() || !seen.insert(key) {
            continue;
        }
        result.push(candidate);
        if result.len() >= MAX_CANDIDATES {
            break;
        }
    }
    result.sort_by_key(|candidate| candidate.chunk_index);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(id: &str, index: i64, text: &str, tokens: usize) -> RetrievedChunk {
        RetrievedChunk {
            chunk_id: id.to_string(),
            chunk_index: index,
            section_index: 0,
            section_href: None,
            section_title: Some("Chapter".to_string()),
            char_start: Some(index * 10),
            char_end: Some(index * 10 + 9),
            snippet: text.to_string(),
            text: text.to_string(),
            token_estimate: tokens,
            score: 0.0,
        }
    }

    #[test]
    fn batches_preserve_order_and_budget() {
        let chunks = vec![
            chunk("a", 0, "alpha", 3),
            chunk("b", 1, "beta", 3),
            chunk("c", 2, "gamma", 3),
        ];
        let batches = batches(&chunks, 5);
        assert_eq!(batches.len(), 3);
        assert_eq!(batches[0].chunks[0].chunk_id, "a");
        assert_eq!(batches[2].chunks[0].chunk_id, "c");
    }

    #[test]
    fn parser_rejects_untraceable_items_and_accepts_exact_quote() {
        let batch = VocabularyBatch {
            index: 0,
            chunks: vec![chunk("a", 0, "A resilient person endured hardship.", 8)],
            token_estimate: 8,
        };
        let raw = r#"{"items":[
          {"term":"resilient","lemma":"resilient","meaning":"able to recover","quote":"A resilient person endured hardship.","chunkId":"a"},
          {"term":"hope","quote":"A hopeful future","chunkId":"a"},
          {"term":"resilient","quote":"invented","chunkId":"missing"}
        ]}"#;
        let values = parse_candidates(raw, &batch);
        assert_eq!(values.len(), 1);
        assert_eq!(values[0].term, "resilient");
    }

    #[test]
    fn parser_accepts_fenced_json_and_normalizes_quote_whitespace() {
        let batch = VocabularyBatch {
            index: 0,
            chunks: vec![chunk("a", 0, "A resilient\nperson endured hardship.", 8)],
            token_estimate: 8,
        };
        let raw = "```json\n{\"items\":[{\"term\":\"resilient\",\"quote\":\"A resilient person endured hardship.\",\"chunkId\":\"a\"}]}\n```";
        let values = parse_candidates(raw, &batch);
        assert_eq!(values.len(), 1);
        assert_eq!(values[0].quote, "A resilient person endured hardship.");
    }

    #[test]
    fn parser_skips_one_malformed_item_without_dropping_the_batch() {
        let batch = VocabularyBatch {
            index: 0,
            chunks: vec![chunk("a", 0, "A resilient person endured hardship.", 8)],
            token_estimate: 8,
        };
        let raw = r#"{"items":[
          {"term":"resilient","quote":"A resilient person endured hardship.","chunkId":"a"},
          {"term":"missing quote","chunkId":"a"}
        ]}"#;
        let values = parse_candidates(raw, &batch);
        assert_eq!(values.len(), 1);
        assert_eq!(values[0].term, "resilient");
    }

    #[test]
    fn merge_keeps_earliest_case_insensitive_lemma() {
        let first = VocabularyCandidate {
            term: "Resilient".into(),
            lemma: Some("resilient".into()),
            part_of_speech: None,
            pronunciation: None,
            meaning: Some("first".into()),
            context: None,
            quote: "Resilient people.".into(),
            chunk_id: "a".into(),
            section_title: None,
            char_start: None,
            char_end: None,
            chunk_index: 0,
        };
        let second = VocabularyCandidate {
            chunk_index: 1,
            meaning: Some("second".into()),
            ..first.clone()
        };
        let merged = merge_candidates(vec![second, first]);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].meaning.as_deref(), Some("first"));
    }
}

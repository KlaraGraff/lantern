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
/// Undocumented and unofficial, like `SUGGEST_ENDPOINT` — it can change shape
/// without notice, which is exactly why every read from it is tolerant
/// (`#[serde(default)]` everywhere) and every failure to parse it just falls
/// back to the suggest endpoint rather than surfacing an error.
const JSONAPI_ENDPOINT: &str = "https://dict.youdao.com/jsonapi";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_QUERY_CHARS: usize = 64;
/// Glosses are a few dozen bytes each; this is a session-lifetime convenience,
/// not a store worth spilling to disk.
const MAX_CACHE_ENTRIES: usize = 2_000;
/// At most this many part-of-speech groups are shown at once. Whatever comes
/// after the third is folded into `omitted_sense_count` rather than shown.
const MAX_GROUPS: usize = 3;
/// How many CJK characters one line of the card holds: it is 300px wide, and
/// the sense text renders at 12px, so ~23 fit — rounded down for the latin
/// part-of-speech label that shares the first line. The backend has to know
/// this number because it is the *only* truncator: the card no longer clamps
/// in CSS, so `omitted_sense_count` is honest only if the budget enforced
/// here is the budget the card can actually show.
const CHARS_PER_LINE: usize = 22;
/// Sense lines the card gives away in total, shared out among the groups it
/// shows rather than handed to each one. A fixed per-group budget rationed a
/// single-part-of-speech entry as though two more parts of speech were
/// competing for the room — which is why `deliver` (one `v.`, eleven senses)
/// showed eight and pushed the rest to the AI while two thirds of the card
/// stood empty.
const CARD_SENSE_LINES: usize = 6;
/// No group is squeezed below this, however many groups there are.
const MIN_GROUP_LINES: usize = 2;
/// `ec` appends a transliteration group to a lot of ordinary words —
/// `bank` → `【名】（Bank）（英、德、俄）班克`. It is worth nothing to someone who
/// just clicked an ordinary word mid-sentence, and it costs one of the three
/// group slots (`bank`, `book`, `run`, `mean` all spend one on it). Dropped
/// only when a real part of speech survives it: for a genuine proper noun it
/// can be the entire entry.
const NAME_POS_MARKER: &str = "名";
/// The fallback gloss has no part-of-speech grouping to lean on, so it is cut
/// to a single hard line instead.
const FALLBACK_SUMMARY_CHARS: usize = 53;

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
            .split_once(['.', '．'])
            .map(|(head, rest)| {
                if head.chars().count() <= 4
                    && head
                        .chars()
                        .all(|c| c.is_ascii_alphabetic() || c.is_ascii_digit())
                {
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

// --- Single-click dictionary layer -----------------------------------------
//
// `dictionary_gloss` above answers "give me one line"; this answers "show me
// everything, grouped by part of speech, capped so it never floods the
// reader's context menu." The two are deliberately separate commands with
// separate shapes — `dictionary_gloss` already has callers
// (`ExplainPopover.tsx`, `VocabEntryDetails.tsx`, `collect.ts`) that expect
// its exact `{ explain, firstSense }` shape, and `first_sense()` picks
// whichever sense comes first in the raw text, which is precisely wrong for
// a display that must never show only the first sense a book didn't mean.

/// Deserialized from `dict.youdao.com/jsonapi`. Every field below is
/// `#[serde(default)]` because the endpoint is unofficial: a field going
/// missing, or the whole `ec`/`ce` key going missing (a genuine "not found"),
/// must not be treated as a parse error.
#[derive(Deserialize, Default)]
struct JsonApiResponse {
    #[serde(default)]
    ec: Option<EcSection>,
    #[serde(default)]
    ce: Option<CeSection>,
}

#[derive(Deserialize, Default)]
struct EcSection {
    #[serde(default)]
    word: Vec<EcWord>,
}

#[derive(Deserialize, Default)]
struct EcWord {
    #[serde(default)]
    usphone: Option<String>,
    #[serde(default)]
    ukphone: Option<String>,
    #[serde(default)]
    trs: Vec<EcTr>,
}

#[derive(Deserialize, Default)]
struct EcTr {
    #[serde(default)]
    tr: Vec<EcTrInner>,
}

#[derive(Deserialize, Default)]
struct EcTrInner {
    #[serde(default)]
    l: Option<EcL>,
}

/// `ec` senses embed their part-of-speech as a text prefix inside `i`
/// (`"n. 银行；储蓄罐；…"`), rather than as a separate field the way `ce`
/// sometimes does — `split_pos_marker` below pulls it back out.
#[derive(Deserialize, Default)]
struct EcL {
    #[serde(default)]
    i: Vec<String>,
}

#[derive(Deserialize, Default)]
struct CeSection {
    #[serde(default)]
    word: Vec<CeWord>,
}

#[derive(Deserialize, Default)]
struct CeWord {
    #[serde(default)]
    phone: Option<String>,
    #[serde(default)]
    trs: Vec<CeTr>,
}

#[derive(Deserialize, Default)]
struct CeTr {
    #[serde(default)]
    tr: Vec<CeTrInner>,
}

#[derive(Deserialize, Default)]
struct CeTrInner {
    #[serde(default)]
    l: Option<CeL>,
}

/// `ce`'s `#tran` is a clean, pre-joined string of senses — far easier to
/// parse than `i`, which mixes plain strings with `{"#text": …}` link
/// objects for hyperlinked cross-references. `pos` is present for some
/// entries (`打` → `vt.`/`vi.`/`n.`) and absent for others (`银行`'s three
/// `trs` carry no part-of-speech at all) — when absent, `pos` is left empty
/// rather than guessed.
#[derive(Deserialize, Default)]
struct CeL {
    #[serde(default)]
    pos: Option<String>,
    #[serde(rename = "#tran", default)]
    tran: Option<String>,
}

/// Splits a block of senses on the separators the endpoint uses between
/// them, dropping empties (a trailing `；` is common in `ce`'s `#tran`).
fn split_senses(text: &str) -> Vec<String> {
    text.split(['；', ';'])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

/// Pulls an embedded part-of-speech marker off one `ec` sense string, if
/// there is one: `"n. 银行；…"` → `("n.", ["银行", …])`, `"【名】 （Bank）…"` →
/// `("名", ["（Bank）…"])`. Phrase entries (`look up`) have no marker at all,
/// so they come back with an empty pos and the whole string as one sense.
fn split_pos_marker(raw: &str) -> (String, Vec<String>) {
    let trimmed = raw.trim();
    if let Some(rest) = trimmed.strip_prefix('【') {
        if let Some(end) = rest.find('】') {
            let pos = rest[..end].trim().to_string();
            let remainder = rest[end + '】'.len_utf8()..].trim();
            return (pos, split_senses(remainder));
        }
    }
    if let Some(dot_pos) = trimmed.find(['.', '．']) {
        let head = &trimmed[..dot_pos];
        let dot_len = trimmed[dot_pos..].chars().next().map(char::len_utf8).unwrap_or(1);
        if !head.is_empty()
            && head.chars().count() <= 5
            && head.chars().all(|c| c.is_ascii_alphabetic())
        {
            let remainder = trimmed[dot_pos + dot_len..].trim();
            return (format!("{head}."), split_senses(remainder));
        }
    }
    (String::new(), split_senses(trimmed))
}

/// Caps one group's senses to a character budget: joins as many whole senses
/// as fit, but always keeps at least one even if it alone overruns the
/// budget (a group that vanishes is worse than a group that runs long), and
/// marks the cut with `…` when something was left out. Returns the display
/// text and how many senses made it in, so the caller can compute how many
/// did not.
fn cap_group(senses: &[String], budget: usize) -> (String, usize) {
    if senses.is_empty() {
        return (String::new(), 0);
    }
    let mut used = 0usize;
    let mut included = 0usize;
    for sense in senses {
        let len = sense.chars().count();
        let extra = if included == 0 { len } else { len + 1 };
        if included > 0 && used + extra > budget {
            break;
        }
        used += extra;
        included += 1;
    }
    let text = senses[..included].join("；");
    let text = if included < senses.len() { format!("{text}…") } else { text };
    (text, included)
}

/// One part-of-speech group in the expanded entry: `n.` / `v.` / `名`, and
/// the (possibly truncated) senses under it.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryGroup {
    pub pos: String,
    pub senses: String,
}

/// The full-fidelity entry shown in the reader's single-click dictionary
/// layer. `groups` is empty and `fallback_summary` is set when the jsonapi
/// lookup failed and the degraded `suggest` gloss was used instead — the two
/// are mutually exclusive so the frontend can render one or the other
/// without guessing which.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryEntry {
    pub word: String,
    pub phonetic: Option<String>,
    pub groups: Vec<DictionaryGroup>,
    pub omitted_sense_count: u32,
    pub fallback_summary: Option<String>,
}

/// Splits `CARD_SENSE_LINES` between however many groups will actually be
/// shown, so one part of speech gets the whole card and three get two lines
/// each.
fn group_char_budget(shown_groups: usize) -> usize {
    (CARD_SENSE_LINES / shown_groups.max(1)).max(MIN_GROUP_LINES) * CHARS_PER_LINE
}

/// Drops the `【名】` transliteration group — but only if something else is
/// left. See `NAME_POS_MARKER`.
fn drop_name_group(groups: Vec<(String, Vec<String>)>) -> Vec<(String, Vec<String>)> {
    let (real, names): (Vec<_>, Vec<_>) = groups
        .into_iter()
        .partition(|(pos, _)| pos != NAME_POS_MARKER);
    if real.is_empty() { names } else { real }
}

/// Caps `raw_groups` to `MAX_GROUPS` and each kept group to its share of the
/// card, then reports how many senses were left out in total — both the ones
/// trimmed from a kept group and every sense in a group beyond the third.
/// Senses dropped with the `【名】` group are not counted as omitted: they were
/// never candidates for display. `None` means every group was empty (nothing
/// to show).
fn entry_from_groups(
    word: String,
    phonetic: Option<String>,
    raw_groups: Vec<(String, Vec<String>)>,
) -> Option<DictionaryEntry> {
    let non_empty: Vec<(String, Vec<String>)> = raw_groups
        .into_iter()
        .filter(|(_, senses)| !senses.is_empty())
        .collect();
    if non_empty.is_empty() {
        return None;
    }
    let candidates = drop_name_group(non_empty);
    let budget = group_char_budget(candidates.len().min(MAX_GROUPS));
    let total_senses: usize = candidates.iter().map(|(_, senses)| senses.len()).sum();
    let mut shown_senses = 0usize;
    let mut groups = Vec::new();
    for (pos, senses) in candidates.into_iter().take(MAX_GROUPS) {
        let (text, included) = cap_group(&senses, budget);
        shown_senses += included;
        groups.push(DictionaryGroup { pos, senses: text });
    }
    Some(DictionaryEntry {
        word,
        phonetic,
        groups,
        omitted_sense_count: total_senses.saturating_sub(shown_senses) as u32,
        fallback_summary: None,
    })
}

/// Builds the display entry from a parsed jsonapi response: `ec` first (most
/// English queries), `ce` if `ec` is absent or yields nothing (Chinese
/// queries, and English queries `ec` has no entry for). `None` means neither
/// section produced a usable entry — a genuine not-found.
fn build_entry(query: &str, parsed: JsonApiResponse) -> Option<DictionaryEntry> {
    if let Some(ec) = parsed.ec {
        if let Some(word) = ec.word.into_iter().next() {
            let phonetic = word.usphone.or(word.ukphone);
            let raw_groups: Vec<(String, Vec<String>)> = word
                .trs
                .into_iter()
                .filter_map(|tr| tr.tr.into_iter().next())
                .filter_map(|inner| inner.l)
                .flat_map(|l| l.i)
                .map(|raw| split_pos_marker(&raw))
                .collect();
            if let Some(entry) = entry_from_groups(query.to_string(), phonetic, raw_groups) {
                return Some(entry);
            }
        }
    }
    if let Some(ce) = parsed.ce {
        if let Some(word) = ce.word.into_iter().next() {
            let phonetic = word.phone;
            let raw_groups: Vec<(String, Vec<String>)> = word
                .trs
                .into_iter()
                .filter_map(|tr| tr.tr.into_iter().next())
                .filter_map(|inner| inner.l)
                .filter_map(|CeL { pos, tran }| {
                    tran.map(|tran| (pos.unwrap_or_default(), split_senses(&tran)))
                })
                .collect();
            return entry_from_groups(query.to_string(), phonetic, raw_groups);
        }
    }
    None
}

/// The real network call. `Err(())` covers timeout, non-200, and parse
/// failure alike — all three mean the same thing to the caller: fall back to
/// `suggest`. `Ok(None)` is different: a clean response that genuinely has
/// neither `ec` nor `ce`, i.e. the word was looked up and not found.
async fn jsonapi_lookup(query: &str) -> Result<Option<DictionaryEntry>, ()> {
    let response = crate::ai::http_client()
        .get(JSONAPI_ENDPOINT)
        .query(&[
            ("q", query),
            // Scopes the response to just these two dictionaries. Without it
            // the endpoint returns every dictionary it has (~115KB, ~2.7s);
            // with it, ~1.4KB and ~0.8s for the same query.
            ("dicts", r#"{"count":99,"dicts":[["ec","ce"]]}"#),
        ])
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|_| ())?;

    if !response.status().is_success() {
        return Err(());
    }

    let parsed: JsonApiResponse = response.json().await.map_err(|_| ())?;
    Ok(build_entry(query, parsed))
}

fn fallback_entry(query: &str, explain: &str) -> DictionaryEntry {
    let mut summary: String = explain.chars().take(FALLBACK_SUMMARY_CHARS).collect();
    if explain.chars().count() > FALLBACK_SUMMARY_CHARS {
        summary.push('…');
    }
    DictionaryEntry {
        word: query.to_string(),
        phonetic: None,
        groups: Vec::new(),
        omitted_sense_count: 0,
        fallback_summary: Some(summary),
    }
}

/// Pure and synchronous on purpose: the async command below is a thin
/// wrapper around this, so "parse failure falls back to suggest, and a
/// failure in both surfaces the fallback's own error" can be tested with
/// synthetic outcomes and no network at all.
///
/// - `Ok(Some(entry))` — jsonapi succeeded, used as-is.
/// - `Ok(None)` — jsonapi genuinely found nothing; this is final, no
///   fallback attempt (a real not-found is not what the fallback is for).
/// - `Err(())` — jsonapi timed out, errored, or failed to parse; `fallback`
///   (already awaited by the caller) decides the outcome.
fn merge_lookup_outcome(
    jsonapi_outcome: Result<Option<DictionaryEntry>, ()>,
    query: &str,
    fallback: Option<Result<String, AppError>>,
) -> Result<DictionaryEntry, String> {
    match jsonapi_outcome {
        Ok(Some(entry)) => Ok(entry),
        Ok(None) => Err(ERR_NOT_FOUND.to_string()),
        Err(()) => match fallback {
            Some(Ok(explain)) => Ok(fallback_entry(query, &explain)),
            Some(Err(error)) => Err(error.to_string()),
            None => Err(ERR_UNAVAILABLE.to_string()),
        },
    }
}

fn lookup_cache() -> &'static Mutex<HashMap<String, Result<DictionaryEntry, String>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Result<DictionaryEntry, String>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The single-click dictionary layer: jsonapi first, `suggest` as a fallback
/// when jsonapi is unavailable or unparseable, cached either way so the same
/// word never triggers a second request in this session — including a
/// cached error, so a word that failed once does not get hammered on every
/// re-click.
#[tauri::command]
pub async fn dictionary_lookup_word(word: String) -> AppResult<DictionaryEntry> {
    let query = normalize_query(&word)?;

    if let Some(cached) = lookup_cache().lock().ok().and_then(|map| map.get(&query).cloned()) {
        return cached.map_err(AppError::Other);
    }

    let jsonapi_outcome = jsonapi_lookup(&query).await;
    let fallback = if jsonapi_outcome.is_err() {
        Some(fetch_explain(&query).await)
    } else {
        None
    };
    let result = merge_lookup_outcome(jsonapi_outcome, &query, fallback);

    if let Ok(mut map) = lookup_cache().lock() {
        if map.len() >= MAX_CACHE_ENTRIES {
            map.clear();
        }
        map.insert(query, result.clone());
    }

    result.map_err(AppError::Other)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Every sample below is a real response captured on 2026-07-31.

    #[test]
    fn first_sense_drops_the_part_of_speech_marker() {
        assert_eq!(
            first_sense("n. 多伦多（加拿大城市）"),
            "多伦多（加拿大城市）"
        );
    }

    #[test]
    fn first_sense_takes_the_leading_sense_of_the_first_group() {
        assert_eq!(
            first_sense(
                "v. 羡慕，忌妒；向往，渴望（别人的东西）; n. 妒忌，羡慕；令人羡慕的人（或事物）"
            ),
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

    // --- Single-click dictionary layer -------------------------------------
    //
    // Every JSON blob below is a real `jsonapi` response captured live on
    // 2026-08-09 (trimmed to just its `ec`/`ce` keys), never a guess at the
    // endpoint's shape. None of these tests touch the network.

    const BANK_EC: &str = r#"{"ec": {"word": [{"usphone": "bæŋk", "ukphone": "bæŋk", "trs": [{"tr": [{"l": {"i": ["n. 银行；储蓄罐；库存，库；河岸；斜坡；云团，雾团；一排，一组；庄家的赌本；（泥）滩，沙洲"]}}]}, {"tr": [{"l": {"i": ["v. 把（钱）存入银行，把……储存入库；与银行有业务往来；（飞机）倾斜飞行；使反弹；（把某物）堆积起来，聚集起来；（用煤等）封炉火"]}}]}, {"tr": [{"l": {"i": ["【名】 （Bank）（英、德、俄）班克，（法、匈）邦克（人名）"]}}]}]}]}}"#;

    const RUN_EC: &str = r#"{"ec": {"word": [{"usphone": "rʌn", "ukphone": "rʌn", "trs": [{"tr": [{"l": {"i": ["v. 跑，奔跑；参加（赛跑），举行（比赛）；跑垒，持球跑动进攻；奔忙，赶快去；管理，经营，使用（车辆）；（使）运转，操作；刊登，播放；（使）行驶；（使）移动，揉擦；闯红灯；（使）流动，流淌；掉色，渗色；变成，变得；达到（一定数量或比率）；（对……）进行（测试或检验）；参加竞选；（连裤袜、长统袜）抽丝，脱线；（使）延伸；（感觉或想法）掠过，迅速传遍；包含（某种词语、内容等）；持续，延续；偷运，走私；印刷；（特征）共有，世代相传（run in）；<美>（物品，行动）花费（某人）（特定数额的钱）"]}}]}, {"tr": [{"l": {"i": ["n. 跑步，赛跑；旅程，航程；一系列（成功或失败）；连续上演（或放映）；尝试，努力；额定产量；抛售（美元、英镑等）；争购，挤兑；滑道，路径；（板球或棒球中的）得分；使用自由，出入自由（the run of）；竞选；普通人，普通事物；饲养场；急奏，走句；顺子；<非正式>腹泻（the runs）；<美>（长统袜或连裤袜的）抽丝；（油漆或类似物刷得过厚引起的）挂流，小溪；（航海）船尾端部"]}}]}, {"tr": [{"l": {"i": ["【名】 （Run）（塞）鲁恩（人名）"]}}]}]}]}}"#;

    // `i` (a mix of plain strings and `{"#text": …}` link objects, for
    // hyperlinked cross-references) is omitted below: `CeL` does not declare
    // that field, and it is not used for anything we display.
    // A single `#` after the raw-string delimiter would prematurely close it
    // at the `"#tran"` key's own `"#`, so these two use a double-hash
    // delimiter instead.
    const YINHANG_CE: &str = r##"{"ce": {"word": [{"trs": [{"tr": [{"l": {"#tran": "银行；储蓄罐；库存，库；河岸；斜坡；云团，雾团；一排，一组；庄家的赌本；（泥）滩，沙洲；把（钱）存入银行，把……储存入库；与银行有业务往来；（飞机）倾斜飞行；使反弹；（把某物）堆积起来，聚集起来；（用煤等）封炉火；【名】 （Bank）（英、德、俄）班克，（法、匈）邦克（人名）；"}}]}, {"tr": [{"l": {"#tran": "银行；"}}]}, {"tr": [{"l": {"#tran": "拒绝贷款；划红线注销；经济歧视；用红线注销；使飞机停止（redline 的现在分词）；"}}]}], "phone": "yín háng"}]}}"##;

    const DA_CE: &str = r##"{"ce": {"word": [{"trs": [{"tr": [{"l": {"pos": "vt.", "#tran": "打，击；撞击，碰撞；击中，命中"}}]}, {"tr": [{"l": {"pos": "vi.", "#tran": "与……作斗争，坚决反对；努力争取，为……而斗争"}}]}, {"tr": [{"l": {"pos": "n.", "#tran": "一打，十二个；大量，许多；十多个"}}]}], "phone": "dá,dǎ"}]}}"##;

    const LOOK_UP_EC: &str = r#"{"ec": {"word": [{"trs": [{"tr": [{"l": {"i": ["改善前景或条件：指在前景或条件方面有所改善。"]}}]}, {"tr": [{"l": {"i": ["查找（信息）：指在参考资料中查找信息。"]}}]}, {"tr": [{"l": {"i": ["拜访：指为了短暂的拜访而寻找某人。"]}}]}]}]}}"#;

    /// Real response for `asdfqwerzz` — no `ec`, no `ce`, only `meta`.
    const NOT_FOUND: &str = r#"{}"#;

    fn parse(json: &str) -> JsonApiResponse {
        serde_json::from_str(json).expect("fixture should parse")
    }

    #[test]
    fn ec_entry_groups_by_embedded_part_of_speech() {
        let entry = build_entry("bank", parse(BANK_EC)).expect("bank should resolve");
        assert_eq!(entry.word, "bank");
        assert_eq!(entry.phonetic.as_deref(), Some("bæŋk"));
        assert_eq!(entry.groups.len(), 2, "the 【名】 transliteration group is not one of them");
        assert_eq!(entry.groups[0].pos, "n.");
        assert!(entry.groups[0].senses.starts_with("银行"), "{}", entry.groups[0].senses);
        assert_eq!(entry.groups[1].pos, "v.");
    }

    #[test]
    fn a_name_only_entry_keeps_its_name_group() {
        // `Frankl`-shaped: dropping 【名】 unconditionally would leave a real
        // proper noun with nothing at all to show.
        const NAME_ONLY: &str =
            r#"{"ec": {"word": [{"trs": [{"tr": [{"l": {"i": ["【名】 （Bank）（英）班克（人名）"]}}]}]}]}}"#;
        let entry = build_entry("Bank", parse(NAME_ONLY)).expect("a name entry still resolves");
        assert_eq!(entry.groups.len(), 1);
        assert_eq!(entry.groups[0].pos, "名");
    }

    #[test]
    fn a_single_part_of_speech_entry_gets_the_whole_card() {
        // Real `deliver`: Youdao packs all eleven senses into one `v.` group,
        // so there is no second part of speech to compete for the room. Under
        // a fixed per-group budget this showed eight and sent the reader to
        // the AI for the other three.
        const DELIVER_EC: &str = r#"{"ec": {"word": [{"usphone": "dɪˈlɪvər", "trs": [{"tr": [{"l": {"i": ["v. 投递，运送；履行，兑现；交付，移交；发表，宣布；接生，分娩；解救，拯救；投掷，击打；（法官或法庭）宣布（判决）；拉（选票）；发行，发布（计算机程序）；处理"]}}]}]}]}}"#;
        let entry = build_entry("deliver", parse(DELIVER_EC)).expect("deliver should resolve");
        assert_eq!(entry.groups.len(), 1);
        assert_eq!(entry.omitted_sense_count, 0, "{}", entry.groups[0].senses);
        assert!(entry.groups[0].senses.ends_with("处理"), "{}", entry.groups[0].senses);
    }

    #[test]
    fn ec_entry_never_shows_only_the_first_sense() {
        // `first_sense("bank")` would be "银行" (money) alone — exactly the
        // "misleadingly confident" single line this display must not show.
        let entry = build_entry("bank", parse(BANK_EC)).unwrap();
        assert_ne!(entry.groups[0].senses, "银行");
        assert!(entry.groups[0].senses.contains('；') || entry.groups[0].senses.contains('…'));
    }

    #[test]
    fn ec_entry_caps_groups_and_reports_what_was_cut() {
        let entry = build_entry("run", parse(RUN_EC)).expect("run should resolve");
        assert_eq!(entry.groups.len(), 2, "v. and n.; run's third group is 【名】");
        // Both the verb and noun groups have far more senses than fit the
        // budget, so both should be truncated (never dropped outright) and
        // the omitted count should reflect real cut senses.
        assert!(entry.groups[0].senses.ends_with('…'), "{}", entry.groups[0].senses);
        assert!(entry.groups[1].senses.ends_with('…'), "{}", entry.groups[1].senses);
        assert!(!entry.groups[0].senses.is_empty());
        assert!(!entry.groups[1].senses.is_empty());
        assert!(entry.omitted_sense_count > 0);
        let budget = group_char_budget(entry.groups.len());
        for group in &entry.groups {
            // Budget plus the trailing ellipsis, generously bounded.
            assert!(group.senses.chars().count() <= budget + 4, "{}", group.senses);
        }
    }

    #[test]
    fn ce_entry_parses_the_tran_field_and_keeps_pos_when_present() {
        let entry = build_entry("打", parse(DA_CE)).expect("打 should resolve");
        assert_eq!(entry.phonetic.as_deref(), Some("dá,dǎ"));
        assert_eq!(entry.groups.len(), 3);
        assert_eq!(entry.groups[0].pos, "vt.");
        assert_eq!(entry.groups[1].pos, "vi.");
        assert_eq!(entry.groups[2].pos, "n.");
    }

    #[test]
    fn ce_entry_leaves_pos_blank_rather_than_guessing_it() {
        // `银行`'s three `trs` carry no `pos` field at all in the real
        // response — grouping still happens (one group per `trs`), but the
        // label is honestly empty rather than fabricated.
        let entry = build_entry("银行", parse(YINHANG_CE)).expect("银行 should resolve");
        assert_eq!(entry.phonetic.as_deref(), Some("yín háng"));
        assert_eq!(entry.groups.len(), 3);
        assert!(entry.groups.iter().all(|group| group.pos.is_empty()));
        assert!(entry.groups[0].senses.starts_with("银行"), "{}", entry.groups[0].senses);
    }

    #[test]
    fn ec_phrase_entry_has_no_marker_and_no_phonetic() {
        let entry = build_entry("look up", parse(LOOK_UP_EC)).expect("look up should resolve");
        assert_eq!(entry.phonetic, None);
        assert_eq!(entry.groups.len(), 3);
        assert!(entry.groups.iter().all(|group| group.pos.is_empty()));
        assert!(entry.groups[0].senses.starts_with("改善前景或条件"));
    }

    #[test]
    fn genuinely_not_found_response_yields_no_entry() {
        assert!(build_entry("asdfqwerzz", parse(NOT_FOUND)).is_none());
    }

    #[test]
    fn cap_group_always_keeps_at_least_one_sense() {
        let senses = vec!["一个非常非常非常非常非常非常非常非常非常非常长的义项，长到自己就超过预算".to_string()];
        let (text, included) = cap_group(&senses, 10);
        assert_eq!(included, 1);
        assert!(text.starts_with("一个"));
        assert!(!text.ends_with('…'), "a single, unsplittable sense is not truncated mid-way");
    }

    #[test]
    fn cap_group_of_nothing_is_empty() {
        assert_eq!(cap_group(&[], 60), (String::new(), 0));
    }

    #[test]
    fn split_pos_marker_handles_ascii_bracketed_and_bare_forms() {
        assert_eq!(
            split_pos_marker("n. 银行；储蓄罐"),
            ("n.".to_string(), vec!["银行".to_string(), "储蓄罐".to_string()]),
        );
        assert_eq!(
            split_pos_marker("【名】 （Bank）（人名）"),
            ("名".to_string(), vec!["（Bank）（人名）".to_string()]),
        );
        assert_eq!(
            split_pos_marker("改善前景或条件：指在前景或条件方面有所改善。"),
            (String::new(), vec!["改善前景或条件：指在前景或条件方面有所改善。".to_string()]),
        );
    }

    #[test]
    fn fallback_entry_hard_truncates_to_one_line() {
        let long_explain = "n. ".to_string() + &"义".repeat(200);
        let entry = fallback_entry("recounted", &long_explain);
        assert_eq!(entry.word, "recounted");
        assert!(entry.groups.is_empty(), "fallback never carries pos groups");
        let summary = entry.fallback_summary.expect("fallback should summarize");
        assert!(summary.ends_with('…'));
        assert!(summary.chars().count() <= FALLBACK_SUMMARY_CHARS + 1);
    }

    #[test]
    fn merge_prefers_jsonapi_and_ignores_fallback_on_success() {
        let entry = DictionaryEntry {
            word: "bank".to_string(),
            phonetic: Some("bæŋk".to_string()),
            groups: vec![DictionaryGroup { pos: "n.".to_string(), senses: "银行".to_string() }],
            omitted_sense_count: 0,
            fallback_summary: None,
        };
        let result = merge_lookup_outcome(Ok(Some(entry.clone())), "bank", None);
        assert_eq!(result.unwrap().word, entry.word);
    }

    #[test]
    fn merge_treats_a_genuine_not_found_as_final_and_never_falls_back() {
        // A fallback is deliberately supplied here to prove it is ignored:
        // jsonapi succeeding with "no entry" is not a fallback trigger.
        let result = merge_lookup_outcome(
            Ok(None),
            "asdfqwerzz",
            Some(Ok("some suggest gloss".to_string())),
        );
        assert_eq!(result.unwrap_err(), ERR_NOT_FOUND);
    }

    #[test]
    fn merge_falls_back_to_suggest_on_jsonapi_parse_failure() {
        let result = merge_lookup_outcome(Err(()), "recounted", Some(Ok("详述，叙述".to_string())));
        let entry = result.expect("fallback success should still resolve");
        assert_eq!(entry.word, "recounted");
        assert!(entry.groups.is_empty());
        assert_eq!(entry.fallback_summary.as_deref(), Some("详述，叙述"));
    }

    #[test]
    fn merge_surfaces_the_fallbacks_own_error_when_both_fail() {
        let result = merge_lookup_outcome(
            Err(()),
            "zxqwvbnm",
            Some(Err(AppError::Other(ERR_NOT_FOUND.to_string()))),
        );
        assert_eq!(result.unwrap_err(), ERR_NOT_FOUND);
    }

    #[test]
    fn merge_without_a_fallback_attempt_reports_unavailable() {
        let result = merge_lookup_outcome(Err(()), "bank", None);
        assert_eq!(result.unwrap_err(), ERR_UNAVAILABLE);
    }

    #[tokio::test]
    #[ignore = "requires network"]
    async fn live_jsonapi_lookup_resolves_bank() {
        let entry = jsonapi_lookup("bank").await.unwrap().expect("bank should resolve");
        assert_eq!(entry.phonetic.as_deref(), Some("bæŋk"));
        assert!(!entry.groups.is_empty());
    }

    #[tokio::test]
    #[ignore = "requires network"]
    async fn live_jsonapi_lookup_of_a_non_word_is_a_genuine_not_found() {
        let outcome = jsonapi_lookup("asdfqwerzz").await.unwrap();
        assert!(outcome.is_none());
    }
}

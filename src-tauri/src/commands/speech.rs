//! Dictionary pronunciation audio with an on-disk cache.
//!
//! Youdao's `dictvoice` is a dictionary-entry lookup, not a synthesizer: entries
//! return recorded (or, for rare words, synthesized) audio, and anything else
//! returns HTTP 500 `returned null audio`. Hits cannot be predicted from the
//! text — a 19-character non-entry fails while a 17-character idiom succeeds —
//! so the frontend tries this source and falls back to system voices. Misses are
//! cached so the second attempt at the same text falls back instantly.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::ipc::Response;
use tauri::State;

use crate::db::Db;
use crate::error::{AppError, AppResult};

const DICTIONARY_ENDPOINT: &str = "https://dict.youdao.com/dictvoice";
const SOURCE_ID: &str = "youdao";
const CACHE_DIR_NAME: &str = "speech-cache";
const AUDIO_EXTENSION: &str = "bin";
const MISS_EXTENSION: &str = "miss";

/// Clips measure 14–60 KB as MP3 and up to ~171 KB as WAV, so 2 GiB holds
/// roughly 50k of them. The ceiling bounds pathological growth; it is not there
/// to reclaim space. Dropping a cached clip means a word that used to play no
/// longer does, which is a worse failure than the disk cost.
const CACHE_LIMIT_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Evicting down to exactly the limit would re-trigger on the very next write.
const CACHE_TARGET_BYTES: u64 = CACHE_LIMIT_BYTES / 10 * 9;

/// Guards against sending whole paragraphs. It is deliberately not a hit
/// predictor — length does not correlate with whether the corpus has an entry.
const MAX_TEXT_CHARS: usize = 64;
const MAX_AUDIO_BYTES: usize = 4 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// A miss is usually permanent, but the corpus does grow, so they expire.
const MISS_TTL: Duration = Duration::from_secs(30 * 24 * 60 * 60);

/// The source has no audio for this text. Cached; callers fall back silently.
const ERR_NOT_IN_DICTIONARY: &str = "SPEECH_NOT_IN_DICTIONARY";
/// Transport failure. Never cached, since it says nothing about the text.
const ERR_SOURCE_UNAVAILABLE: &str = "SPEECH_SOURCE_UNAVAILABLE";
const ERR_TEXT_INVALID: &str = "SPEECH_TEXT_INVALID";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Accent {
    Uk,
    Us,
}

impl Accent {
    fn parse(value: &str) -> AppResult<Self> {
        match value {
            "uk" => Ok(Self::Uk),
            "us" => Ok(Self::Us),
            _ => Err(AppError::Other(ERR_TEXT_INVALID.to_string())),
        }
    }

    /// Youdao's `type` parameter: 1 is British, 2 is American.
    fn query_value(self) -> &'static str {
        match self {
            Self::Uk => "1",
            Self::Us => "2",
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Uk => "uk",
            Self::Us => "us",
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechCacheStats {
    pub bytes: u64,
    pub entries: u64,
    pub limit_bytes: u64,
}

fn cache_dir() -> PathBuf {
    crate::resolve_app_data_dir().join(CACHE_DIR_NAME)
}

/// Collapses internal whitespace so `"look  up"` and `"look up"` share a cache
/// entry, and so the request never carries newlines from a multi-line selection.
fn normalize_text(text: &str) -> AppResult<String> {
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() || normalized.chars().count() > MAX_TEXT_CHARS {
        return Err(AppError::Other(ERR_TEXT_INVALID.to_string()));
    }
    Ok(normalized)
}

fn cache_stem(accent: Accent, text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(SOURCE_ID.as_bytes());
    hasher.update([0]);
    hasher.update(accent.as_str().as_bytes());
    hasher.update([0]);
    hasher.update(text.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Running total, so the hot path does not walk a 50k-entry directory on every
/// playback. Seeded by one scan the first time it is needed.
fn cache_total() -> &'static Mutex<u64> {
    static TOTAL: OnceLock<Mutex<u64>> = OnceLock::new();
    TOTAL.get_or_init(|| Mutex::new(scan_cache().map(|stats| stats.0).unwrap_or(0)))
}

/// Returns `(bytes, entries)` for audio files only — `.miss` markers are empty.
fn scan_cache() -> AppResult<(u64, u64)> {
    let dir = cache_dir();
    if !dir.exists() {
        return Ok((0, 0));
    }
    let mut bytes = 0u64;
    let mut entries = 0u64;
    for entry in fs::read_dir(&dir)? {
        let entry = entry?;
        if entry.path().extension().and_then(|value| value.to_str()) != Some(AUDIO_EXTENSION) {
            continue;
        }
        if let Ok(metadata) = entry.metadata() {
            bytes += metadata.len();
            entries += 1;
        }
    }
    Ok((bytes, entries))
}

/// Refreshes the mtime so eviction can treat it as a last-used timestamp.
/// Playback must not fail because a touch did, so errors are dropped.
fn touch(path: &Path) {
    if let Ok(file) = fs::OpenOptions::new().write(true).open(path) {
        let _ = file.set_modified(SystemTime::now());
    }
}

/// Every distinct word in the vocabulary list, in both accents. These are never
/// evicted: the saved-words list staying playable offline is the whole point of
/// keeping audio on disk.
fn pinned_stems(db: &Db) -> HashSet<String> {
    let mut pinned = HashSet::new();
    let conn = db.reader();
    let Ok(mut statement) = conn.prepare("SELECT DISTINCT word FROM vocab_words") else {
        return pinned;
    };
    let Ok(rows) = statement.query_map([], |row| row.get::<_, String>(0)) else {
        return pinned;
    };
    for word in rows.flatten() {
        let Ok(normalized) = normalize_text(&word) else {
            continue;
        };
        pinned.insert(cache_stem(Accent::Uk, &normalized));
        pinned.insert(cache_stem(Accent::Us, &normalized));
    }
    pinned
}

/// Drops least-recently-used unpinned clips until the cache is back under
/// `CACHE_TARGET_BYTES`. Returns the resulting total.
fn evict(pinned: &HashSet<String>) -> AppResult<u64> {
    let dir = cache_dir();
    let mut total = 0u64;
    let mut candidates: Vec<(SystemTime, u64, PathBuf)> = Vec::new();
    for entry in fs::read_dir(&dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some(AUDIO_EXTENSION) {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        total += metadata.len();
        let stem = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if pinned.contains(stem) {
            continue;
        }
        let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        candidates.push((modified, metadata.len(), path));
    }

    candidates.sort_by_key(|(modified, _, _)| *modified);
    for (_, size, path) in candidates {
        if total <= CACHE_TARGET_BYTES {
            break;
        }
        if fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(size);
        }
    }
    Ok(total)
}

async fn fetch_remote(text: &str, accent: Accent) -> AppResult<Vec<u8>> {
    let response = crate::ai::http_client()
        .get(DICTIONARY_ENDPOINT)
        .query(&[("audio", text), ("type", accent.query_value())])
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|_| AppError::Other(ERR_SOURCE_UNAVAILABLE.to_string()))?;

    let status = response.status();
    if status.is_server_error() {
        // `returned null audio` — the corpus has no entry for this text.
        return Err(AppError::Other(ERR_NOT_IN_DICTIONARY.to_string()));
    }
    if !status.is_success() {
        return Err(AppError::Other(ERR_SOURCE_UNAVAILABLE.to_string()));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|_| AppError::Other(ERR_SOURCE_UNAVAILABLE.to_string()))?;
    if bytes.is_empty() {
        return Err(AppError::Other(ERR_NOT_IN_DICTIONARY.to_string()));
    }
    if bytes.len() > MAX_AUDIO_BYTES {
        return Err(AppError::Other(ERR_SOURCE_UNAVAILABLE.to_string()));
    }
    Ok(bytes.to_vec())
}

/// Returns the audio plus whether it came from disk, so the caller knows if the
/// cache grew. Split from the command so it can be exercised without a Tauri
/// app handle.
async fn dictionary_audio_cached(
    dir: &Path,
    text: &str,
    accent: Accent,
) -> AppResult<(Vec<u8>, bool)> {
    let stem = cache_stem(accent, text);
    let audio_path = dir.join(format!("{stem}.{AUDIO_EXTENSION}"));
    let miss_path = dir.join(format!("{stem}.{MISS_EXTENSION}"));

    if let Ok(cached) = fs::read(&audio_path) {
        if !cached.is_empty() {
            touch(&audio_path);
            return Ok((cached, true));
        }
    }

    if let Ok(metadata) = fs::metadata(&miss_path) {
        let fresh = metadata
            .modified()
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .map(|age| age < MISS_TTL)
            .unwrap_or(false);
        if fresh {
            return Err(AppError::Other(ERR_NOT_IN_DICTIONARY.to_string()));
        }
        let _ = fs::remove_file(&miss_path);
    }

    let audio = match fetch_remote(text, accent).await {
        Ok(audio) => audio,
        Err(error) => {
            if error.to_string() == ERR_NOT_IN_DICTIONARY {
                let _ = fs::create_dir_all(dir);
                let _ = fs::write(&miss_path, []);
            }
            return Err(error);
        }
    };

    fs::create_dir_all(dir)?;
    // A partial write would poison the cache, so land it under a temporary name.
    let staging = dir.join(format!("{stem}.partial"));
    if !(fs::write(&staging, &audio).is_ok() && fs::rename(&staging, &audio_path).is_ok()) {
        let _ = fs::remove_file(&staging);
    }

    Ok((audio, false))
}

/// Raw bytes rather than a serialized struct: a `Vec<u8>` crosses the IPC
/// boundary as a JSON number array, which costs roughly 4x for a 170 KB clip.
/// The frontend sniffs the container from the magic bytes — the endpoint labels
/// WAV responses `audio/mpeg`, so the header cannot be trusted anyway.
#[tauri::command]
pub async fn speech_dictionary_audio(
    text: String,
    accent: String,
    db: State<'_, Db>,
) -> AppResult<Response> {
    let accent = Accent::parse(&accent)?;
    let text = normalize_text(&text)?;
    let dir = cache_dir();
    let (audio, cached) = dictionary_audio_cached(&dir, &text, accent).await?;

    if !cached {
        let over_limit = {
            let mut total = cache_total().lock().expect("speech cache total mutex");
            *total = total.saturating_add(audio.len() as u64);
            *total > CACHE_LIMIT_BYTES
        };
        if over_limit {
            let pinned = pinned_stems(&db);
            if let Ok(remaining) = evict(&pinned) {
                *cache_total().lock().expect("speech cache total mutex") = remaining;
            }
        }
    }

    Ok(Response::new(audio))
}

#[tauri::command]
pub fn speech_cache_stats() -> AppResult<SpeechCacheStats> {
    let (bytes, entries) = scan_cache()?;
    *cache_total().lock().expect("speech cache total mutex") = bytes;
    Ok(SpeechCacheStats {
        bytes,
        entries,
        limit_bytes: CACHE_LIMIT_BYTES,
    })
}

#[tauri::command]
pub fn speech_cache_clear() -> AppResult<SpeechCacheStats> {
    let dir = cache_dir();
    if dir.exists() {
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.is_file() {
                let _ = fs::remove_file(&path);
            }
        }
    }
    *cache_total().lock().expect("speech cache total mutex") = 0;
    Ok(SpeechCacheStats {
        bytes: 0,
        entries: 0,
        limit_bytes: CACHE_LIMIT_BYTES,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accent_maps_to_youdao_type_parameter() {
        assert_eq!(Accent::parse("uk").unwrap().query_value(), "1");
        assert_eq!(Accent::parse("us").unwrap().query_value(), "2");
        assert!(Accent::parse("au").is_err());
    }

    #[test]
    fn normalize_collapses_whitespace() {
        assert_eq!(normalize_text("  look   up \n").unwrap(), "look up");
    }

    #[test]
    fn normalize_rejects_empty_and_overlong_text() {
        assert!(normalize_text("   ").is_err());
        assert!(normalize_text(&"a".repeat(MAX_TEXT_CHARS + 1)).is_err());
        assert!(normalize_text(&"a".repeat(MAX_TEXT_CHARS)).is_ok());
    }

    #[test]
    fn cache_stem_separates_accents_and_texts() {
        let uk = cache_stem(Accent::Uk, "schedule");
        let us = cache_stem(Accent::Us, "schedule");
        assert_ne!(uk, us);
        assert_ne!(us, cache_stem(Accent::Us, "scheduled"));
        // Stable across calls, so a cached clip is found again.
        assert_eq!(uk, cache_stem(Accent::Uk, "schedule"));
    }

    #[test]
    fn cache_stem_is_filename_safe() {
        let stem = cache_stem(Accent::Us, "a piece of cake");
        assert_eq!(stem.len(), 64);
        assert!(stem.chars().all(|c| c.is_ascii_hexdigit()));
    }

    // The tests below reach the live Youdao endpoint, so they are excluded from
    // the default run and from CI. Run them with
    // `cargo test --lib commands::speech -- --ignored` when touching the cache
    // or the request shape.

    #[tokio::test]
    #[ignore = "requires network"]
    async fn live_audio_is_fetched_then_served_from_disk() {
        let dir = tempfile::tempdir().unwrap();
        let (fetched, cached) = dictionary_audio_cached(dir.path(), "pronunciation", Accent::Us)
            .await
            .unwrap();
        assert!(!cached, "first call must go to the network");
        assert!(fetched.len() > 1024, "got {} bytes", fetched.len());

        let stem = cache_stem(Accent::Us, "pronunciation");
        assert!(dir.path().join(format!("{stem}.{AUDIO_EXTENSION}")).exists());

        let (replayed, cached) = dictionary_audio_cached(dir.path(), "pronunciation", Accent::Us)
            .await
            .unwrap();
        assert!(cached, "second call must be served from disk");
        assert_eq!(fetched, replayed);
    }

    #[tokio::test]
    #[ignore = "requires network"]
    async fn live_non_entry_is_remembered_as_a_miss() {
        let dir = tempfile::tempdir().unwrap();
        let error = dictionary_audio_cached(dir.path(), "zxqwvbnm", Accent::Us)
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), ERR_NOT_IN_DICTIONARY);

        let stem = cache_stem(Accent::Us, "zxqwvbnm");
        let miss = dir.path().join(format!("{stem}.{MISS_EXTENSION}"));
        assert!(miss.exists(), "a miss must be cached so the retry is instant");

        // Served from the marker rather than a second round trip.
        let error = dictionary_audio_cached(dir.path(), "zxqwvbnm", Accent::Us)
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), ERR_NOT_IN_DICTIONARY);
    }

    /// The point of the whole feature: the accent toggle must produce genuinely
    /// different audio, not the same clip relabelled.
    #[tokio::test]
    #[ignore = "requires network"]
    async fn live_uk_and_us_audio_differ() {
        let dir = tempfile::tempdir().unwrap();
        let (uk, _) = dictionary_audio_cached(dir.path(), "schedule", Accent::Uk)
            .await
            .unwrap();
        let (us, _) = dictionary_audio_cached(dir.path(), "schedule", Accent::Us)
            .await
            .unwrap();
        assert!(!uk.is_empty() && !us.is_empty());
        assert_ne!(uk, us);
    }
}

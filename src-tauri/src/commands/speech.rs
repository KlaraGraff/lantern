//! Pronunciation audio from three network sources, sharing one on-disk cache.
//!
//! Youdao's `dictvoice` is a dictionary-entry lookup, not a synthesizer: entries
//! return recorded (or, for rare words, synthesized) audio, and anything else
//! returns HTTP 500 `returned null audio`. Hits cannot be predicted from the
//! text — a 19-character non-entry fails while a 17-character idiom succeeds —
//! so the frontend tries this source and falls back to system voices. Misses are
//! cached so the second attempt at the same text falls back instantly.
//!
//! The custom source posts to any OpenAI-compatible `/audio/speech` endpoint. It
//! is metered, so it is only ever used when the user has explicitly selected it;
//! the dictionary never escalates to it as a fallback.
//!
//! The Edge source drives the same neural voices Edge's Read aloud uses, over
//! Microsoft's unofficial WebSocket protocol. It is free and needs no setup, but
//! it is not a supported API: the endpoint can change or start refusing requests
//! without notice. That is survivable only because it is opt-in and every
//! failure falls back to system voices, so the worst outcome is a robotic voice
//! rather than an error.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::ipc::Response;
use tauri::State;

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::secrets::Secrets;

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

/// Guards against sending whole paragraphs to the dictionary. It is deliberately
/// not a hit predictor — length does not correlate with whether the corpus has
/// an entry.
const MAX_DICTIONARY_TEXT_CHARS: usize = 64;
/// A real synthesizer can read a passage. Well under the 4096 most
/// OpenAI-compatible endpoints accept, and it bounds the per-play cost.
const MAX_SYNTHESIZER_TEXT_CHARS: usize = 2000;
/// Longest text worth keeping on disk from a free synthesizer.
///
/// A word clip is 15–30 KB; a 2000-character passage is roughly 800 KB, so one
/// passage costs what twenty-five vocabulary words do while being far less
/// likely to be played again. Vocabulary-sized clips are the ones replayed for
/// review and the ones that have to work offline, so they are what the cache is
/// for.
///
/// Deliberately its own constant rather than reusing `MAX_DICTIONARY_TEXT_CHARS`:
/// that one answers "what will Youdao accept", this one answers "is this
/// vocabulary-sized", and the two may want to diverge.
const MAX_CACHEABLE_TEXT_CHARS: usize = 64;
const MAX_AUDIO_BYTES: usize = 4 * 1024 * 1024;
/// How much of an untrusted error body is scanned for the voice list. Providers
/// name their voices in the first line; anything past this is not a list.
const MAX_ERROR_BODY_CHARS: usize = 4096;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// Synthesizing a passage legitimately takes longer than fetching a clip.
const CUSTOM_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// `synthesize` reads until the service says the turn ended, with no deadline of
/// its own, so a stalled socket would hang the request forever. Shorter than the
/// custom timeout because this is a live stream, not a request that may queue.
const EDGE_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// A miss is usually permanent, but the corpus does grow, so they expire.
const MISS_TTL: Duration = Duration::from_secs(30 * 24 * 60 * 60);

/// Neural voices for the two accents Lantern offers. Fixed rather than
/// configurable: the source's whole appeal is that it works with no setup, and
/// these are the voices Edge itself defaults to for en-GB and en-US.
const EDGE_VOICE_UK: &str = "en-GB-SoniaNeural";
const EDGE_VOICE_US: &str = "en-US-AriaNeural";
/// MP3, which the frontend sniffs from the magic bytes. The service also offers
/// higher bit rates, but 48 kbit/s mono is what Read aloud itself requests and
/// it is transparent for speech.
const EDGE_AUDIO_FORMAT: &str = "audio-24khz-48kbitrate-mono-mp3";

const CUSTOM_KEY_SECRET: &str = "tts_api_key";
const CUSTOM_BASE_URL_SETTING: &str = "tts_base_url";
const CUSTOM_MODEL_SETTING: &str = "tts_model";
const CUSTOM_VOICE_UK_SETTING: &str = "tts_voice_uk";
const CUSTOM_VOICE_US_SETTING: &str = "tts_voice_us";
const CUSTOM_SPEED_SETTING: &str = "tts_speed";
const CUSTOM_CACHE_PASSAGES_SETTING: &str = "tts_cache_passages";
/// The range OpenAI-compatible speech endpoints accept for `speed`.
const CUSTOM_SPEED_RANGE: (f64, f64) = (0.25, 4.0);

/// The source has no audio for this text. Cached; callers fall back silently.
const ERR_NOT_IN_DICTIONARY: &str = "SPEECH_NOT_IN_DICTIONARY";
/// Transport failure. Never cached, since it says nothing about the text.
const ERR_SOURCE_UNAVAILABLE: &str = "SPEECH_SOURCE_UNAVAILABLE";
const ERR_TEXT_INVALID: &str = "SPEECH_TEXT_INVALID";
/// Base URL, model, voice or key missing. Distinct from a transport failure so
/// the UI can point at settings instead of blaming the network.
const ERR_CUSTOM_NOT_CONFIGURED: &str = "SPEECH_CUSTOM_NOT_CONFIGURED";

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

    fn edge_voice(self) -> &'static str {
        match self {
            Self::Uk => EDGE_VOICE_UK,
            Self::Us => EDGE_VOICE_US,
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
fn normalize_text(text: &str, max_chars: usize) -> AppResult<String> {
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() || normalized.chars().count() > max_chars {
        return Err(AppError::Other(ERR_TEXT_INVALID.to_string()));
    }
    Ok(normalized)
}

/// Everything that changes how a clip sounds. Folding the provider settings in
/// means switching voice or model serves fresh audio instead of a stale clip,
/// and the two sources cannot collide in the shared cache directory.
struct SourceIdentity(String);

impl SourceIdentity {
    fn dictionary(accent: Accent) -> Self {
        Self(format!("{SOURCE_ID}|{}", accent.as_str()))
    }

    /// Keyed by the voice rather than the accent, so changing which voice an
    /// accent maps to serves fresh audio instead of the previous voice's clips.
    fn edge(accent: Accent) -> Self {
        Self(format!("edge|{}", accent.edge_voice()))
    }

    fn custom(config: &CustomConfig, accent: Accent) -> Self {
        // Speed belongs here: the provider bakes it into the audio, so two
        // speeds are two different clips rather than one clip played back
        // differently.
        Self(format!(
            "openai|{}|{}|{}|{:.2}",
            config.base_url,
            config.model,
            config.voice(accent),
            config.speed,
        ))
    }
}

fn cache_stem(identity: &SourceIdentity, text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(identity.0.as_bytes());
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

/// Every distinct word in the vocabulary list, under every source and accent
/// currently in play. These are never evicted: the saved-words list staying
/// playable offline is the whole point of keeping audio on disk.
fn pinned_stems(db: &Db, custom: Option<&CustomConfig>) -> HashSet<String> {
    let mut pinned = HashSet::new();
    let conn = db.reader();
    let Ok(mut statement) = conn.prepare("SELECT DISTINCT word FROM vocab_words") else {
        return pinned;
    };
    let Ok(rows) = statement.query_map([], |row| row.get::<_, String>(0)) else {
        return pinned;
    };
    let identities: Vec<SourceIdentity> = [Accent::Uk, Accent::Us]
        .into_iter()
        .flat_map(|accent| {
            // The keyless sources are always pinned: they cost nothing to name,
            // and which one is selected today says nothing about which clips are
            // worth keeping.
            let mut entries = vec![
                SourceIdentity::dictionary(accent),
                SourceIdentity::edge(accent),
            ];
            if let Some(config) = custom {
                entries.push(SourceIdentity::custom(config, accent));
            }
            entries
        })
        .collect();

    for word in rows.flatten() {
        let Ok(normalized) = normalize_text(&word, MAX_DICTIONARY_TEXT_CHARS) else {
            continue;
        };
        for identity in &identities {
            pinned.insert(cache_stem(identity, &normalized));
        }
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

/// Provider settings for the OpenAI-compatible source. The key lives in the
/// secrets store, never in the settings table.
struct CustomConfig {
    base_url: String,
    model: String,
    voice_uk: String,
    voice_us: String,
    speed: f64,
    api_key: String,
    /// Whether passage-length audio from this provider is kept on disk.
    /// Deliberately absent from `SourceIdentity`: it decides whether a clip is
    /// written, not how it sounds, so flipping it must not orphan what is
    /// already cached.
    cache_passages: bool,
}

impl CustomConfig {
    fn voice(&self, accent: Accent) -> &str {
        match accent {
            Accent::Uk => &self.voice_uk,
            Accent::Us => &self.voice_us,
        }
    }

    /// `https://api.openai.com/v1` and `https://api.openai.com/v1/` must behave
    /// the same, and a pasted full endpoint should not become `/audio/speech/audio/speech`.
    fn endpoint(&self) -> String {
        let base = self.base_url.trim_end_matches('/');
        if base.ends_with("/audio/speech") {
            base.to_string()
        } else {
            format!("{base}/audio/speech")
        }
    }
}

/// The endpoint a voice hint belongs to. The base URL field accepts both a
/// service root and a pasted full endpoint, and those must not become two
/// different keys for the same service.
fn voice_hint_key(base_url: &str) -> String {
    base_url
        .trim()
        .trim_end_matches('/')
        .trim_end_matches("/audio/speech")
        .trim_end_matches('/')
        .to_string()
}

/// Voice names one endpoint reported, and when it told us.
#[derive(Debug, Default, Serialize)]
pub struct SpeechVoiceHints {
    pub options: Vec<String>,
    pub updated_at: Option<i64>,
}

/// The endpoint the voice fields currently point at, or `None` while the base
/// URL or model is still blank.
fn configured_endpoint(db: &Db) -> Option<(String, String)> {
    let read = |key: &str| -> Option<String> {
        db.reader()
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![key],
                |row| row.get::<_, String>(0),
            )
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };
    Some((
        voice_hint_key(&read(CUSTOM_BASE_URL_SETTING)?),
        read(CUSTOM_MODEL_SETTING)?,
    ))
}

fn store_voice_hints(db: &Db, base_url: &str, model: &str, options: &[String]) {
    let Ok(payload) = serde_json::to_string(options) else {
        return;
    };
    let Ok(conn) = db.conn.lock() else {
        return;
    };
    let _ = conn.execute(
        "INSERT INTO speech_voice_hints (base_url, model, options, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(base_url, model) DO UPDATE SET options = ?3, updated_at = ?4",
        params![base_url, model, payload, now_ms()],
    );
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

fn load_custom_config(db: &Db, secrets: &Secrets) -> AppResult<CustomConfig> {
    let read = |key: &str| -> Option<String> {
        let conn = db.reader();
        conn.query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    };

    let base_url = read(CUSTOM_BASE_URL_SETTING);
    let model = read(CUSTOM_MODEL_SETTING);
    let voice_us = read(CUSTOM_VOICE_US_SETTING);
    // A single-voice provider is normal, so British falls back to the American
    // voice rather than refusing to play.
    let voice_uk = read(CUSTOM_VOICE_UK_SETTING).or_else(|| voice_us.clone());
    let speed = read(CUSTOM_SPEED_SETTING)
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite())
        .map(|value| value.clamp(CUSTOM_SPEED_RANGE.0, CUSTOM_SPEED_RANGE.1))
        .unwrap_or(1.0);
    // Only an explicit "false" opts out, so an unwritten key keeps the default
    // rather than reading as disabled.
    let cache_passages = read(CUSTOM_CACHE_PASSAGES_SETTING)
        .map(|value| value != "false")
        .unwrap_or(true);
    let api_key = secrets
        .get(CUSTOM_KEY_SECRET)?
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    match (base_url, model, voice_uk, voice_us, api_key) {
        (Some(base_url), Some(model), Some(voice_uk), Some(voice_us), Some(api_key)) => {
            Ok(CustomConfig {
                base_url,
                model,
                voice_uk,
                voice_us,
                speed,
                api_key,
                cache_passages,
            })
        }
        _ => Err(AppError::Other(ERR_CUSTOM_NOT_CONFIGURED.to_string())),
    }
}

async fn fetch_custom(
    text: &str,
    accent: Accent,
    config: &CustomConfig,
    db: &Db,
) -> AppResult<Vec<u8>> {
    let response = crate::ai::http_client()
        .post(config.endpoint())
        .bearer_auth(&config.api_key)
        .json(&serde_json::json!({
            "model": config.model,
            "input": text,
            "voice": config.voice(accent),
            "response_format": "mp3",
            "speed": config.speed,
        }))
        .timeout(CUSTOM_REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|_| AppError::Other(ERR_SOURCE_UNAVAILABLE.to_string()))?;

    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(AppError::Other(ERR_CUSTOM_NOT_CONFIGURED.to_string()));
    }
    if !status.is_success() {
        // A rejected voice is the only moment an OpenAI-compatible endpoint ever
        // names the voices it has, so read the body even though the request is
        // lost either way. Bounded because the body is untrusted.
        if status.is_client_error() {
            if let Ok(body) = response.text().await {
                let body: String = body.chars().take(MAX_ERROR_BODY_CHARS).collect();
                let options = crate::ai::router::parse_supported_values(&body);
                if !options.is_empty() {
                    store_voice_hints(
                        db,
                        &voice_hint_key(&config.base_url),
                        &config.model,
                        &options,
                    );
                }
            }
        }
        return Err(AppError::Other(ERR_SOURCE_UNAVAILABLE.to_string()));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|_| AppError::Other(ERR_SOURCE_UNAVAILABLE.to_string()))?;
    if bytes.is_empty() || bytes.len() > MAX_AUDIO_BYTES {
        return Err(AppError::Other(ERR_SOURCE_UNAVAILABLE.to_string()));
    }
    Ok(bytes.to_vec())
}

/// The Edge protocol carries the text inside an SSML document that the client
/// crate builds by interpolation, so an unescaped `&` or `<` — ordinary in book
/// text — would produce a malformed document the service rejects, or let the
/// text close the `<prosody>` element and inject markup of its own.
fn escape_ssml(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for character in text.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            _ => escaped.push(character),
        }
    }
    escaped
}

/// When each word is spoken, so the reader can follow the audio sentence by
/// sentence. Milliseconds rather than the service's 100-nanosecond ticks: the
/// only consumer compares them against an audio element's `currentTime`.
#[derive(Debug, Serialize, serde::Deserialize, PartialEq)]
struct WordTiming {
    text: String,
    #[serde(rename = "offsetMs")]
    offset_ms: u64,
    #[serde(rename = "durationMs")]
    duration_ms: u64,
}

/// The service reports offsets in 100-nanosecond ticks.
const TICKS_PER_MS: u64 = 10_000;

/// Packs timings and audio into the one byte string the command returns: a
/// four-byte big-endian header length, that many bytes of JSON, then the audio.
///
/// One payload rather than two fields because audio has to cross the IPC
/// boundary as raw bytes — a `Vec<u8>` serialized into a JSON number array costs
/// roughly four times as much — and raw bytes cannot be a field of an object.
fn frame_audio(timings: &[WordTiming], audio: &[u8]) -> AppResult<Vec<u8>> {
    let header = serde_json::to_vec(timings).unwrap_or_else(|_| b"[]".to_vec());
    let mut framed = Vec::with_capacity(4 + header.len() + audio.len());
    framed.extend_from_slice(&(header.len() as u32).to_be_bytes());
    framed.extend_from_slice(&header);
    framed.extend_from_slice(audio);
    Ok(framed)
}

/// One connection per clip. Pooling would save a handshake, but a cached clip
/// never reaches this function at all, so the connection would sit idle far more
/// often than it would be reused.
async fn fetch_edge(text: &str, accent: Accent) -> AppResult<Vec<u8>> {
    use msedge_tts::tts::{client::tokio_runtime::connect_async, SpeechConfig};

    let config = SpeechConfig {
        voice_name: accent.edge_voice().to_string(),
        audio_format: EDGE_AUDIO_FORMAT.to_string(),
        // The rate slider drives system voices only, as with the dictionary's
        // recordings; baking a speed into cached audio would make every slider
        // nudge a separate cache entry.
        pitch: 0,
        rate: 0,
        volume: 0,
    };
    let ssml_text = escape_ssml(text);

    let audio = tokio::time::timeout(EDGE_REQUEST_TIMEOUT, async {
        let mut client = connect_async().await?;
        client.synthesize(&ssml_text, &config).await
    })
    .await
    // A refused handshake is how this source dies for good — either a protocol
    // change or a region block — and it is indistinguishable here from the
    // network being down. Both mean the same thing to the caller: fall back.
    .map_err(|_| AppError::Other(ERR_SOURCE_UNAVAILABLE.to_string()))?
    .map_err(|_| AppError::Other(ERR_SOURCE_UNAVAILABLE.to_string()))?;

    if audio.audio_bytes.is_empty() || audio.audio_bytes.len() > MAX_AUDIO_BYTES {
        return Err(AppError::Other(ERR_SOURCE_UNAVAILABLE.to_string()));
    }

    // The service sends one entry per word; anything without text is not one.
    let timings: Vec<WordTiming> = audio
        .audio_metadata
        .iter()
        .filter_map(|entry| {
            entry.text.as_ref().map(|text| WordTiming {
                text: text.clone(),
                offset_ms: entry.offset / TICKS_PER_MS,
                duration_ms: entry.duration / TICKS_PER_MS,
            })
        })
        .collect();

    frame_audio(&timings, &audio.audio_bytes)
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
/// cache grew. Split from the commands so it can be exercised without a Tauri
/// app handle.
async fn cached_audio<Fut>(
    dir: &Path,
    identity: &SourceIdentity,
    text: &str,
    store: bool,
    fetch: impl FnOnce() -> Fut,
) -> AppResult<(Vec<u8>, bool)>
where
    Fut: std::future::Future<Output = AppResult<Vec<u8>>>,
{
    let stem = cache_stem(identity, text);
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

    let audio = match fetch().await {
        Ok(audio) => audio,
        Err(error) => {
            // Only the dictionary reports "no audio for this text"; a metered
            // synthesizer failing says nothing worth remembering.
            if error.to_string() == ERR_NOT_IN_DICTIONARY {
                let _ = fs::create_dir_all(dir);
                let _ = fs::write(&miss_path, []);
            }
            return Err(error);
        }
    };

    if !store {
        return Ok((audio, false));
    }

    fs::create_dir_all(dir)?;
    // A partial write would poison the cache, so land it under a temporary name.
    let staging = dir.join(format!("{stem}.partial"));
    if !(fs::write(&staging, &audio).is_ok() && fs::rename(&staging, &audio_path).is_ok()) {
        let _ = fs::remove_file(&staging);
    }

    Ok((audio, false))
}

/// Whether this text is the sort the cache exists for: a word or phrase, the
/// kind that gets replayed during review and has to work offline.
fn is_vocabulary_sized(text: &str) -> bool {
    text.chars().count() <= MAX_CACHEABLE_TEXT_CHARS
}

async fn dictionary_audio_cached(
    dir: &Path,
    text: &str,
    accent: Accent,
) -> AppResult<(Vec<u8>, bool)> {
    let identity = SourceIdentity::dictionary(accent);
    // Its input is capped below the cacheable size, so this is always true; it
    // is spelled out rather than passed as `true` so the rule reads the same at
    // all three call sites.
    let store = is_vocabulary_sized(text);
    cached_audio(dir, &identity, text, store, || fetch_remote(text, accent)).await
}

async fn edge_audio_cached(dir: &Path, text: &str, accent: Accent) -> AppResult<(Vec<u8>, bool)> {
    let identity = SourceIdentity::edge(accent);
    cached_audio(dir, &identity, text, is_vocabulary_sized(text), || {
        fetch_edge(text, accent)
    })
    .await
}

async fn custom_audio_cached(
    dir: &Path,
    text: &str,
    accent: Accent,
    config: &CustomConfig,
    db: &Db,
) -> AppResult<(Vec<u8>, bool)> {
    let identity = SourceIdentity::custom(config, accent);
    // The paid provider keeps passages by default: disk has a ceiling, eviction
    // and a clear button, while re-synthesizing bills the user a second time for
    // text they already paid for. Only an explicit opt-out narrows it to the
    // same vocabulary-sized rule the free sources follow.
    let store = config.cache_passages || is_vocabulary_sized(text);
    cached_audio(dir, &identity, text, store, || {
        fetch_custom(text, accent, config, db)
    })
    .await
}

/// Records a freshly written clip against the size ceiling, evicting only when
/// the cache actually exceeds it — which at 2 GiB is effectively never.
fn note_cache_growth(db: &Db, custom: Option<&CustomConfig>, added: usize) {
    let over_limit = {
        let mut total = cache_total().lock().expect("speech cache total mutex");
        *total = total.saturating_add(added as u64);
        *total > CACHE_LIMIT_BYTES
    };
    if !over_limit {
        return;
    }
    let pinned = pinned_stems(db, custom);
    if let Ok(remaining) = evict(&pinned) {
        *cache_total().lock().expect("speech cache total mutex") = remaining;
    }
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
    let text = normalize_text(&text, MAX_DICTIONARY_TEXT_CHARS)?;
    let dir = cache_dir();
    let (audio, cached) = dictionary_audio_cached(&dir, &text, accent).await?;
    if !cached {
        note_cache_growth(&db, None, audio.len());
    }
    Ok(Response::new(audio))
}

#[tauri::command]
pub async fn speech_edge_audio(
    text: String,
    accent: String,
    db: State<'_, Db>,
) -> AppResult<Response> {
    let accent = Accent::parse(&accent)?;
    let text = normalize_text(&text, MAX_SYNTHESIZER_TEXT_CHARS)?;
    let dir = cache_dir();
    let (audio, cached) = edge_audio_cached(&dir, &text, accent).await?;
    if !cached {
        note_cache_growth(&db, None, audio.len());
    }
    Ok(Response::new(audio))
}

#[tauri::command]
pub async fn speech_custom_audio(
    text: String,
    accent: String,
    db: State<'_, Db>,
    secrets: State<'_, Secrets>,
) -> AppResult<Response> {
    let accent = Accent::parse(&accent)?;
    let text = normalize_text(&text, MAX_SYNTHESIZER_TEXT_CHARS)?;
    let config = load_custom_config(&db, &secrets)?;
    let dir = cache_dir();
    let (audio, cached) = custom_audio_cached(&dir, &text, accent, &config, &db).await?;
    if !cached {
        note_cache_growth(&db, Some(&config), audio.len());
    }
    Ok(Response::new(audio))
}

/// Metadata-only, like `ai_api_key_configured`: opening settings must never
/// decrypt the stored key.
#[tauri::command]
pub fn speech_custom_key_configured(secrets: State<'_, Secrets>) -> bool {
    secrets.has_stored_secret_metadata(CUSTOM_KEY_SECRET)
}

/// Model discovery for the custom TTS service, mirroring the chat model list.
/// Deliberately unfiltered: `/v1/models` mixes chat, embedding and speech
/// models, and a self-hosted gateway can call its speech model anything, so
/// filtering by name would hide valid choices.
///
/// Reads the base URL and key directly rather than through `load_custom_config`
/// — the whole point of the list is to pick a model you have not set yet.
#[tauri::command]
pub async fn speech_list_models(
    db: State<'_, Db>,
    secrets: State<'_, Secrets>,
) -> AppResult<Vec<String>> {
    let base_url = {
        let conn = db.reader();
        conn.query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![CUSTOM_BASE_URL_SETTING],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    }
    .ok_or_else(|| AppError::Other(ERR_CUSTOM_NOT_CONFIGURED.to_string()))?;
    // The field accepts a pasted full endpoint, which is not what /models hangs off.
    let base_url = base_url
        .trim_end_matches('/')
        .trim_end_matches("/audio/speech")
        .to_string();
    let api_key = secrets.get(CUSTOM_KEY_SECRET)?.unwrap_or_default();
    crate::ai::router::list_openai_models(&base_url, &api_key).await
}

/// Voice names this endpoint told us it accepts, learned from the body of a
/// rejected synthesis. Empty until a rejection actually spelled them out — there
/// is no endpoint to ask.
///
/// Reads the configured base URL and model rather than taking them as
/// arguments, because unlike chat profiles there is only ever one custom speech
/// service.
#[tauri::command]
pub fn speech_voice_options(db: State<'_, Db>) -> AppResult<SpeechVoiceHints> {
    voice_hints(&db)
}

fn voice_hints(db: &Db) -> AppResult<SpeechVoiceHints> {
    let Some((base_url, model)) = configured_endpoint(db) else {
        return Ok(SpeechVoiceHints::default());
    };
    let stored: Option<(String, i64)> = db
        .conn
        .lock()
        .map_err(|error| AppError::Other(error.to_string()))?
        .query_row(
            "SELECT options, updated_at FROM speech_voice_hints WHERE base_url = ?1 AND model = ?2",
            params![base_url, model],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((payload, updated_at)) = stored else {
        return Ok(SpeechVoiceHints::default());
    };
    Ok(SpeechVoiceHints {
        options: serde_json::from_str::<Vec<String>>(&payload).unwrap_or_default(),
        updated_at: Some(updated_at),
    })
}

#[tauri::command]
pub fn speech_forget_voice_options(db: State<'_, Db>) -> AppResult<()> {
    let Some((base_url, model)) = configured_endpoint(&db) else {
        return Ok(());
    };
    db.conn
        .lock()
        .map_err(|error| AppError::Other(error.to_string()))?
        .execute(
            "DELETE FROM speech_voice_hints WHERE base_url = ?1 AND model = ?2",
            params![base_url, model],
        )?;
    Ok(())
}

/// An empty value clears the key, which is how the user disconnects a provider.
#[tauri::command]
pub fn set_speech_custom_key(value: String, secrets: State<'_, Secrets>) -> AppResult<()> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        secrets.delete(CUSTOM_KEY_SECRET)
    } else {
        secrets.set(CUSTOM_KEY_SECRET, trimmed)
    }
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

    fn custom_config(base_url: &str, model: &str, voice_uk: &str, voice_us: &str) -> CustomConfig {
        CustomConfig {
            base_url: base_url.to_string(),
            model: model.to_string(),
            voice_uk: voice_uk.to_string(),
            voice_us: voice_us.to_string(),
            speed: 1.0,
            api_key: "sk-test".to_string(),
            cache_passages: true,
        }
    }

    /// Text over the cacheable cap, without relying on a literal length.
    fn passage() -> String {
        "word ".repeat(MAX_CACHEABLE_TEXT_CHARS)
    }

    fn cached_files(dir: &Path) -> Vec<String> {
        let Ok(entries) = fs::read_dir(dir) else {
            return Vec::new();
        };
        let mut names: Vec<String> = entries
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn framing_round_trips_timings_and_audio() {
        let timings = vec![
            WordTiming {
                text: "The".into(),
                offset_ms: 100,
                duration_ms: 175,
            },
            WordTiming {
                text: "lantern".into(),
                offset_ms: 288,
                duration_ms: 475,
            },
        ];
        let audio = b"\xff\xf3\x64\xc4payload";
        let framed = frame_audio(&timings, audio).unwrap();

        let header_len = u32::from_be_bytes(framed[..4].try_into().unwrap()) as usize;
        let decoded: Vec<WordTiming> = serde_json::from_slice(&framed[4..4 + header_len]).unwrap();
        assert_eq!(decoded, timings);
        assert_eq!(&framed[4 + header_len..], audio);
    }

    #[test]
    fn framing_survives_a_source_that_reported_no_timings() {
        let audio = b"\xff\xf3";
        let framed = frame_audio(&[], audio).unwrap();
        let header_len = u32::from_be_bytes(framed[..4].try_into().unwrap()) as usize;
        assert_eq!(&framed[4..4 + header_len], b"[]");
        assert_eq!(&framed[4 + header_len..], audio);
    }

    #[test]
    fn only_vocabulary_sized_text_is_worth_keeping() {
        assert!(is_vocabulary_sized("schedule"));
        assert!(is_vocabulary_sized(&"a".repeat(MAX_CACHEABLE_TEXT_CHARS)));
        assert!(!is_vocabulary_sized(
            &"a".repeat(MAX_CACHEABLE_TEXT_CHARS + 1)
        ));
        // Counted in characters, not bytes, or a Chinese phrase would be
        // rejected at a third of the intended length.
        assert!(is_vocabulary_sized(&"字".repeat(MAX_CACHEABLE_TEXT_CHARS)));
    }

    /// A word clip is 15–30 KB and gets replayed during review; a passage is
    /// roughly 800 KB and rarely gets played twice.
    #[tokio::test]
    async fn declining_to_store_writes_nothing_at_all() {
        let dir = tempfile::tempdir().unwrap();
        let identity = SourceIdentity::edge(Accent::Us);

        let (audio, cached) = cached_audio(dir.path(), &identity, "schedule", true, || async {
            Ok(b"ID3\x04word".to_vec())
        })
        .await
        .unwrap();
        assert!(!cached);
        assert_eq!(cached_files(dir.path()).len(), 1, "the word should be kept");

        let (_, cached) = cached_audio(dir.path(), &identity, "schedule", true, || async {
            panic!("must not re-fetch")
        })
        .await
        .unwrap();
        assert!(cached, "the second play must come from disk");

        let (passage_audio, cached) =
            cached_audio(dir.path(), &identity, &passage(), false, || async {
                Ok(b"ID3\x04passage".to_vec())
            })
            .await
            .unwrap();
        assert!(!cached);
        assert_eq!(passage_audio, b"ID3\x04passage", "the audio still plays");
        assert_eq!(
            cached_files(dir.path()).len(),
            1,
            "a passage must leave nothing behind, not even a .partial: {:?}",
            cached_files(dir.path()),
        );
        assert_ne!(audio, passage_audio);
    }

    /// Only writes are governed. Turning the switch off must not orphan audio
    /// that is already on disk.
    #[tokio::test]
    async fn a_cached_entry_is_served_whatever_the_current_policy_says() {
        let dir = tempfile::tempdir().unwrap();
        let identity = SourceIdentity::edge(Accent::Us);
        let long = passage();

        let (written, _) = cached_audio(dir.path(), &identity, &long, true, || async {
            Ok(b"ID3\x04cached".to_vec())
        })
        .await
        .unwrap();

        let (served, cached) = cached_audio(dir.path(), &identity, &long, false, || async {
            panic!("must not re-fetch what is already on disk")
        })
        .await
        .unwrap();
        assert!(cached);
        assert_eq!(written, served);
    }

    #[test]
    fn the_paid_provider_keeps_passages_unless_told_otherwise() {
        let mut config = custom_config("https://api.openai.com/v1", "tts-1", "alloy", "nova");
        let long = passage();

        assert!(config.cache_passages || is_vocabulary_sized(&long));
        config.cache_passages = false;
        // Opting out narrows it to the same rule the free sources follow, rather
        // than turning the cache off entirely.
        assert!(!(config.cache_passages || is_vocabulary_sized(&long)));
        assert!(config.cache_passages || is_vocabulary_sized("schedule"));
    }

    #[test]
    fn normalize_collapses_whitespace() {
        assert_eq!(
            normalize_text("  look   up \n", MAX_DICTIONARY_TEXT_CHARS).unwrap(),
            "look up",
        );
    }

    #[test]
    fn normalize_rejects_empty_and_overlong_text() {
        assert!(normalize_text("   ", MAX_DICTIONARY_TEXT_CHARS).is_err());
        let over = "a".repeat(MAX_DICTIONARY_TEXT_CHARS + 1);
        assert!(normalize_text(&over, MAX_DICTIONARY_TEXT_CHARS).is_err());
        assert!(normalize_text(
            &"a".repeat(MAX_DICTIONARY_TEXT_CHARS),
            MAX_DICTIONARY_TEXT_CHARS
        )
        .is_ok());
        // A synthesizer can read a passage the dictionary would refuse.
        assert!(normalize_text(&over, MAX_SYNTHESIZER_TEXT_CHARS).is_ok());
    }

    /// The client crate pastes the text straight into an SSML document, so
    /// anything unescaped either breaks the document or becomes markup.
    #[test]
    fn ssml_escaping_covers_the_characters_that_would_close_an_element() {
        assert_eq!(escape_ssml("Tom & Jerry"), "Tom &amp; Jerry");
        assert_eq!(escape_ssml("a < b > c"), "a &lt; b &gt; c");
        assert_eq!(
            escape_ssml("</prosody></voice><voice name='x'>"),
            "&lt;/prosody&gt;&lt;/voice&gt;&lt;voice name='x'&gt;",
        );
        // `&` must be rewritten first, or the escapes escape each other.
        assert_eq!(escape_ssml("&lt;"), "&amp;lt;");
        // Ordinary text, including non-ASCII, passes through untouched.
        assert_eq!(escape_ssml("a piece of cake 你好"), "a piece of cake 你好");
    }

    #[test]
    fn edge_voices_differ_by_accent() {
        assert_eq!(Accent::Uk.edge_voice(), EDGE_VOICE_UK);
        assert_eq!(Accent::Us.edge_voice(), EDGE_VOICE_US);
        assert_ne!(Accent::Uk.edge_voice(), Accent::Us.edge_voice());
    }

    #[test]
    fn cache_stem_separates_accents_and_texts() {
        let uk = cache_stem(&SourceIdentity::dictionary(Accent::Uk), "schedule");
        let us = cache_stem(&SourceIdentity::dictionary(Accent::Us), "schedule");
        assert_ne!(uk, us);
        assert_ne!(
            us,
            cache_stem(&SourceIdentity::dictionary(Accent::Us), "scheduled")
        );
        // Stable across calls, so a cached clip is found again.
        assert_eq!(
            uk,
            cache_stem(&SourceIdentity::dictionary(Accent::Uk), "schedule")
        );
    }

    #[test]
    fn cache_stem_is_filename_safe() {
        let stem = cache_stem(&SourceIdentity::dictionary(Accent::Us), "a piece of cake");
        assert_eq!(stem.len(), 64);
        assert!(stem.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn no_two_sources_share_a_cache_entry() {
        let config = custom_config("https://api.openai.com/v1", "tts-1", "alloy", "nova");
        let stems = [
            cache_stem(&SourceIdentity::dictionary(Accent::Us), "schedule"),
            cache_stem(&SourceIdentity::edge(Accent::Us), "schedule"),
            cache_stem(&SourceIdentity::custom(&config, Accent::Us), "schedule"),
        ];
        let distinct: HashSet<&String> = stems.iter().collect();
        assert_eq!(distinct.len(), stems.len(), "sources collided: {stems:?}");
        // And the accent still separates them within a source.
        assert_ne!(
            cache_stem(&SourceIdentity::edge(Accent::Uk), "schedule"),
            cache_stem(&SourceIdentity::edge(Accent::Us), "schedule"),
        );
    }

    // Changing voice or model must not keep serving the clip recorded under the
    // previous settings.
    #[test]
    fn custom_cache_entries_follow_the_provider_settings() {
        let base = custom_config("https://api.openai.com/v1", "tts-1", "alloy", "nova");
        let other_model = custom_config("https://api.openai.com/v1", "tts-1-hd", "alloy", "nova");
        let other_voice = custom_config("https://api.openai.com/v1", "tts-1", "alloy", "shimmer");
        let other_host = custom_config("https://proxy.example.com/v1", "tts-1", "alloy", "nova");

        let stem = |config: &CustomConfig| {
            cache_stem(&SourceIdentity::custom(config, Accent::Us), "schedule")
        };
        assert_ne!(stem(&base), stem(&other_model));
        assert_ne!(stem(&base), stem(&other_voice));
        assert_ne!(stem(&base), stem(&other_host));
    }

    #[test]
    fn custom_endpoint_tolerates_how_the_base_url_was_pasted() {
        let expected = "https://api.openai.com/v1/audio/speech";
        for base in [
            "https://api.openai.com/v1",
            "https://api.openai.com/v1/",
            // Someone pasting the full endpoint should not get it twice.
            "https://api.openai.com/v1/audio/speech",
        ] {
            assert_eq!(
                custom_config(base, "tts-1", "alloy", "nova").endpoint(),
                expected
            );
        }
    }

    /// Serves one request, replying with `status` and a tiny MP3, and hands back
    /// the raw request text so the wire format can be asserted on.
    fn one_shot_server(status: u16) -> (u16, std::thread::JoinHandle<String>) {
        one_shot_server_with_body(status, b"ID3\x04", "audio/mpeg")
    }

    fn one_shot_server_with_body(
        status: u16,
        reply: &'static [u8],
        content_type: &'static str,
    ) -> (u16, std::thread::JoinHandle<String>) {
        use std::io::{BufRead, BufReader, Read, Write};

        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let handle = std::thread::spawn(move || {
            let (stream, _) = listener.accept().expect("accept");
            let mut reader = BufReader::new(stream);
            let mut raw = String::new();
            let mut content_length = 0usize;
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).expect("read header") == 0 {
                    break;
                }
                if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    content_length = value.trim().parse().unwrap_or(0);
                }
                let done = line == "\r\n" || line == "\n";
                raw.push_str(&line);
                if done {
                    break;
                }
            }
            let mut body = vec![0u8; content_length];
            reader.read_exact(&mut body).expect("read body");
            raw.push_str(&String::from_utf8_lossy(&body));

            let response = format!(
                "HTTP/1.1 {status} OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n\r\n",
                reply.len(),
            );
            let mut stream = reader.into_inner();
            stream.write_all(response.as_bytes()).expect("write head");
            stream.write_all(reply).expect("write body");
            stream.flush().ok();
            raw
        });
        (port, handle)
    }

    /// Pins the exact request a user's provider will receive. Getting this wrong
    /// is invisible locally and near-impossible for them to diagnose.
    #[tokio::test]
    async fn custom_request_uses_the_openai_audio_speech_shape() {
        let (port, server) = one_shot_server(200);
        let config = custom_config(
            &format!("http://127.0.0.1:{port}/v1"),
            "tts-1",
            "alloy",
            "nova",
        );

        let dir = tempfile::tempdir().unwrap();
        let db = Db::init(dir.path()).unwrap();
        let audio = fetch_custom("schedule", Accent::Us, &config, &db)
            .await
            .expect("audio");
        assert_eq!(audio, b"ID3\x04");

        let request = server.join().expect("server thread");
        assert!(
            request.starts_with("POST /v1/audio/speech "),
            "unexpected request line: {request}",
        );
        assert!(request
            .to_ascii_lowercase()
            .contains("authorization: bearer sk-test"));
        assert!(request.contains(r#""model":"tts-1""#), "{request}");
        assert!(request.contains(r#""input":"schedule""#), "{request}");
        // The US accent must pick the US voice, not the first one configured.
        assert!(request.contains(r#""voice":"nova""#), "{request}");
        assert!(request.contains(r#""response_format":"mp3""#), "{request}");
    }

    /// A rejected key must point at settings, not blame the network.
    #[tokio::test]
    async fn custom_reports_a_rejected_key_as_misconfiguration() {
        let (port, server) = one_shot_server(401);
        let config = custom_config(
            &format!("http://127.0.0.1:{port}/v1"),
            "tts-1",
            "alloy",
            "nova",
        );

        let dir = tempfile::tempdir().unwrap();
        let db = Db::init(dir.path()).unwrap();
        let error = fetch_custom("schedule", Accent::Us, &config, &db)
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), ERR_CUSTOM_NOT_CONFIGURED);
        server.join().expect("server thread");
    }

    /// The voice list has no endpoint to ask, so a rejection is the only place
    /// it ever comes from. Losing it means the settings field can never offer
    /// anything but the built-in OpenAI names.
    #[tokio::test]
    async fn a_rejected_voice_teaches_the_voices_the_endpoint_accepts() {
        let (port, server) = one_shot_server_with_body(
            400,
            br#"{"error":{"message":"Invalid value: 'juliet'. Supported values are: 'alloy', 'nova', and 'shimmer'."}}"#,
            "application/json",
        );
        let base_url = format!("http://127.0.0.1:{port}/v1");
        let config = custom_config(&base_url, "tts-1", "alloy", "juliet");

        let dir = tempfile::tempdir().unwrap();
        let db = Db::init(dir.path()).unwrap();
        // The settings the hint is keyed by; a pasted full endpoint must resolve
        // to the same key as the service root.
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2), (?3, ?4)",
                params![
                    CUSTOM_BASE_URL_SETTING,
                    format!("{base_url}/audio/speech"),
                    CUSTOM_MODEL_SETTING,
                    "tts-1"
                ],
            )
            .unwrap();
        }

        let error = fetch_custom("schedule", Accent::Us, &config, &db)
            .await
            .unwrap_err();
        // The request is still lost — learning does not rescue it.
        assert_eq!(error.to_string(), ERR_SOURCE_UNAVAILABLE);
        server.join().expect("server thread");

        let hints = voice_hints(&db).unwrap();
        assert_eq!(hints.options, vec!["alloy", "nova", "shimmer"]);
        assert!(hints.updated_at.is_some());
    }

    #[test]
    fn custom_voice_is_selected_by_accent() {
        let config = custom_config("https://api.openai.com/v1", "tts-1", "alloy", "nova");
        assert_eq!(config.voice(Accent::Uk), "alloy");
        assert_eq!(config.voice(Accent::Us), "nova");
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

        let stem = cache_stem(&SourceIdentity::dictionary(Accent::Us), "pronunciation");
        assert!(dir
            .path()
            .join(format!("{stem}.{AUDIO_EXTENSION}"))
            .exists());

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

        let stem = cache_stem(&SourceIdentity::dictionary(Accent::Us), "zxqwvbnm");
        let miss = dir.path().join(format!("{stem}.{MISS_EXTENSION}"));
        assert!(
            miss.exists(),
            "a miss must be cached so the retry is instant"
        );

        // Served from the marker rather than a second round trip.
        let error = dictionary_audio_cached(dir.path(), "zxqwvbnm", Accent::Us)
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), ERR_NOT_IN_DICTIONARY);
    }

    /// The Edge protocol is unofficial and Microsoft has broken it before, so
    /// this is the test that says whether the source still works at all. A
    /// failure here is the signal to check `msedge-tts` for a newer release.
    #[tokio::test]
    #[ignore = "requires network"]
    async fn live_edge_synthesizes_a_passage() {
        let dir = tempfile::tempdir().unwrap();
        // Long enough to prove this is a synthesizer, not a dictionary lookup.
        let passage = "The lantern threw its light across the water, and the boat came about.";
        let (fetched, cached) = edge_audio_cached(dir.path(), passage, Accent::Us)
            .await
            .unwrap();
        assert!(!cached, "first call must go to the network");
        assert!(fetched.len() > 1024, "got {} bytes", fetched.len());

        // Deliberately not served from disk on a second play: see
        // `live_edge_keeps_a_word_and_discards_a_passage`. A passage is roughly
        // 800 KB and rarely replayed, so it is synthesized again instead.
        let (replayed, cached) = edge_audio_cached(dir.path(), passage, Accent::Us)
            .await
            .unwrap();
        assert!(!cached, "a passage must not be cached");
        assert!(replayed.len() > 1024);
    }

    /// The end-to-end version of `declining_to_store_writes_nothing_at_all`,
    /// against the real service: it is the only thing that proves
    /// `edge_audio_cached` passes the right decision through, and that a live
    /// synthesis really does carry timings.
    #[tokio::test]
    #[ignore = "requires network"]
    async fn live_edge_keeps_a_word_and_discards_a_passage() {
        let dir = tempfile::tempdir().unwrap();

        let (framed, _) = edge_audio_cached(dir.path(), "schedule", Accent::Us)
            .await
            .unwrap();
        assert_eq!(cached_files(dir.path()).len(), 1, "the word should be kept");

        let header_len = u32::from_be_bytes(framed[..4].try_into().unwrap()) as usize;
        let timings: Vec<WordTiming> = serde_json::from_slice(&framed[4..4 + header_len]).unwrap();
        assert!(!timings.is_empty(), "a synthesis must report word timings");
        assert!(
            timings
                .windows(2)
                .all(|pair| pair[0].offset_ms <= pair[1].offset_ms),
            "timings must arrive in spoken order",
        );

        let long = "The lantern threw its light across the water. ".repeat(3);
        assert!(!is_vocabulary_sized(&long));
        edge_audio_cached(dir.path(), &long, Accent::Us)
            .await
            .unwrap();
        assert_eq!(
            cached_files(dir.path()).len(),
            1,
            "a passage must not be written: {:?}",
            cached_files(dir.path()),
        );
    }

    /// Text the dictionary source would have to escape past — proof the SSML
    /// document survives the round trip rather than being rejected.
    #[tokio::test]
    #[ignore = "requires network"]
    async fn live_edge_reads_text_containing_markup_characters() {
        let dir = tempfile::tempdir().unwrap();
        let (audio, _) = edge_audio_cached(dir.path(), "Tom & Jerry < 5 > 3", Accent::Us)
            .await
            .unwrap();
        assert!(audio.len() > 1024, "got {} bytes", audio.len());
    }

    #[tokio::test]
    #[ignore = "requires network"]
    async fn live_edge_uk_and_us_voices_differ() {
        let dir = tempfile::tempdir().unwrap();
        let (uk, _) = edge_audio_cached(dir.path(), "schedule", Accent::Uk)
            .await
            .unwrap();
        let (us, _) = edge_audio_cached(dir.path(), "schedule", Accent::Us)
            .await
            .unwrap();
        assert!(!uk.is_empty() && !us.is_empty());
        assert_ne!(uk, us);
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

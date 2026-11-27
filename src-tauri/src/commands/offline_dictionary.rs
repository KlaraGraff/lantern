//! Device-local dictionaries for the single-click lookup: the open-source
//! ECDICT word list (an optional download) and MDict `.mdx` files the reader
//! imports. Both live under the local data directory and never enter sync — a
//! downloaded word list is cheap to fetch again, and an imported dictionary is
//! the reader's own file, often one they may not redistribute.
//!
//! ECDICT ships as a CSV; it is converted once, at install, into a small
//! SQLite file with a case-insensitive index, so a lookup is one indexed
//! query. MDict files are read in place through `mdictlib`, which keeps key
//! and record blocks lazy.

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use futures::StreamExt;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::commands::dictionary::{
    clear_lookup_cache, entry_from_groups_capped, split_pos_marker, DictionaryEntry,
};
use crate::db::Db;
use crate::error::{AppError, AppResult};

const ROOT_DIR: &str = "offline-dictionary";
const ECDICT_FILE: &str = "ecdict.sqlite";
const MDX_DIR: &str = "mdx";

/// Pinned to one commit so the size and hash below stay a real contract: the
/// file at a moving branch could change under a released build.
const ECDICT_URL: &str = "https://raw.githubusercontent.com/skywind3000/ECDICT/39cfb9672c0906b63569e0453c2e6abfb9ab182a/ecdict.csv";
const ECDICT_SIZE: u64 = 66_009_548;
const ECDICT_SHA256: &str = "d1ecbdf9ee2b920afb6f430ca6b6bb9f559588cf0dff86e04bd255f9390843cc";
/// Shown on the card and in settings: it is a reference, not one of ours.
const ECDICT_SOURCE: &str = "ECDICT";

/// Device-local rows (not on the sync whitelist): whether this device should
/// keep trying to fetch ECDICT until it gets it, and which side answers first.
const PENDING_KEY: &str = "offline_dictionary_pending";
const SOURCE_KEY: &str = "dictionary_source";

const RETRY_INTERVAL: Duration = Duration::from_secs(60);
const PROGRESS_STEP_BYTES: u64 = 512 * 1024;
const MDX_MAX_GROUPS: usize = 60;
const MAX_LINK_HOPS: usize = 3;
const STATUS_EVENT: &str = "offline-dictionary-status-changed";

fn error(code: &str) -> AppError {
    AppError::Other(code.to_string())
}

pub(crate) fn root(db: &Db) -> AppResult<PathBuf> {
    Ok(db.local_data_dir()?.join(ROOT_DIR))
}

fn read_setting(db: &Db, key: &str) -> Option<String> {
    crate::commands::settings::get_setting_value(db, key)
        .ok()
        .flatten()
}

fn write_setting(db: &Db, key: &str, value: &str) -> AppResult<()> {
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    conn.execute(
        "INSERT INTO settings (key, value, updated_at, updated_by_device)
         VALUES (?1, ?2, 0, '')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

fn pending(db: &Db) -> bool {
    read_setting(db, PENDING_KEY).as_deref() == Some("true")
}

// --- Lookup -----------------------------------------------------------------

/// Everything one lookup needs, read up front so the async command does not
/// hold the database across its network awaits.
pub(crate) struct LocalLookup {
    root: PathBuf,
    local_first: bool,
    ecdict_installed: bool,
    ecdict_pending: bool,
}

impl LocalLookup {
    pub(crate) fn for_db(db: &Db) -> AppResult<Self> {
        let root = root(db)?;
        Ok(Self {
            ecdict_installed: root.join(ECDICT_FILE).is_file(),
            ecdict_pending: pending(db),
            local_first: read_setting(db, SOURCE_KEY).as_deref() == Some("local"),
            root,
        })
    }

    pub(crate) fn local_first(&self) -> bool {
        self.local_first
    }

    /// True when ECDICT is installed or already queued to download — either
    /// way there is nothing to offer the reader.
    pub(crate) fn expects_ecdict(&self) -> bool {
        self.ecdict_installed || self.ecdict_pending
    }

    pub(crate) async fn lookup(&self, query: &str) -> Option<DictionaryEntry> {
        let root = self.root.clone();
        let query = query.to_string();
        tauri::async_runtime::spawn_blocking(move || lookup_local(&root, &query))
            .await
            .ok()
            .flatten()
    }
}

/// Imported dictionaries first, in import order — the reader brought them for
/// a reason — then ECDICT. A dictionary that fails to open or read is skipped,
/// never surfaced: a broken file must not take the lookup down with it.
fn lookup_local(root: &Path, query: &str) -> Option<DictionaryEntry> {
    for dictionary in list_mdx(root) {
        if let Some(entry) = lookup_mdx(root, &dictionary, query) {
            return Some(entry);
        }
    }
    lookup_ecdict(&root.join(ECDICT_FILE), query).ok().flatten()
}

fn lookup_ecdict(path: &Path, query: &str) -> AppResult<Option<DictionaryEntry>> {
    if !path.is_file() {
        return Ok(None);
    }
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let row = conn
        .query_row(
            "SELECT word, phonetic, translation FROM entries
             WHERE word = ?1 COLLATE NOCASE
             ORDER BY word = ?1 DESC
             LIMIT 1",
            params![query],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()?;
    Ok(row.and_then(|(word, phonetic, translation)| {
        let phonetic = phonetic.filter(|p| !p.trim().is_empty());
        let mut entry =
            entry_from_groups_capped(word, phonetic, ecdict_groups(&translation), MDX_MAX_GROUPS)?;
        entry.source = Some(ECDICT_SOURCE.to_string());
        Some(entry)
    }))
}

/// ECDICT's translation column: one part of speech per line, senses joined
/// with `, ` (`n. 银行, 堤, 岸`), and bracketed domain lines such as
/// `[网络] 胡德；兜帽` or `[医] 库`.
fn ecdict_groups(translation: &str) -> Vec<(String, Vec<String>)> {
    translation
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|line| {
            let (pos, senses) = match line.strip_prefix('[').and_then(|rest| rest.split_once(']')) {
                Some((tag, rest)) if tag.chars().count() <= 6 => {
                    let (_, senses) = split_pos_marker(rest);
                    (format!("[{tag}]"), senses)
                }
                _ => split_pos_marker(line),
            };
            let senses = senses
                .iter()
                .flat_map(|sense| sense.split(", "))
                .map(str::trim)
                .filter(|sense| !sense.is_empty())
                .map(str::to_string)
                .collect();
            (pos, senses)
        })
        .collect()
}

fn mdx_cache() -> &'static Mutex<HashMap<String, Arc<mdictlib::MdxFile>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Arc<mdictlib::MdxFile>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn open_mdx(root: &Path, id: &str) -> Option<Arc<mdictlib::MdxFile>> {
    if let Some(open) = mdx_cache().lock().ok()?.get(id).cloned() {
        return Some(open);
    }
    let file = Arc::new(mdictlib::MdxFile::open(mdx_path(root, id)).ok()?);
    mdx_cache()
        .lock()
        .ok()?
        .insert(id.to_string(), file.clone());
    Some(file)
}

fn lookup_mdx(
    root: &Path,
    dictionary: &ImportedDictionary,
    query: &str,
) -> Option<DictionaryEntry> {
    let file = open_mdx(root, &dictionary.id)?;
    let mut key = query.to_string();
    for _ in 0..=MAX_LINK_HOPS {
        let matches = file
            .locate_with_mode(&key, mdictlib::MatchMode::IncludeCaseVariants)
            .ok()??;
        let entry = file.entry_at(matches.iter().next()?).ok()??;
        let text = entry.text().trim();
        // `@@@LINK=go` is how MDict spells "see go": follow it a few hops,
        // never in a loop.
        if let Some(target) = text.strip_prefix("@@@LINK=") {
            key = target.trim().to_string();
            continue;
        }
        let headword = entry.key().to_string();
        let mut lines = html_to_lines(text);
        if lines
            .first()
            .is_some_and(|first| first.eq_ignore_ascii_case(&headword))
        {
            lines.remove(0);
        }
        let groups = lines.iter().map(|line| split_pos_marker(line)).collect();
        let mut result = entry_from_groups_capped(headword, None, groups, MDX_MAX_GROUPS)?;
        result.source = Some(dictionary.title.clone());
        return Some(result);
    }
    None
}

/// An MDict entry is an HTML fragment with its own styling and scripts. The
/// card shows text, so this keeps the words and one line per block element.
fn html_to_lines(html: &str) -> Vec<String> {
    use scraper::node::Node;

    const BLOCKS: &[&str] = &[
        "p",
        "div",
        "br",
        "li",
        "ul",
        "ol",
        "tr",
        "table",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "dt",
        "dd",
        "dl",
        "blockquote",
        "section",
        "article",
        "hr",
    ];
    const SKIPPED: &[&str] = &["script", "style", "head", "link", "meta", "title"];

    fn walk(node: ego_tree::NodeRef<'_, Node>, out: &mut String) {
        match node.value() {
            Node::Text(text) => out.push_str(text),
            Node::Element(element) => {
                let name = element.name();
                if SKIPPED.contains(&name) {
                    return;
                }
                let block = BLOCKS.contains(&name);
                if block {
                    out.push('\n');
                }
                for child in node.children() {
                    walk(child, out);
                }
                if block {
                    out.push('\n');
                }
            }
            _ => {
                for child in node.children() {
                    walk(child, out);
                }
            }
        }
    }

    let fragment = scraper::Html::parse_fragment(html);
    let mut text = String::new();
    walk(fragment.tree.root(), &mut text);
    text.lines()
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|line| !line.is_empty())
        .collect()
}

// --- Imported MDict files -----------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportedDictionary {
    pub id: String,
    pub title: String,
    pub entries: u64,
    pub bytes: u64,
    pub imported_at: i64,
}

fn mdx_dir(root: &Path) -> PathBuf {
    root.join(MDX_DIR)
}

fn mdx_path(root: &Path, id: &str) -> PathBuf {
    mdx_dir(root).join(format!("{id}.mdx"))
}

fn meta_path(root: &Path, id: &str) -> PathBuf {
    mdx_dir(root).join(format!("{id}.json"))
}

fn valid_id(id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok()
}

pub(crate) fn list_mdx(root: &Path) -> Vec<ImportedDictionary> {
    let Ok(dir) = fs::read_dir(mdx_dir(root)) else {
        return Vec::new();
    };
    let mut list: Vec<ImportedDictionary> = dir
        .filter_map(Result::ok)
        .filter(|item| item.path().extension().is_some_and(|ext| ext == "json"))
        .filter_map(|item| fs::read(item.path()).ok())
        .filter_map(|bytes| serde_json::from_slice::<ImportedDictionary>(&bytes).ok())
        .filter(|meta| valid_id(&meta.id) && mdx_path(root, &meta.id).is_file())
        .collect();
    list.sort_by(|a, b| a.imported_at.cmp(&b.imported_at).then(a.id.cmp(&b.id)));
    list
}

/// MDict's authoring tool leaves this placeholder in the title of every
/// dictionary whose author never filled it in.
const PLACEHOLDER_TITLE: &str = "Title (No HTML code allowed)";

fn dictionary_title(file: &mdictlib::MdxFile, source: &Path) -> String {
    file.header()
        .title()
        .map(str::trim)
        .filter(|title| !title.is_empty() && *title != PLACEHOLDER_TITLE)
        .map(str::to_string)
        .or_else(|| {
            source
                .file_stem()
                .map(|stem| stem.to_string_lossy().into_owned())
        })
        .unwrap_or_else(|| "MDict".to_string())
}

/// Opens the source before copying anything, so an unreadable file (wrong
/// format, an encrypted one, a dictionary with no entries) is refused with
/// nothing left behind. The copy goes to a temporary name first and is
/// renamed into place only once complete.
pub(crate) fn import_mdx_at(
    root: &Path,
    source: &Path,
    now_ms: i64,
) -> AppResult<ImportedDictionary> {
    if !source
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("mdx"))
    {
        return Err(error("OFFLINE_DICTIONARY_NOT_MDX"));
    }
    let probe =
        mdictlib::MdxFile::open(source).map_err(|_| error("OFFLINE_DICTIONARY_MDX_UNREADABLE"))?;
    if probe.is_empty() {
        return Err(error("OFFLINE_DICTIONARY_MDX_UNREADABLE"));
    }
    let title = dictionary_title(&probe, source);
    let entries = probe.len();
    drop(probe);

    let dir = mdx_dir(root);
    fs::create_dir_all(&dir).map_err(|_| error("OFFLINE_DICTIONARY_STORAGE_FAILED"))?;
    let id = uuid::Uuid::new_v4().to_string();
    let staging = tempfile::Builder::new()
        .prefix(".import.")
        .suffix(".partial")
        .tempfile_in(&dir)
        .map_err(|_| error("OFFLINE_DICTIONARY_STORAGE_FAILED"))?
        .into_temp_path();
    fs::copy(source, &staging).map_err(|_| error("OFFLINE_DICTIONARY_STORAGE_FAILED"))?;
    let bytes = fs::metadata(&staging)
        .map_err(|_| error("OFFLINE_DICTIONARY_STORAGE_FAILED"))?
        .len();
    staging
        .persist(mdx_path(root, &id))
        .map_err(|_| error("OFFLINE_DICTIONARY_STORAGE_FAILED"))?;
    let meta = ImportedDictionary {
        id: id.clone(),
        title,
        entries,
        bytes,
        imported_at: now_ms,
    };
    let json = serde_json::to_vec(&meta).map_err(|_| error("OFFLINE_DICTIONARY_STORAGE_FAILED"))?;
    if fs::write(meta_path(root, &id), json).is_err() {
        let _ = fs::remove_file(mdx_path(root, &id));
        return Err(error("OFFLINE_DICTIONARY_STORAGE_FAILED"));
    }
    Ok(meta)
}

pub(crate) fn remove_mdx_at(root: &Path, id: &str) -> AppResult<()> {
    if !valid_id(id) {
        return Err(error("OFFLINE_DICTIONARY_NOT_FOUND"));
    }
    if let Ok(mut cache) = mdx_cache().lock() {
        cache.remove(id);
    }
    // The metadata goes first: without it the dictionary is no longer listed
    // or consulted, even if removing the large file itself then fails.
    for path in [meta_path(root, id), mdx_path(root, id)] {
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(error("OFFLINE_DICTIONARY_REMOVE_FAILED")),
        }
    }
    Ok(())
}

// --- ECDICT download ------------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EcdictState {
    NotDownloaded,
    /// Queued: retried every minute until a connection lets it through.
    Waiting,
    Downloading,
    Installing,
    Installed,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EcdictStatus {
    pub state: EcdictState,
    pub download_size: u64,
    pub downloaded_bytes: u64,
    pub installed_bytes: Option<u64>,
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfflineDictionaryStatus {
    pub ecdict: EcdictStatus,
    pub imported: Vec<ImportedDictionary>,
}

/// What the running download is doing right now. Persistent facts (installed,
/// queued) come from disk and settings; only the in-flight part lives here.
#[derive(Debug, Clone)]
enum Transient {
    Idle,
    Downloading(u64),
    Installing,
    Failed(String),
}

fn transient() -> &'static Mutex<Transient> {
    static STATE: OnceLock<Mutex<Transient>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(Transient::Idle))
}

fn set_transient(next: Transient) {
    if let Ok(mut state) = transient().lock() {
        *state = next;
    }
}

fn worker_running() -> &'static AtomicBool {
    static RUNNING: AtomicBool = AtomicBool::new(false);
    &RUNNING
}

fn cancel_requested() -> &'static AtomicBool {
    static CANCEL: AtomicBool = AtomicBool::new(false);
    &CANCEL
}

fn ecdict_status(root: &Path, queued: bool) -> EcdictStatus {
    let installed_bytes = fs::metadata(root.join(ECDICT_FILE))
        .ok()
        .map(|meta| meta.len());
    let current = transient()
        .lock()
        .map(|s| s.clone())
        .unwrap_or(Transient::Idle);
    let (state, downloaded_bytes, error_code) = match (&current, installed_bytes) {
        (Transient::Downloading(bytes), _) => (EcdictState::Downloading, *bytes, None),
        (Transient::Installing, _) => (EcdictState::Installing, ECDICT_SIZE, None),
        (_, Some(_)) => (EcdictState::Installed, 0, None),
        (_, None) if queued => (EcdictState::Waiting, 0, None),
        (Transient::Failed(code), None) => (EcdictState::Failed, 0, Some(code.clone())),
        (Transient::Idle, None) => (EcdictState::NotDownloaded, 0, None),
    };
    EcdictStatus {
        state,
        download_size: ECDICT_SIZE,
        downloaded_bytes,
        installed_bytes,
        error_code,
    }
}

fn status(db: &Db) -> AppResult<OfflineDictionaryStatus> {
    let root = root(db)?;
    Ok(OfflineDictionaryStatus {
        ecdict: ecdict_status(&root, pending(db)),
        imported: list_mdx(&root),
    })
}

fn emit_status<R: Runtime>(app: &AppHandle<R>) {
    if let Some(db) = app.try_state::<Db>() {
        if let Ok(next) = status(&db) {
            let _ = app.emit(STATUS_EVENT, next);
        }
    }
}

/// Converts the ECDICT CSV into the lookup database. Rows without a Chinese
/// translation are skipped — the card has nothing to show for them. Written
/// to `destination` in one transaction with the index built last, which is
/// several times faster than indexing row by row.
pub(crate) fn build_ecdict_db(csv_path: &Path, destination: &Path) -> AppResult<u64> {
    let mut reader =
        csv::Reader::from_path(csv_path).map_err(|_| error("OFFLINE_DICTIONARY_INSTALL_FAILED"))?;
    let headers = reader
        .headers()
        .map_err(|_| error("OFFLINE_DICTIONARY_INSTALL_FAILED"))?
        .clone();
    let column = |name: &str| {
        headers
            .iter()
            .position(|header| header == name)
            .ok_or_else(|| error("OFFLINE_DICTIONARY_INSTALL_FAILED"))
    };
    let (word_at, phonetic_at, translation_at) =
        (column("word")?, column("phonetic")?, column("translation")?);

    let mut conn = Connection::open(destination)?;
    conn.execute_batch(
        "PRAGMA journal_mode = OFF;
         PRAGMA synchronous = OFF;
         CREATE TABLE entries (word TEXT NOT NULL, phonetic TEXT, translation TEXT NOT NULL);",
    )?;
    let tx = conn.transaction()?;
    let mut rows = 0_u64;
    {
        let mut insert =
            tx.prepare("INSERT INTO entries (word, phonetic, translation) VALUES (?1, ?2, ?3)")?;
        for record in reader.records() {
            let record = record.map_err(|_| error("OFFLINE_DICTIONARY_INSTALL_FAILED"))?;
            let word = record.get(word_at).unwrap_or("").trim();
            // ECDICT stores line breaks inside a field as a literal `\n`.
            let translation = record
                .get(translation_at)
                .unwrap_or("")
                .replace("\\n", "\n");
            if word.is_empty() || translation.trim().is_empty() {
                continue;
            }
            let phonetic = record
                .get(phonetic_at)
                .map(str::trim)
                .filter(|p| !p.is_empty());
            insert.execute(params![word, phonetic, translation.trim()])?;
            rows += 1;
        }
    }
    tx.execute_batch("CREATE INDEX entries_word ON entries (word COLLATE NOCASE);")?;
    tx.commit()?;
    if rows == 0 {
        return Err(error("OFFLINE_DICTIONARY_INSTALL_FAILED"));
    }
    Ok(rows)
}

/// Network-shaped failures are worth retrying when the connection returns;
/// a file that arrives with the wrong size or hash is not.
fn is_retryable(code: &str) -> bool {
    code == "OFFLINE_DICTIONARY_DOWNLOAD_FAILED"
}

async fn download_once<R: Runtime>(app: &AppHandle<R>, root: &Path) -> AppResult<()> {
    fs::create_dir_all(root).map_err(|_| error("OFFLINE_DICTIONARY_STORAGE_FAILED"))?;
    let incoming = tempfile::TempPath::from_path(
        root.join(format!(".ecdict.{}.csv.partial", uuid::Uuid::new_v4())),
    );
    let response = crate::ai::http_client()
        .get(ECDICT_URL)
        .send()
        .await
        .map_err(|_| error("OFFLINE_DICTIONARY_DOWNLOAD_FAILED"))?;
    if !response.status().is_success() {
        return Err(error("OFFLINE_DICTIONARY_DOWNLOAD_FAILED"));
    }
    if response
        .content_length()
        .is_some_and(|length| length != ECDICT_SIZE)
    {
        return Err(error("OFFLINE_DICTIONARY_LENGTH_MISMATCH"));
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&incoming)
        .map_err(|_| error("OFFLINE_DICTIONARY_STORAGE_FAILED"))?;
    let mut hasher = Sha256::new();
    let mut downloaded = 0_u64;
    let mut reported = 0_u64;
    set_transient(Transient::Downloading(0));
    emit_status(app);
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        if cancel_requested().load(Ordering::SeqCst) {
            return Err(error("OFFLINE_DICTIONARY_CANCELLED"));
        }
        let chunk = chunk.map_err(|_| error("OFFLINE_DICTIONARY_DOWNLOAD_FAILED"))?;
        downloaded = downloaded.saturating_add(chunk.len() as u64);
        if downloaded > ECDICT_SIZE {
            return Err(error("OFFLINE_DICTIONARY_LENGTH_MISMATCH"));
        }
        hasher.update(&chunk);
        file.write_all(&chunk)
            .map_err(|_| error("OFFLINE_DICTIONARY_STORAGE_FAILED"))?;
        if downloaded - reported >= PROGRESS_STEP_BYTES {
            reported = downloaded;
            set_transient(Transient::Downloading(downloaded));
            emit_status(app);
        }
    }
    file.sync_all()
        .map_err(|_| error("OFFLINE_DICTIONARY_STORAGE_FAILED"))?;
    drop(file);
    if downloaded != ECDICT_SIZE {
        // A short body is a dropped connection, not a bad file.
        return Err(error("OFFLINE_DICTIONARY_DOWNLOAD_FAILED"));
    }
    if format!("{:x}", hasher.finalize()) != ECDICT_SHA256 {
        return Err(error("OFFLINE_DICTIONARY_HASH_MISMATCH"));
    }

    set_transient(Transient::Installing);
    emit_status(app);
    let root = root.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || install_from_csv(&root, &incoming))
        .await
        .map_err(|_| error("OFFLINE_DICTIONARY_INSTALL_FAILED"))?
}

fn install_from_csv(root: &Path, csv: &Path) -> AppResult<()> {
    let staging = tempfile::Builder::new()
        .prefix(".ecdict.")
        .suffix(".sqlite.partial")
        .tempfile_in(root)
        .map_err(|_| error("OFFLINE_DICTIONARY_STORAGE_FAILED"))?
        .into_temp_path();
    build_ecdict_db(csv, &staging)?;
    staging
        .persist(root.join(ECDICT_FILE))
        .map_err(|_| error("OFFLINE_DICTIONARY_STORAGE_FAILED"))?;
    Ok(())
}

/// The download loop. Runs until ECDICT is installed, the reader cancels, or
/// the file itself turns out to be wrong; a failed connection just waits a
/// minute and tries again, which is how "download once I'm online" works
/// without the app needing to know what kind of network it is on.
fn spawn_worker<R: Runtime>(app: AppHandle<R>) {
    if worker_running().swap(true, Ordering::SeqCst) {
        return;
    }
    cancel_requested().store(false, Ordering::SeqCst);
    tauri::async_runtime::spawn(async move {
        while let Some(db) = app.try_state::<Db>() {
            if !pending(&db) || cancel_requested().load(Ordering::SeqCst) {
                break;
            }
            let Ok(root) = root(&db) else { break };
            if root.join(ECDICT_FILE).is_file() {
                let _ = write_setting(&db, PENDING_KEY, "false");
                break;
            }
            match download_once(&app, &root).await {
                Ok(()) => {
                    let _ = write_setting(&db, PENDING_KEY, "false");
                    set_transient(Transient::Idle);
                    clear_lookup_cache();
                    emit_status(&app);
                    break;
                }
                Err(err) => {
                    let code = err.to_string();
                    if code == "OFFLINE_DICTIONARY_CANCELLED" {
                        set_transient(Transient::Idle);
                        emit_status(&app);
                        break;
                    }
                    if !is_retryable(&code) {
                        let _ = write_setting(&db, PENDING_KEY, "false");
                        set_transient(Transient::Failed(code));
                        emit_status(&app);
                        break;
                    }
                    log::info!("offline dictionary download will retry: {code}");
                    set_transient(Transient::Idle);
                    emit_status(&app);
                }
            }
            tokio::time::sleep(RETRY_INTERVAL).await;
        }
        worker_running().store(false, Ordering::SeqCst);
        // A request that arrived while this loop was winding down saw it still
        // running and returned; pick it up now rather than drop it.
        if let Some(db) = app.try_state::<Db>() {
            if pending(&db) && !cancel_requested().load(Ordering::SeqCst) {
                spawn_worker(app.clone());
            }
        }
    });
}

/// Called once at startup: a download the reader asked for in an earlier run
/// carries on in this one.
pub(crate) fn resume_pending<R: Runtime>(app: &AppHandle<R>) {
    if let Some(db) = app.try_state::<Db>() {
        if pending(&db) {
            spawn_worker(app.clone());
        }
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[tauri::command]
pub fn offline_dictionary_status(db: State<'_, Db>) -> AppResult<OfflineDictionaryStatus> {
    status(&db)
}

/// Queues the ECDICT download and starts it. Offline, it simply waits: the
/// worker retries until it gets through.
#[tauri::command]
pub fn offline_dictionary_download(
    app: AppHandle,
    db: State<'_, Db>,
) -> AppResult<OfflineDictionaryStatus> {
    write_setting(&db, PENDING_KEY, "true")?;
    set_transient(Transient::Idle);
    // A worker cancelled a moment ago may not have noticed yet; this request
    // supersedes the cancel.
    cancel_requested().store(false, Ordering::SeqCst);
    spawn_worker(app.clone());
    clear_lookup_cache();
    let next = status(&db)?;
    let _ = app.emit(STATUS_EVENT, next.clone());
    Ok(next)
}

#[tauri::command]
pub fn offline_dictionary_cancel(
    app: AppHandle,
    db: State<'_, Db>,
) -> AppResult<OfflineDictionaryStatus> {
    write_setting(&db, PENDING_KEY, "false")?;
    if worker_running().load(Ordering::SeqCst) {
        cancel_requested().store(true, Ordering::SeqCst);
    }
    set_transient(Transient::Idle);
    clear_lookup_cache();
    let next = status(&db)?;
    let _ = app.emit(STATUS_EVENT, next.clone());
    Ok(next)
}

#[tauri::command]
pub fn offline_dictionary_remove_ecdict(
    app: AppHandle,
    db: State<'_, Db>,
) -> AppResult<OfflineDictionaryStatus> {
    let root = root(&db)?;
    match fs::remove_file(root.join(ECDICT_FILE)) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(error("OFFLINE_DICTIONARY_REMOVE_FAILED")),
    }
    set_transient(Transient::Idle);
    clear_lookup_cache();
    let next = status(&db)?;
    let _ = app.emit(STATUS_EVENT, next.clone());
    Ok(next)
}

#[tauri::command]
pub async fn offline_dictionary_import_mdx(
    path: String,
    app: AppHandle,
    db: State<'_, Db>,
) -> AppResult<OfflineDictionaryStatus> {
    let root = root(&db)?;
    let source = PathBuf::from(path);
    tauri::async_runtime::spawn_blocking(move || import_mdx_at(&root, &source, now_ms()))
        .await
        .map_err(|_| error("OFFLINE_DICTIONARY_STORAGE_FAILED"))??;
    clear_lookup_cache();
    let next = status(&db)?;
    let _ = app.emit(STATUS_EVENT, next.clone());
    Ok(next)
}

#[tauri::command]
pub fn offline_dictionary_remove_mdx(
    id: String,
    app: AppHandle,
    db: State<'_, Db>,
) -> AppResult<OfflineDictionaryStatus> {
    remove_mdx_at(&root(&db)?, &id)?;
    clear_lookup_cache();
    let next = status(&db)?;
    let _ = app.emit(STATUS_EVENT, next.clone());
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CSV: &str = "word,phonetic,definition,translation,pos,collins,oxford,tag,bnc,frq,exchange,detail,audio\n\
bank,bæŋk,n. sloping land,\"n. 银行, 堤, 岸\\n[医] 库\",,1,1,zk,406,663,s:banks,,\n\
Bank,,,[网络] 班克；银行,,,,,0,0,,,\n\
went,went,v change location,go的过去式,,,,,0,0,0:go/1:p,,\n\
empty,,,,,,,,0,0,,,\n";

    fn build(dir: &Path) -> PathBuf {
        let csv = dir.join("ecdict.csv");
        fs::write(&csv, CSV).unwrap();
        let db = dir.join(ECDICT_FILE);
        assert_eq!(
            build_ecdict_db(&csv, &db).unwrap(),
            3,
            "the row without a translation is skipped"
        );
        db
    }

    #[test]
    fn ecdict_lookup_groups_by_part_of_speech_and_names_its_source() {
        let dir = tempfile::tempdir().unwrap();
        let db = build(dir.path());
        let entry = lookup_ecdict(&db, "bank").unwrap().unwrap();
        assert_eq!(entry.word, "bank");
        assert_eq!(entry.phonetic.as_deref(), Some("bæŋk"));
        assert_eq!(entry.source.as_deref(), Some("ECDICT"));
        assert_eq!(entry.groups[0].pos, "n.");
        assert_eq!(entry.groups[0].senses, vec!["银行", "堤", "岸"]);
        assert_eq!(entry.groups[1].pos, "[医]");
        assert_eq!(entry.groups[1].senses, vec!["库"]);
        assert!(entry.fallback_summary.is_none());
    }

    #[test]
    fn ecdict_lookup_prefers_the_exact_case_but_ignores_case_when_it_must() {
        let dir = tempfile::tempdir().unwrap();
        let db = build(dir.path());
        assert_eq!(
            lookup_ecdict(&db, "Bank").unwrap().unwrap().groups[0].pos,
            "[网络]"
        );
        assert_eq!(lookup_ecdict(&db, "WENT").unwrap().unwrap().word, "went");
        assert!(lookup_ecdict(&db, "nosuchword").unwrap().is_none());
        assert!(lookup_ecdict(&dir.path().join("missing.sqlite"), "bank")
            .unwrap()
            .is_none());
    }

    #[test]
    fn a_line_without_a_part_of_speech_stays_one_unlabelled_group() {
        let groups = ecdict_groups("go的过去式");
        assert_eq!(
            groups,
            vec![(String::new(), vec!["go的过去式".to_string()])]
        );
    }

    #[test]
    fn a_csv_without_the_expected_columns_installs_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let csv = dir.path().join("bad.csv");
        fs::write(&csv, "a,b\n1,2\n").unwrap();
        assert!(build_ecdict_db(&csv, &dir.path().join("out.sqlite")).is_err());
    }

    #[test]
    fn mdict_html_becomes_one_line_per_block_without_scripts_or_styles() {
        let html = "<style>.x{color:red}</style><div class=\"hw\">bank</div>\
                    <p><b>n.</b> 银行；河岸</p><script>alert(1)</script>\
                    <ol><li>v. 存钱</li><li>  依靠  </li></ol>";
        assert_eq!(
            html_to_lines(html),
            vec!["bank", "n. 银行；河岸", "v. 存钱", "依靠"]
        );
    }

    fn write_mdx(path: &Path, title: &str, entries: &[(&str, &str)]) {
        let mut builder = mdictlib::MdxBuilder::with_options(
            mdictlib::WriteOptions::new().with_encoding(mdictlib::WriteEncoding::Utf8),
        );
        builder.header_attribute("Title", title).unwrap();
        for (key, body) in entries {
            builder.add_entry(key, body).unwrap();
        }
        let mut bytes = Vec::new();
        builder.finish(&mut bytes).unwrap();
        fs::write(path, bytes).unwrap();
    }

    #[test]
    fn imported_mdx_is_listed_looked_up_followed_through_links_and_removed() {
        let source_dir = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let source = source_dir.path().join("my-dict.mdx");
        write_mdx(
            &source,
            "我的词典",
            &[
                ("bank", "<div>bank</div><p>n. 银行；河岸</p><p>v. 存钱</p>"),
                ("banks", "@@@LINK=bank"),
            ],
        );

        let meta = import_mdx_at(root.path(), &source, 1).unwrap();
        assert_eq!(meta.title, "我的词典");
        assert_eq!(meta.entries, 2);
        assert_eq!(list_mdx(root.path()), vec![meta.clone()]);

        let entry = lookup_local(root.path(), "Banks").expect("link and case are both followed");
        assert_eq!(entry.word, "bank");
        assert_eq!(entry.source.as_deref(), Some("我的词典"));
        assert_eq!(
            entry.groups.len(),
            2,
            "the repeated headword line is dropped"
        );
        assert_eq!(entry.groups[0].pos, "n.");
        assert_eq!(entry.groups[0].senses, vec!["银行", "河岸"]);
        assert!(lookup_local(root.path(), "nosuchword").is_none());

        remove_mdx_at(root.path(), &meta.id).unwrap();
        assert!(list_mdx(root.path()).is_empty());
        assert!(lookup_local(root.path(), "bank").is_none());
    }

    #[test]
    fn imported_mdx_is_asked_before_ecdict() {
        let source_dir = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        build(root.path());
        let source = source_dir.path().join("mine.mdx");
        write_mdx(
            &source,
            "Title (No HTML code allowed)",
            &[("bank", "<p>n. 我的释义</p>")],
        );
        let meta = import_mdx_at(root.path(), &source, 1).unwrap();
        assert_eq!(
            meta.title, "mine",
            "the authoring tool's placeholder falls back to the file name"
        );

        assert_eq!(
            lookup_local(root.path(), "bank").unwrap().source.as_deref(),
            Some("mine")
        );
        assert_eq!(
            lookup_local(root.path(), "went").unwrap().source.as_deref(),
            Some("ECDICT")
        );
    }

    #[test]
    fn a_file_that_is_not_a_readable_mdx_is_refused_and_leaves_nothing_behind() {
        let source_dir = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let fake = source_dir.path().join("fake.mdx");
        fs::write(&fake, b"not a dictionary").unwrap();
        assert_eq!(
            import_mdx_at(root.path(), &fake, 1)
                .unwrap_err()
                .to_string(),
            "OFFLINE_DICTIONARY_MDX_UNREADABLE"
        );
        let other = source_dir.path().join("dict.txt");
        fs::write(&other, b"x").unwrap();
        assert_eq!(
            import_mdx_at(root.path(), &other, 1)
                .unwrap_err()
                .to_string(),
            "OFFLINE_DICTIONARY_NOT_MDX"
        );
        assert!(!mdx_dir(root.path()).exists());
    }

    #[test]
    fn removing_an_unknown_or_malformed_id_touches_nothing_outside_the_folder() {
        let root = tempfile::tempdir().unwrap();
        assert!(remove_mdx_at(root.path(), "../../lantern").is_err());
        assert!(remove_mdx_at(root.path(), &uuid::Uuid::new_v4().to_string()).is_ok());
    }

    #[test]
    fn only_a_dropped_connection_is_retried() {
        assert!(is_retryable("OFFLINE_DICTIONARY_DOWNLOAD_FAILED"));
        assert!(!is_retryable("OFFLINE_DICTIONARY_HASH_MISMATCH"));
        assert!(!is_retryable("OFFLINE_DICTIONARY_LENGTH_MISMATCH"));
        assert!(!is_retryable("OFFLINE_DICTIONARY_STORAGE_FAILED"));
    }

    #[test]
    fn status_reports_waiting_installed_and_not_downloaded() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(
            ecdict_status(root.path(), false).state,
            EcdictState::NotDownloaded
        );
        assert_eq!(ecdict_status(root.path(), true).state, EcdictState::Waiting);
        build(root.path());
        let installed = ecdict_status(root.path(), false);
        assert_eq!(installed.state, EcdictState::Installed);
        assert!(installed.installed_bytes.unwrap() > 0);
    }
}

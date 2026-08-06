use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::ai::router::{self, AiCredentialView, AiProfileView};
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::secrets::Secrets;
use crate::sync::events::{is_syncable_setting, EventBody, SettingPayload};
use crate::sync::writer::SyncWriter;

const READER_BOOK_SETTING_KEYS: &[&str] = &[
    "theme",
    "font",
    "font_size",
    "line_spacing",
    "word_spacing",
    "char_spacing",
    "text_justification",
    "paragraph_spacing",
    "first_line_indent",
    "reading_mode",
    "page_columns",
    "margins",
    "show_lookup_markers",
    "show_new_vocab_markers",
    "show_learning_markers",
    "show_mastered_markers",
];

/// The global `settings` key a per-book `book_settings` key promotes into.
///
/// `theme`/`font` are renamed because the global rows predate the per-book ones.
/// The four marker toggles reuse their own name: global and per-book live in
/// different tables, so there is no collision, and one name for one concept is
/// less to get wrong than a second spelling that exists only to be different.
fn reader_global_key(book_key: &str) -> Option<&'static str> {
    match book_key {
        "theme" => Some("reader_theme"),
        "font" => Some("font_family"),
        "font_size" => Some("font_size"),
        "line_spacing" => Some("line_spacing"),
        "word_spacing" => Some("word_spacing"),
        "char_spacing" => Some("char_spacing"),
        "text_justification" => Some("text_justification"),
        "paragraph_spacing" => Some("paragraph_spacing"),
        "first_line_indent" => Some("first_line_indent"),
        "reading_mode" => Some("reading_mode"),
        "page_columns" => Some("page_columns"),
        "margins" => Some("margins"),
        "show_lookup_markers" => Some("show_lookup_markers"),
        "show_new_vocab_markers" => Some("show_new_vocab_markers"),
        "show_learning_markers" => Some("show_learning_markers"),
        "show_mastered_markers" => Some("show_mastered_markers"),
        _ => None,
    }
}

/// Whether a global `settings` key is one the reader owns and may therefore be
/// written by the promotion-undo command. Without this the undo payload would
/// be an arbitrary-key write path into `settings`, reachable from the webview.
fn is_reader_global_key(key: &str) -> bool {
    READER_BOOK_SETTING_KEYS
        .iter()
        .any(|book_key| reader_global_key(book_key) == Some(key))
}

fn validate_reader_book_keys(keys: &[String]) -> AppResult<()> {
    if keys
        .iter()
        .any(|key| !READER_BOOK_SETTING_KEYS.contains(&key.as_str()))
    {
        return Err(AppError::Other("READER_SETTING_KEY_INVALID".to_string()));
    }
    Ok(())
}

fn setting_tombstone_id(book_id: &str, key: &str) -> String {
    format!("{book_id}:{key}")
}

/// Write one global `settings` row, clearing any older deletion tombstone first
/// so a re-written key is not immediately re-deleted by its own tombstone.
/// The per-book twin is `set_book_setting_in_tx`.
///
/// Non-whitelisted keys take the same INSERT but are stamped `(0, "")` and emit
/// nothing — they are per-screen preferences that never leave this device, and
/// a real timestamp on them would only invite a peer to argue about it.
fn set_global_setting_in_tx(
    tx: &rusqlite::Transaction<'_>,
    events: &mut Vec<EventBody>,
    key: &str,
    value: &str,
    now: i64,
    device: &str,
) -> AppResult<()> {
    let syncable = is_syncable_setting(false, key);
    if syncable {
        tx.execute(
            "DELETE FROM _tombstones WHERE entity = ?1 AND id = ?2 AND ts < ?3",
            params![crate::sync::merge::entity::SETTING, key, now],
        )?;
    }
    tx.execute(
        "INSERT INTO settings (key, value, updated_at, updated_by_device)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value,
           updated_at = excluded.updated_at,
           updated_by_device = excluded.updated_by_device",
        params![
            key,
            value,
            if syncable { now } else { 0 },
            if syncable { device } else { "" }
        ],
    )?;
    if syncable {
        events.push(EventBody::SettingSet(SettingPayload {
            book: None,
            key: key.to_string(),
            value: Some(value.to_string()),
        }));
    }
    Ok(())
}

/// Drop one global `settings` row and, for a whitelisted key, say so on the
/// wire. The tombstone is what makes the removal survive a peer's next
/// snapshot, which lists the rows that exist and never the ones that went away.
fn delete_global_setting_in_tx(
    tx: &rusqlite::Transaction<'_>,
    events: &mut Vec<EventBody>,
    key: &str,
    now: i64,
) -> AppResult<()> {
    if is_syncable_setting(false, key) {
        crate::sync::merge::insert_tombstone(tx, crate::sync::merge::entity::SETTING, key, now)?;
        events.push(EventBody::SettingSet(SettingPayload {
            book: None,
            key: key.to_string(),
            value: None,
        }));
    }
    tx.execute("DELETE FROM settings WHERE key = ?1", params![key])?;
    Ok(())
}

#[tauri::command]
pub fn get_all_settings(
    db: State<'_, Db>,
    _secrets: State<'_, Secrets>,
) -> AppResult<HashMap<String, String>> {
    // Release the reader lock before asking the AI router for credentials.
    // `list_credentials` may read the same connection again when no profile
    // id is supplied; keeping this guard alive would deadlock the command.
    let mut settings = {
        let conn = db.reader();
        let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
        let result = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .filter_map(|row| match row {
                Ok((key, value)) if !Secrets::is_sensitive_key(&key) => Some(Ok((key, value))),
                Ok(_) => None,
                Err(error) => Some(Err(error)),
            })
            .collect::<Result<HashMap<_, _>, _>>()?;
        result
    };

    // This status is deliberately metadata-only: whether a service is
    // configured, never the value. Credentials are read only when a request
    // actually needs one.
    let configured = router::has_configured_service(&db);
    settings.insert("ai_api_key_configured".to_string(), configured.to_string());

    Ok(settings)
}

#[tauri::command]
pub fn ai_api_key_configured(db: State<'_, Db>) -> bool {
    router::has_configured_service(&db)
}

#[tauri::command]
pub fn ai_vector_retrieval_status(
    db: State<'_, Db>,
    secrets: State<'_, Secrets>,
) -> AppResult<crate::ai::grounding::vector::VectorAvailability> {
    crate::ai::grounding::vector::availability(&db, &secrets)
}

#[tauri::command]
pub async fn set_ai_vector_retrieval(
    enabled: bool,
    db: State<'_, Db>,
    secrets: State<'_, Secrets>,
) -> AppResult<()> {
    if enabled {
        crate::ai::grounding::vector::enable(&db, &secrets).await
    } else {
        let conn = db
            .conn
            .lock()
            .map_err(|error| AppError::Other(error.to_string()))?;
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('ai_vector_retrieval', 'false')
             ON CONFLICT(key) DO UPDATE SET value = 'false'",
            [],
        )?;
        Ok(())
    }
}

#[tauri::command]
pub async fn ai_embedding_probe(
    endpoint: String,
    model: String,
    api_key: Option<String>,
    db: State<'_, Db>,
    secrets: State<'_, Secrets>,
) -> AppResult<crate::ai::grounding::vector::EmbeddingProbeResult> {
    crate::ai::grounding::vector::probe_and_save(&db, &secrets, endpoint, model, api_key).await
}

#[tauri::command]
pub fn get_setting(key: String, db: State<'_, Db>) -> AppResult<Option<String>> {
    if Secrets::is_sensitive_key(&key) {
        return Err(AppError::Other("SECRET_READ_FORBIDDEN".to_string()));
    }
    get_setting_value(&db, &key)
}

/// The body of `get_setting`, without the webview boundary — for a caller
/// that already holds a `&Db` and is not a command handler itself, e.g.
/// `icloud::cellular::enforce` reading the remembered cellular-download
/// answer. Callers reading a key they picked themselves (not one that arrived
/// from the webview) may skip `get_setting`'s `is_sensitive_key` check; this
/// function does not repeat it.
pub(crate) fn get_setting_value(db: &Db, key: &str) -> AppResult<Option<String>> {
    let conn = db.reader();
    let result = conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![key],
        |row| row.get(0),
    );
    match result {
        Ok(value) => Ok(Some(value)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

#[tauri::command]
pub fn set_setting(
    key: String,
    value: String,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<()> {
    let mut settings = HashMap::new();
    settings.insert(key, value);
    set_settings_bulk_inner(&settings, &db, &sync)
}

#[tauri::command]
pub fn set_settings_bulk(
    settings: HashMap<String, String>,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<()> {
    set_settings_bulk_inner(&settings, &db, &sync)
}

/// Write global settings, publishing only the whitelisted keys.
///
/// The `settings` table stays local-only as a table -- theme and font size are
/// per-screen preferences that have no business crossing devices. `font_family`,
/// the four marker-visibility toggles and `book_sources` are the exceptions; see
/// `events::is_syncable_setting` for why each one earns it. Non-whitelisted keys
/// never reach the log at all, so the event stream stays clean rather than being
/// filtered on read.
///
/// The clock is `next_logical_timestamp`, not `Utc::now`, and that matters now
/// that a global setting can be deleted: the delete stamps a tombstone from the
/// logical clock, which is `max(wall_clock, previous + 1)` and so can run ahead
/// of the wall clock. A write taking the raw wall clock could land *behind* a
/// tombstone written moments earlier and lose to it.
fn set_settings_bulk_inner(
    settings: &HashMap<String, String>,
    db: &Db,
    sync: &SyncWriter,
) -> AppResult<()> {
    if settings.keys().any(|key| Secrets::is_sensitive_key(key)) {
        return Err(AppError::Other(
            "SECRET_WRITE_REQUIRES_DEDICATED_COMMAND".to_string(),
        ));
    }

    let now = sync.next_logical_timestamp();
    let device = sync.self_device().to_string();
    sync.with_tx(db, now, |tx, events| {
        for (key, value) in settings {
            set_global_setting_in_tx(tx, events, key, value, now, &device)?;
        }
        Ok(())
    })
}

#[tauri::command]
pub fn set_ai_api_key(
    value: String,
    db: State<'_, Db>,
    secrets: State<'_, Secrets>,
) -> AppResult<()> {
    let profile = router::active_profile_view(&db)?;
    let existing = router::list_credentials(&db, Some(&profile.id))?;
    if let Some(credential) = existing.first() {
        router::replace_credential(&db, &secrets, &credential.id, &value)
    } else {
        router::add_credential(&db, &secrets, profile.id, "Primary key".to_string(), value)
            .map(|_| ())
    }
}

#[tauri::command]
pub fn ai_active_profile(db: State<'_, Db>) -> AppResult<AiProfileView> {
    router::active_profile_view(&db)
}

#[tauri::command]
pub fn ai_list_profiles(db: State<'_, Db>) -> AppResult<Vec<AiProfileView>> {
    router::list_profiles(&db)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn ai_create_profile(
    label: String,
    provider: String,
    auth_mode: String,
    base_url: Option<String>,
    model: String,
    temperature: f64,
    reasoning_effort: Option<String>,
    reasoning_effort_all_features: Option<bool>,
    keep_alive: Option<String>,
    enabled: Option<bool>,
    db: State<'_, Db>,
) -> AppResult<AiProfileView> {
    router::create_profile(
        &db,
        label,
        provider,
        auth_mode,
        base_url,
        model,
        temperature,
        reasoning_effort,
        reasoning_effort_all_features.unwrap_or(false),
        keep_alive,
        enabled.unwrap_or(true),
    )
}

#[tauri::command]
pub fn ai_duplicate_profile(
    id: String,
    label: Option<String>,
    db: State<'_, Db>,
) -> AppResult<AiProfileView> {
    router::duplicate_profile(&db, &id, label)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn ai_save_profile(
    id: String,
    label: String,
    provider: String,
    auth_mode: String,
    base_url: Option<String>,
    model: String,
    temperature: f64,
    reasoning_effort: Option<String>,
    reasoning_effort_all_features: Option<bool>,
    keep_alive: Option<String>,
    db: State<'_, Db>,
) -> AppResult<AiProfileView> {
    router::save_profile(
        &db,
        id,
        label,
        provider,
        auth_mode,
        base_url,
        model,
        temperature,
        reasoning_effort,
        reasoning_effort_all_features.unwrap_or(false),
        keep_alive,
    )
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn ai_update_profile(
    id: String,
    label: String,
    provider: String,
    auth_mode: String,
    base_url: Option<String>,
    model: String,
    temperature: f64,
    reasoning_effort: Option<String>,
    reasoning_effort_all_features: Option<bool>,
    keep_alive: Option<String>,
    db: State<'_, Db>,
) -> AppResult<AiProfileView> {
    router::save_profile(
        &db,
        id,
        label,
        provider,
        auth_mode,
        base_url,
        model,
        temperature,
        reasoning_effort,
        reasoning_effort_all_features.unwrap_or(false),
        keep_alive,
    )
}

#[tauri::command]
pub fn ai_set_profile_enabled(id: String, enabled: bool, db: State<'_, Db>) -> AppResult<()> {
    router::set_profile_enabled(&db, &id, enabled)
}

#[tauri::command]
pub fn ai_reorder_profiles(ids: Vec<String>, db: State<'_, Db>) -> AppResult<()> {
    router::reorder_profiles(&db, &ids)
}

#[tauri::command]
pub fn ai_delete_profile(
    id: String,
    db: State<'_, Db>,
    secrets: State<'_, Secrets>,
) -> AppResult<()> {
    router::delete_profile(&db, &secrets, &id)
}

#[tauri::command]
pub async fn ai_list_models(
    profile_id: String,
    provider: String,
    auth_mode: String,
    base_url: Option<String>,
    db: State<'_, Db>,
    secrets: State<'_, Secrets>,
) -> AppResult<Vec<String>> {
    router::list_models(&db, &secrets, &profile_id, provider, auth_mode, base_url).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ai_test_profile(
    id: String,
    provider: String,
    auth_mode: String,
    base_url: Option<String>,
    model: String,
    temperature: f64,
    reasoning_effort: Option<String>,
    keep_alive: Option<String>,
    app: AppHandle,
    db: State<'_, Db>,
    secrets: State<'_, Secrets>,
) -> AppResult<router::AiConnectionTestResult> {
    router::test_profile(
        &app,
        &db,
        &secrets,
        &id,
        provider,
        auth_mode,
        base_url,
        model,
        temperature,
        reasoning_effort,
        keep_alive,
    )
    .await
}

/// Effort levels this endpoint told us it accepts, learned from a rejected
/// request. Empty until a rejection actually spelled them out.
#[tauri::command]
pub fn ai_reasoning_effort_options(
    provider: String,
    base_url: Option<String>,
    model: String,
    db: State<'_, Db>,
) -> AppResult<router::EffortHints> {
    router::reasoning_effort_options(&db, &provider, base_url.as_deref(), &model)
}

#[tauri::command]
pub fn ai_forget_reasoning_effort_options(
    provider: String,
    base_url: Option<String>,
    model: String,
    db: State<'_, Db>,
) -> AppResult<()> {
    router::forget_reasoning_effort_options(&db, &provider, base_url.as_deref(), &model)
}

#[tauri::command]
pub fn ai_list_credentials(
    profile_id: Option<String>,
    db: State<'_, Db>,
) -> AppResult<Vec<AiCredentialView>> {
    router::list_credentials(&db, profile_id.as_deref())
}

#[tauri::command]
pub fn ai_add_credential(
    profile_id: String,
    label: String,
    value: String,
    db: State<'_, Db>,
    secrets: State<'_, Secrets>,
) -> AppResult<AiCredentialView> {
    router::add_credential(&db, &secrets, profile_id, label, value)
}

#[tauri::command]
pub fn ai_replace_credential(
    id: String,
    value: String,
    db: State<'_, Db>,
    secrets: State<'_, Secrets>,
) -> AppResult<()> {
    router::replace_credential(&db, &secrets, &id, &value)
}

#[tauri::command]
pub fn ai_set_credential_enabled(id: String, enabled: bool, db: State<'_, Db>) -> AppResult<()> {
    router::set_credential_enabled(&db, &id, enabled)
}

#[tauri::command]
pub fn ai_reorder_credentials(ids: Vec<String>, db: State<'_, Db>) -> AppResult<()> {
    router::reorder_credentials(&db, &ids)
}

#[tauri::command]
pub fn ai_delete_credential(
    id: String,
    db: State<'_, Db>,
    secrets: State<'_, Secrets>,
) -> AppResult<()> {
    router::delete_credential(&db, &secrets, &id)
}

#[tauri::command]
pub async fn ai_test_credential(
    id: String,
    app: AppHandle,
    db: State<'_, Db>,
    secrets: State<'_, Secrets>,
) -> AppResult<()> {
    router::test_credential(&app, &db, &secrets, &id).await
}

#[tauri::command]
pub fn get_book_settings(book_id: String, db: State<'_, Db>) -> AppResult<HashMap<String, String>> {
    let conn = db.reader();
    let mut stmt = conn.prepare("SELECT key, value FROM book_settings WHERE book_id = ?1")?;
    let settings = stmt
        .query_map(params![book_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<HashMap<_, _>, _>>()?;
    Ok(settings)
}

#[derive(Debug, Serialize)]
pub struct ReaderSettingConflict {
    pub id: String,
    pub title: String,
    pub author: String,
    pub conflicting_keys: Vec<String>,
}

/// One `book_settings` row that promotion deleted, kept whole so undo can put
/// it back on the book it came from rather than on whatever book is open now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PromotedBookSetting {
    pub book_id: String,
    pub key: String,
    pub value: String,
}

/// Everything promotion displaced, in the shape the frontend holds until the
/// undo toast expires and hands straight back to `undo_promote_book_settings`.
///
/// `globals` maps a global key to the value it held **before** the promotion.
/// `None` means the key had no row at all, and undo must delete it — writing
/// `""` there would leave a row that resolves to a value the user never chose.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReaderSettingsPromotionUndo {
    pub globals: HashMap<String, Option<String>>,
    pub book_settings: Vec<PromotedBookSetting>,
}

#[derive(Debug, Serialize)]
pub struct ReaderSettingsPromotion {
    pub settings: HashMap<String, String>,
    pub promoted_keys: Vec<String>,
    pub undo: ReaderSettingsPromotionUndo,
}

#[tauri::command]
pub fn delete_book_settings(
    book_id: String,
    keys: Vec<String>,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<HashMap<String, String>> {
    do_delete_book_settings(&book_id, &keys, &db, &sync)
}

fn delete_book_setting_in_tx(
    tx: &rusqlite::Transaction<'_>,
    events: &mut Vec<EventBody>,
    book_id: &str,
    key: &str,
    now: i64,
) -> AppResult<Option<String>> {
    let value = tx
        .query_row(
            "SELECT value FROM book_settings WHERE book_id = ?1 AND key = ?2",
            params![book_id, key],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if value.is_none() {
        return Ok(None);
    }
    tx.execute(
        "DELETE FROM book_settings WHERE book_id = ?1 AND key = ?2",
        params![book_id, key],
    )?;
    if is_syncable_setting(true, key) {
        crate::sync::merge::insert_tombstone(
            tx,
            crate::sync::merge::entity::BOOK_SETTING,
            &setting_tombstone_id(book_id, key),
            now,
        )?;
        events.push(EventBody::SettingSet(SettingPayload {
            book: Some(book_id.to_string()),
            key: key.to_string(),
            value: None,
        }));
    }
    Ok(value)
}

pub(crate) fn do_delete_book_settings(
    book_id: &str,
    keys: &[String],
    db: &Db,
    sync: &SyncWriter,
) -> AppResult<HashMap<String, String>> {
    validate_reader_book_keys(keys)?;
    let now = sync.next_logical_timestamp();
    sync.with_tx(db, now, |tx, events| {
        let mut deleted = HashMap::new();
        for key in keys {
            if let Some(value) = delete_book_setting_in_tx(tx, events, book_id, key, now)? {
                deleted.insert(key.clone(), value);
            }
        }
        Ok(deleted)
    })
}

#[tauri::command]
pub fn list_reader_setting_conflicts(
    source_book_id: String,
    keys: Vec<String>,
    db: State<'_, Db>,
) -> AppResult<Vec<ReaderSettingConflict>> {
    validate_reader_book_keys(&keys)?;
    if keys.iter().any(|key| reader_global_key(key).is_none()) {
        return Err(AppError::Other("READER_SETTING_NOT_PROMOTABLE".to_string()));
    }
    let wanted = keys.into_iter().collect::<HashSet<_>>();
    let conn = db.reader();
    let mut stmt = conn.prepare(
        "SELECT b.id, b.title, COALESCE(b.author, ''), bs.key
         FROM books b
         JOIN book_settings bs ON bs.book_id = b.id
         WHERE b.id <> ?1
         ORDER BY lower(b.title), b.id, bs.key",
    )?;
    let rows = stmt.query_map(params![source_book_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
        ))
    })?;
    let mut conflicts: BTreeMap<String, ReaderSettingConflict> = BTreeMap::new();
    for row in rows {
        let (id, title, author, key) = row?;
        if !wanted.contains(&key) {
            continue;
        }
        conflicts
            .entry(id.clone())
            .or_insert_with(|| ReaderSettingConflict {
                id,
                title,
                author,
                conflicting_keys: Vec::new(),
            })
            .conflicting_keys
            .push(key);
    }
    Ok(conflicts.into_values().collect())
}

#[tauri::command]
pub fn promote_book_settings_to_global(
    source_book_id: String,
    selected_book_ids: Vec<String>,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<ReaderSettingsPromotion> {
    do_promote_book_settings_to_global(&source_book_id, &selected_book_ids, &db, &sync)
}

pub(crate) fn do_promote_book_settings_to_global(
    source_book_id: &str,
    selected_book_ids: &[String],
    db: &Db,
    sync: &SyncWriter,
) -> AppResult<ReaderSettingsPromotion> {
    let now = sync.next_logical_timestamp();
    let device = sync.self_device().to_string();
    sync.with_tx(db, now, |tx, events| {
        let mut stmt =
            tx.prepare("SELECT key, value FROM book_settings WHERE book_id = ?1 ORDER BY key")?;
        let rows = stmt
            .query_map(params![source_book_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);

        let promoted = rows
            .into_iter()
            .filter_map(|(book_key, value)| {
                reader_global_key(&book_key).map(|global_key| (book_key, global_key, value))
            })
            .collect::<Vec<_>>();
        if promoted.is_empty() {
            return Err(AppError::Other(
                "READER_SETTINGS_NOTHING_TO_PROMOTE".to_string(),
            ));
        }

        let mut changed_settings = HashMap::new();
        let mut undo = ReaderSettingsPromotionUndo::default();
        for (_, global_key, value) in &promoted {
            // Read before the upsert: `ON CONFLICT DO UPDATE` is what makes this
            // a one-way door, and this row is the only copy of what it displaced.
            let previous = tx
                .query_row(
                    "SELECT value FROM settings WHERE key = ?1",
                    params![global_key],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            undo.globals.insert((*global_key).to_string(), previous);
            set_global_setting_in_tx(tx, events, global_key, value, now, &device)?;
            changed_settings.insert((*global_key).to_string(), value.clone());
        }

        // Ordered so the undo payload — and the tests that pin it — is
        // deterministic rather than hash-ordered.
        let mut targets = selected_book_ids.iter().cloned().collect::<BTreeSet<_>>();
        targets.insert(source_book_id.to_string());
        for target in targets {
            for (book_key, _, _) in &promoted {
                if let Some(value) = delete_book_setting_in_tx(tx, events, &target, book_key, now)?
                {
                    undo.book_settings.push(PromotedBookSetting {
                        book_id: target.clone(),
                        key: book_key.clone(),
                        value,
                    });
                }
            }
        }

        Ok(ReaderSettingsPromotion {
            settings: changed_settings,
            promoted_keys: promoted.into_iter().map(|(key, _, _)| key).collect(),
            undo,
        })
    })
}

/// Put back everything one `promote_book_settings_to_global` displaced.
///
/// Mirrors the 「恢复跟随全局」 undo: the command that made the change hands the
/// caller the displaced values, the caller holds them for as long as the undo
/// affordance is on screen, and hands the same payload straight back here. The
/// payload is therefore untrusted webview input — every key is re-validated
/// against the reader's own key sets before a single row is touched.
#[tauri::command]
pub fn undo_promote_book_settings(
    undo: ReaderSettingsPromotionUndo,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<()> {
    do_undo_promote_book_settings(&undo, &db, &sync)
}

pub(crate) fn do_undo_promote_book_settings(
    undo: &ReaderSettingsPromotionUndo,
    db: &Db,
    sync: &SyncWriter,
) -> AppResult<()> {
    if undo.globals.keys().any(|key| !is_reader_global_key(key)) {
        return Err(AppError::Other("READER_SETTING_KEY_INVALID".to_string()));
    }
    validate_reader_book_keys(
        &undo
            .book_settings
            .iter()
            .map(|row| row.key.clone())
            .collect::<Vec<_>>(),
    )?;

    let now = sync.next_logical_timestamp();
    let device = sync.self_device().to_string();
    sync.with_tx(db, now, |tx, events| {
        for (global_key, previous) in &undo.globals {
            let Some(value) = previous else {
                // No row before the promotion, so undo removes the row rather
                // than writing "" — an empty string is a value, and every
                // reader setting would parse it as something.
                //
                // For a whitelisted key this is a real deletion on the wire: a
                // `setting` tombstone plus a `setting.set` carrying `null`. Both
                // are needed. The event tells a peer that is listening; the
                // tombstone is what stops that peer's next snapshot — which
                // lists the rows that exist, never the ones that went away —
                // from handing the promoted value straight back.
                delete_global_setting_in_tx(tx, events, global_key, now)?;
                continue;
            };
            set_global_setting_in_tx(tx, events, global_key, value, now, &device)?;
        }
        for row in &undo.book_settings {
            set_book_setting_in_tx(tx, events, &row.book_id, &row.key, &row.value, now, &device)?;
        }
        Ok(())
    })
}

#[tauri::command]
pub fn set_book_settings_bulk(
    book_id: String,
    settings: HashMap<String, String>,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<()> {
    do_set_book_settings_bulk(&book_id, &settings, &db, &sync)
}

/// Same whitelist rule as the global writer: `font` and the four
/// marker-visibility toggles publish, everything else stays on this device.
///
/// The reader panel is the caller: `useReaderSettingsSync` writes one debounced
/// batch per settle, with the row's existence standing for "this book overrides
/// the global setting". See docs/impls/handoff-per-book-font-sync.md.
pub(crate) fn do_set_book_settings_bulk(
    book_id: &str,
    settings: &HashMap<String, String>,
    db: &Db,
    sync: &SyncWriter,
) -> AppResult<()> {
    let now = sync.next_logical_timestamp();
    let device = sync.self_device().to_string();
    sync.with_tx(db, now, |tx, events| {
        for (key, value) in settings {
            set_book_setting_in_tx(tx, events, book_id, key, value, now, &device)?;
        }
        Ok(())
    })
}

/// Write one `book_settings` row, clearing any older deletion tombstone first so
/// a restored override is not immediately re-deleted by its own tombstone.
fn set_book_setting_in_tx(
    tx: &rusqlite::Transaction<'_>,
    events: &mut Vec<EventBody>,
    book_id: &str,
    key: &str,
    value: &str,
    now: i64,
    device: &str,
) -> AppResult<()> {
    let syncable = is_syncable_setting(true, key);
    if syncable {
        tx.execute(
            "DELETE FROM _tombstones WHERE entity = ?1 AND id = ?2 AND ts < ?3",
            params![
                crate::sync::merge::entity::BOOK_SETTING,
                setting_tombstone_id(book_id, key),
                now
            ],
        )?;
    }
    tx.execute(
        "INSERT INTO book_settings (book_id, key, value, updated_at, updated_by_device)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(book_id, key) DO UPDATE SET value = excluded.value,
           updated_at = excluded.updated_at,
           updated_by_device = excluded.updated_by_device",
        params![
            book_id,
            key,
            value,
            if syncable { now } else { 0 },
            if syncable { device } else { "" }
        ],
    )?;
    if syncable {
        events.push(EventBody::SettingSet(SettingPayload {
            book: Some(book_id.to_string()),
            key: key.to_string(),
            value: Some(value.to_string()),
        }));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        do_delete_book_settings, do_promote_book_settings_to_global, do_set_book_settings_bulk,
        do_undo_promote_book_settings, set_settings_bulk_inner, PromotedBookSetting,
        ReaderSettingsPromotionUndo,
    };
    use crate::db::Db;
    use crate::sync::events::{Event, EventBody, EVENT_SCHEMA_VERSION};
    use crate::sync::snapshot::Snapshot;
    use crate::sync::writer::SyncWriter;
    use rusqlite::{params, Connection, OptionalExtension};
    use std::collections::HashMap;
    use tempfile::TempDir;

    /// Everything this device queued for its peers, rebuilt into the events a
    /// peer would actually receive. Ordered by insertion, which is the order
    /// the log is appended in.
    ///
    /// The stream is prefixed with `book1`'s import, because `setup` puts that
    /// row in with raw SQL rather than through the importer. Without it the
    /// stream is not a stream any device could produce: `book_settings` has a
    /// foreign key onto `books`, so a peer replaying from empty would fail.
    fn published_events(db: &Db, device: &str) -> Vec<Event> {
        let import = Event {
            // Sorts before every queued event's synthetic id below.
            id: "01HYZW0000000000000000000Z".to_string(),
            ts: 1,
            device: device.to_string(),
            v: EVENT_SCHEMA_VERSION,
            body: EventBody::BookImport(crate::sync::events::BookImportPayload {
                id: "book1".to_string(),
                title: "Test Book".to_string(),
                author: "Author".to_string(),
                description: None,
                cover_path: None,
                file_path: "books/test.epub".to_string(),
                format: "epub".to_string(),
                source_format: None,
                render_format: None,
                source_file_path: None,
                source_sha256: None,
                conversion_version: 0,
                genre: None,
                pages: None,
            }),
            extra: serde_json::Map::new(),
        };
        std::iter::once(import)
            .chain(queued_events(db, device))
            .collect()
    }

    /// Just the rows the writer parked in `_pending_publish`, in log order.
    fn queued_events(db: &Db, device: &str) -> Vec<Event> {
        let conn = db.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, ts, body_json FROM _pending_publish ORDER BY rowid")
            .unwrap();
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        drop(stmt);
        rows.into_iter()
            .enumerate()
            .map(|(index, (_, ts, body_json))| Event {
                // A ULID that sorts with the row order; the merge engine keys
                // off `ts`, and the snapshot builder only needs them ordered.
                id: format!("01HYZX00000000000000{index:06X}"),
                ts,
                device: device.to_string(),
                v: EVENT_SCHEMA_VERSION,
                body: serde_json::from_str::<EventBody>(&body_json).unwrap(),
                extra: serde_json::Map::new(),
            })
            .collect()
    }

    /// A second device: a bare migrated DB that only ever sees `dev-A`'s
    /// events. No `SyncWriter`, because a peer applies rather than writes, and
    /// nothing seeded — the stream is expected to carry everything it needs.
    fn peer_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        Db::run_migrations_on(&conn).unwrap();
        conn
    }

    fn peer_global(conn: &Connection, key: &str) -> Option<String> {
        conn.query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()
        .unwrap()
    }

    fn setup() -> (TempDir, Db) {
        let dir = TempDir::new().unwrap();
        let db = Db::init(dir.path()).unwrap();
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO books (id, title, author, file_path, status, progress, created_at, updated_at)
             VALUES ('book1', 'Test Book', 'Author', 'books/test.epub', 'reading', 0, '2024-01-01', '2024-01-01')",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO books (id, title, author, file_path, status, progress, created_at, updated_at)
             VALUES ('book2', 'Second Book', 'Author 2', 'books/test2.epub', 'reading', 0, '2024-01-01', '2024-01-01')",
            [],
        ).unwrap();
        drop(conn);
        (dir, db)
    }

    fn get_book_settings(db: &Db, book_id: &str) -> HashMap<String, String> {
        let conn = db.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT key, value FROM book_settings WHERE book_id = ?1")
            .unwrap();
        stmt.query_map(params![book_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .unwrap()
        .collect::<Result<HashMap<_, _>, _>>()
        .unwrap()
    }

    fn set_book_settings_bulk(db: &Db, book_id: &str, settings: HashMap<String, String>) {
        let sync = SyncWriter::new("dev-A".into());
        do_set_book_settings_bulk(book_id, &settings, db, &sync).unwrap();
    }

    #[test]
    fn bulk_settings_validate_before_writing_any_value() {
        let (_dir, db) = setup();
        let mut settings = HashMap::new();
        settings.insert("reader_theme".to_string(), "night".to_string());
        settings.insert("ai_api_key".to_string(), "must-not-write".to_string());

        let sync = SyncWriter::new("dev-A".into());
        let error = set_settings_bulk_inner(&settings, &db, &sync).unwrap_err();
        assert_eq!(error.to_string(), "SECRET_WRITE_REQUIRES_DEDICATED_COMMAND");

        let conn = db.conn.lock().unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM settings WHERE key = 'reader_theme' OR key = 'ai_api_key'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn test_book_settings_roundtrip() {
        let (_dir, db) = setup();
        let mut settings = HashMap::new();
        settings.insert("font_family".to_string(), "inter".to_string());
        settings.insert("font_size".to_string(), "32".to_string());

        set_book_settings_bulk(&db, "book1", settings);

        let result = get_book_settings(&db, "book1");
        assert_eq!(result.get("font_family").unwrap(), "inter");
        assert_eq!(result.get("font_size").unwrap(), "32");
    }

    #[test]
    fn test_book_settings_isolation() {
        let (_dir, db) = setup();

        let mut s1 = HashMap::new();
        s1.insert("font_family".to_string(), "inter".to_string());
        set_book_settings_bulk(&db, "book1", s1);

        let mut s2 = HashMap::new();
        s2.insert("font_family".to_string(), "georgia".to_string());
        set_book_settings_bulk(&db, "book2", s2);

        assert_eq!(
            get_book_settings(&db, "book1").get("font_family").unwrap(),
            "inter"
        );
        assert_eq!(
            get_book_settings(&db, "book2").get("font_family").unwrap(),
            "georgia"
        );
    }

    #[test]
    fn test_book_settings_cleaned_on_book_delete() {
        let (_dir, db) = setup();

        let mut settings = HashMap::new();
        settings.insert("font_size".to_string(), "28".to_string());
        set_book_settings_bulk(&db, "book1", settings);

        assert_eq!(get_book_settings(&db, "book1").len(), 1);

        let conn = db.conn.lock().unwrap();
        conn.execute("DELETE FROM book_settings WHERE book_id = 'book1'", [])
            .unwrap();
        conn.execute("DELETE FROM books WHERE id = 'book1'", [])
            .unwrap();
        drop(conn);

        assert!(get_book_settings(&db, "book1").is_empty());
    }

    #[test]
    fn test_book_settings_upsert() {
        let (_dir, db) = setup();

        let mut s1 = HashMap::new();
        s1.insert("font_size".to_string(), "24".to_string());
        set_book_settings_bulk(&db, "book1", s1);

        let mut s2 = HashMap::new();
        s2.insert("font_size".to_string(), "30".to_string());
        set_book_settings_bulk(&db, "book1", s2);

        assert_eq!(
            get_book_settings(&db, "book1").get("font_size").unwrap(),
            "30"
        );
    }

    #[test]
    fn deleting_reader_overrides_preserves_unrelated_rows_and_tombstones_font() {
        let (_dir, db) = setup();
        let sync = SyncWriter::new("dev-A".into());
        let settings = HashMap::from([
            ("font".to_string(), "literata".to_string()),
            ("font_size".to_string(), "24".to_string()),
            ("toc_expanded".to_string(), "[]".to_string()),
        ]);
        do_set_book_settings_bulk("book1", &settings, &db, &sync).unwrap();

        let deleted = do_delete_book_settings(
            "book1",
            &["font".to_string(), "font_size".to_string()],
            &db,
            &sync,
        )
        .unwrap();

        assert_eq!(deleted.get("font").map(String::as_str), Some("literata"));
        assert_eq!(deleted.get("font_size").map(String::as_str), Some("24"));
        assert_eq!(
            get_book_settings(&db, "book1")
                .get("toc_expanded")
                .map(String::as_str),
            Some("[]")
        );
        let conn = db.conn.lock().unwrap();
        let tombstone: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM _tombstones
                 WHERE entity = 'book_setting' AND id = 'book1:font'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(tombstone, 1);
    }

    fn get_global_setting(db: &Db, key: &str) -> Option<String> {
        let conn = db.conn.lock().unwrap();
        conn.query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .unwrap()
    }

    #[test]
    fn promotion_is_atomic_and_only_clears_overlapping_promoted_keys() {
        let (_dir, db) = setup();
        let sync = SyncWriter::new("dev-A".into());
        do_set_book_settings_bulk(
            "book1",
            &HashMap::from([
                ("font".to_string(), "literata".to_string()),
                ("font_size".to_string(), "24".to_string()),
                ("show_lookup_markers".to_string(), "false".to_string()),
                // Not a reader setting at all, so it has no global counterpart
                // and must survive promotion untouched.
                ("toc_expanded".to_string(), "[]".to_string()),
            ]),
            &db,
            &sync,
        )
        .unwrap();
        do_set_book_settings_bulk(
            "book2",
            &HashMap::from([
                ("font_size".to_string(), "19".to_string()),
                ("line_spacing".to_string(), "2.1".to_string()),
            ]),
            &db,
            &sync,
        )
        .unwrap();

        let result =
            do_promote_book_settings_to_global("book1", &["book2".to_string()], &db, &sync)
                .unwrap();
        assert_eq!(
            result.settings.get("font_family").map(String::as_str),
            Some("literata")
        );
        assert_eq!(
            result.settings.get("font_size").map(String::as_str),
            Some("24")
        );
        // Marker visibility now has a global layer, so it promotes like the
        // typography keys instead of being silently left behind.
        assert_eq!(
            result
                .settings
                .get("show_lookup_markers")
                .map(String::as_str),
            Some("false")
        );

        let source = get_book_settings(&db, "book1");
        assert!(!source.contains_key("show_lookup_markers"));
        assert!(!source.contains_key("font"));
        assert!(!source.contains_key("font_size"));
        // The non-promotable row is the one that still survives.
        assert_eq!(source.get("toc_expanded").map(String::as_str), Some("[]"));

        let selected = get_book_settings(&db, "book2");
        assert!(!selected.contains_key("font_size"));
        assert_eq!(
            selected.get("line_spacing").map(String::as_str),
            Some("2.1")
        );
    }

    #[test]
    fn undoing_a_promotion_restores_globals_and_every_deleted_override() {
        let (_dir, db) = setup();
        let sync = SyncWriter::new("dev-A".into());
        // `font_family` had a global row before the promotion; the marker key
        // deliberately does not, which is the case undo must delete rather than
        // write back as an empty string.
        set_settings_bulk_inner(
            &HashMap::from([("font_family".to_string(), "georgia".to_string())]),
            &db,
            &sync,
        )
        .unwrap();
        do_set_book_settings_bulk(
            "book1",
            &HashMap::from([
                ("font".to_string(), "literata".to_string()),
                ("show_lookup_markers".to_string(), "false".to_string()),
            ]),
            &db,
            &sync,
        )
        .unwrap();
        do_set_book_settings_bulk(
            "book2",
            &HashMap::from([
                ("font".to_string(), "palatino".to_string()),
                ("show_lookup_markers".to_string(), "true".to_string()),
            ]),
            &db,
            &sync,
        )
        .unwrap();

        let result =
            do_promote_book_settings_to_global("book1", &["book2".to_string()], &db, &sync)
                .unwrap();
        assert_eq!(
            get_global_setting(&db, "font_family").as_deref(),
            Some("literata")
        );
        assert_eq!(
            get_global_setting(&db, "show_lookup_markers").as_deref(),
            Some("false")
        );
        assert!(get_book_settings(&db, "book1").is_empty());
        assert!(get_book_settings(&db, "book2").is_empty());

        assert_eq!(
            result.undo.globals.get("font_family"),
            Some(&Some("georgia".to_string()))
        );
        assert_eq!(result.undo.globals.get("show_lookup_markers"), Some(&None));

        do_undo_promote_book_settings(&result.undo, &db, &sync).unwrap();

        assert_eq!(
            get_global_setting(&db, "font_family").as_deref(),
            Some("georgia")
        );
        // Absent before, absent again — not `""`.
        assert_eq!(get_global_setting(&db, "show_lookup_markers"), None);
        assert_eq!(
            get_book_settings(&db, "book1"),
            HashMap::from([
                ("font".to_string(), "literata".to_string()),
                ("show_lookup_markers".to_string(), "false".to_string()),
            ])
        );
        assert_eq!(
            get_book_settings(&db, "book2"),
            HashMap::from([
                ("font".to_string(), "palatino".to_string()),
                ("show_lookup_markers".to_string(), "true".to_string()),
            ])
        );
    }

    #[test]
    fn a_restored_syncable_override_outlives_the_promotion_tombstone() {
        // `font` is the one per-book key that syncs, so promotion tombstones it.
        // A restored row that the tombstone then swallowed would come back only
        // until the next replay tick.
        let (_dir, db) = setup();
        let sync = SyncWriter::new("dev-A".into());
        do_set_book_settings_bulk(
            "book1",
            &HashMap::from([("font".to_string(), "literata".to_string())]),
            &db,
            &sync,
        )
        .unwrap();
        let result = do_promote_book_settings_to_global("book1", &[], &db, &sync).unwrap();
        do_undo_promote_book_settings(&result.undo, &db, &sync).unwrap();

        assert_eq!(
            get_book_settings(&db, "book1")
                .get("font")
                .map(String::as_str),
            Some("literata")
        );
        let conn = db.conn.lock().unwrap();
        let tombstone: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM _tombstones
                 WHERE entity = 'book_setting' AND id = 'book1:font'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(tombstone, 0, "the restored row must not stay tombstoned");
    }

    /// The whole bug, end to end, on two devices: promote a book's reader
    /// settings to global, then undo. The undo deletes a global row that had no
    /// value before the promotion, and that deletion has to reach the peer —
    /// otherwise the peer keeps the promoted value and hands it back on its
    /// next snapshot, silently un-undoing the undo.
    ///
    /// Both transports are checked, because they fail differently: the event
    /// path can carry the delete and still lose it to a later snapshot, and the
    /// snapshot path only works if the tombstone is what rides along.
    #[test]
    fn promotion_undo_converges_on_a_second_device_through_both_transports() {
        let (_dir, db) = setup();
        let sync = SyncWriter::new("dev-A".into());
        sync.set_should_queue(true);

        // `font` and `show_lookup_markers` are the two syncable per-book keys.
        // Neither has a global row yet, so promotion's undo is a deletion for
        // both — the exact case that had no way to travel.
        do_set_book_settings_bulk(
            "book1",
            &HashMap::from([
                ("font".to_string(), "literata".to_string()),
                ("show_lookup_markers".to_string(), "false".to_string()),
            ]),
            &db,
            &sync,
        )
        .unwrap();
        let promotion = do_promote_book_settings_to_global("book1", &[], &db, &sync).unwrap();
        assert_eq!(promotion.undo.globals.get("font_family"), Some(&None));
        assert_eq!(
            promotion.undo.globals.get("show_lookup_markers"),
            Some(&None)
        );

        // A peer that has seen only the promotion holds the promoted values.
        let mut mid_flight = peer_db();
        {
            let tx = mid_flight.transaction().unwrap();
            for event in published_events(&db, "dev-A") {
                crate::sync::merge::apply_event(&tx, &event).unwrap();
            }
            tx.commit().unwrap();
        }
        assert_eq!(
            peer_global(&mid_flight, "font_family").as_deref(),
            Some("literata"),
            "the promotion itself must cross, or the test proves nothing"
        );

        do_undo_promote_book_settings(&promotion.undo, &db, &sync).unwrap();
        assert_eq!(get_global_setting(&db, "font_family"), None);
        assert_eq!(get_global_setting(&db, "show_lookup_markers"), None);

        let events = published_events(&db, "dev-A");

        // Transport 1: the peer that already applied the promotion now applies
        // the rest of the stream.
        {
            let tx = mid_flight.transaction().unwrap();
            for event in &events {
                crate::sync::merge::apply_event(&tx, event).unwrap();
            }
            tx.commit().unwrap();
        }
        assert_eq!(
            peer_global(&mid_flight, "font_family"),
            None,
            "the undo must delete the promoted global row on the peer too"
        );
        assert_eq!(peer_global(&mid_flight, "show_lookup_markers"), None);

        // Transport 2: a peer that only ever sees the compacted snapshot.
        let snapshot = Snapshot::from_events("dev-A", &events).unwrap();
        let mut from_snapshot = peer_db();
        {
            let tx = from_snapshot.transaction().unwrap();
            snapshot.apply_peer(&tx, "dev-A").unwrap();
            tx.commit().unwrap();
        }
        assert_eq!(
            peer_global(&from_snapshot, "font_family"),
            None,
            "a snapshot must not reinstate the row the undo removed"
        );
        assert_eq!(peer_global(&from_snapshot, "show_lookup_markers"), None);

        // And the peer that took the event path must not be talked out of it
        // when that same snapshot arrives afterwards.
        {
            let tx = mid_flight.transaction().unwrap();
            snapshot.apply_peer(&tx, "dev-A").unwrap();
            tx.commit().unwrap();
        }
        assert_eq!(peer_global(&mid_flight, "font_family"), None);
        assert_eq!(peer_global(&mid_flight, "show_lookup_markers"), None);
    }

    /// The undo has to stay undoable. Choosing the key again after the delete
    /// must win on the peer as well, or "restore the default" would quietly
    /// mean "never sync this key again".
    #[test]
    fn a_global_setting_rewritten_after_its_delete_wins_on_the_peer() {
        let (_dir, db) = setup();
        let sync = SyncWriter::new("dev-A".into());
        sync.set_should_queue(true);

        do_set_book_settings_bulk(
            "book1",
            &HashMap::from([("font".to_string(), "literata".to_string())]),
            &db,
            &sync,
        )
        .unwrap();
        let promotion = do_promote_book_settings_to_global("book1", &[], &db, &sync).unwrap();
        do_undo_promote_book_settings(&promotion.undo, &db, &sync).unwrap();

        set_settings_bulk_inner(
            &HashMap::from([("font_family".to_string(), "chosen-again".to_string())]),
            &db,
            &sync,
        )
        .unwrap();
        assert_eq!(
            get_global_setting(&db, "font_family").as_deref(),
            Some("chosen-again")
        );
        // The local tombstone has to be gone, or this device's own next
        // snapshot would carry a delete for the value it just chose.
        {
            let conn = db.conn.lock().unwrap();
            let tombstones: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM _tombstones
                     WHERE entity = 'setting' AND id = 'font_family'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(tombstones, 0, "the re-written key must not stay tombstoned");
        }

        let events = published_events(&db, "dev-A");
        let mut peer = peer_db();
        {
            let tx = peer.transaction().unwrap();
            for event in &events {
                crate::sync::merge::apply_event(&tx, event).unwrap();
            }
            tx.commit().unwrap();
        }
        assert_eq!(
            peer_global(&peer, "font_family").as_deref(),
            Some("chosen-again")
        );

        // Same answer through the snapshot, and re-applying it is idempotent.
        let snapshot = Snapshot::from_events("dev-A", &events).unwrap();
        let mut from_snapshot = peer_db();
        for _ in 0..2 {
            let tx = from_snapshot.transaction().unwrap();
            snapshot.apply_peer(&tx, "dev-A").unwrap();
            tx.commit().unwrap();
        }
        assert_eq!(
            peer_global(&from_snapshot, "font_family").as_deref(),
            Some("chosen-again")
        );
    }

    /// The writer decides what leaves this device. Queue-only mode parks the
    /// events in `_pending_publish` where a test can read them, so this checks
    /// the outbox rather than the whitelist: both marker layers must publish,
    /// and a neighbouring per-screen preference must not.
    #[test]
    fn marker_visibility_writes_reach_the_outbox_and_stamp_their_rows() {
        let (_dir, db) = setup();
        let sync = SyncWriter::new("dev-A".into());
        sync.set_should_queue(true);

        set_settings_bulk_inner(
            &HashMap::from([
                ("show_mastered_markers".to_string(), "false".to_string()),
                ("reader_theme".to_string(), "night".to_string()),
            ]),
            &db,
            &sync,
        )
        .unwrap();
        do_set_book_settings_bulk(
            "book1",
            &HashMap::from([
                ("show_learning_markers".to_string(), "false".to_string()),
                ("font_size".to_string(), "22".to_string()),
            ]),
            &db,
            &sync,
        )
        .unwrap();
        do_delete_book_settings("book1", &["show_learning_markers".to_string()], &db, &sync)
            .unwrap();

        let conn = db.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT body_json FROM _pending_publish ORDER BY rowid")
            .unwrap();
        let published = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        drop(stmt);

        let has = |needle: &str| published.iter().any(|body| body.contains(needle));
        assert!(
            has(r#""key":"show_mastered_markers""#),
            "the global marker toggle must publish, got {published:?}"
        );
        assert!(
            has(r#""key":"show_learning_markers""#),
            "the per-book marker override must publish, got {published:?}"
        );
        assert!(
            !has(r#""key":"reader_theme""#) && !has(r#""key":"font_size""#),
            "per-screen preferences must stay on this device, got {published:?}"
        );
        // The removal is what says "this book follows the global again".
        assert!(
            published
                .iter()
                .any(|body| body.contains("show_learning_markers")
                    && body.contains(r#""value":null"#)),
            "removing a per-book marker override must publish a delete, got {published:?}"
        );

        // A syncable row carries the logical timestamp and the writing device;
        // a local-only row keeps the (0, "") sentinel so it always loses LWW.
        let stamp = |table: &str, clause: &str| -> (i64, String) {
            conn.query_row(
                &format!("SELECT updated_at, updated_by_device FROM {table} WHERE {clause}"),
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap()
        };
        let (marker_ts, marker_device) = stamp("settings", "key = 'show_mastered_markers'");
        assert!(marker_ts > 0);
        assert_eq!(marker_device, "dev-A");
        assert_eq!(
            stamp("settings", "key = 'reader_theme'"),
            (0, String::new())
        );
        assert_eq!(
            stamp("book_settings", "book_id = 'book1' AND key = 'font_size'"),
            (0, String::new())
        );

        // The delete leaves a tombstone a peer can act on.
        let tombstone: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM _tombstones
                 WHERE entity = 'book_setting' AND id = 'book1:show_learning_markers'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(tombstone, 1);
    }

    /// The writer's half of the book-source story. Editing the list has to
    /// leave the device, and it has to carry a real stamp — a `(0, "")` row
    /// would lose every LWW compare and the user's edit would silently revert
    /// to whatever the other Mac last said.
    #[test]
    fn book_source_edits_reach_the_outbox_and_stamp_their_row() {
        let (_dir, db) = setup();
        let sync = SyncWriter::new("dev-A".into());
        sync.set_should_queue(true);

        set_settings_bulk_inner(
            &HashMap::from([(
                "book_sources".to_string(),
                r#"[{"id":"user:1","name":"My site","url":"https://example.com/","kind":"library"}]"#
                    .to_string(),
            )]),
            &db,
            &sync,
        )
        .unwrap();

        let conn = db.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT body_json FROM _pending_publish ORDER BY rowid")
            .unwrap();
        let published = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        drop(stmt);

        assert!(
            published.iter().any(
                |body| body.contains(r#""key":"book_sources""#) && body.contains("example.com")
            ),
            "the curated list must publish with its contents, got {published:?}"
        );
        let (ts, device): (i64, String) = conn
            .query_row(
                "SELECT updated_at, updated_by_device FROM settings WHERE key = 'book_sources'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert!(ts > 0, "a synced row needs a real timestamp, got {ts}");
        assert_eq!(device, "dev-A");
    }

    #[test]
    fn undo_rejects_keys_outside_the_reader_setting_set() {
        let (_dir, db) = setup();
        let sync = SyncWriter::new("dev-A".into());

        // The undo payload is webview input: it must not become a write path
        // into arbitrary `settings` / `book_settings` keys.
        let foreign_global = ReaderSettingsPromotionUndo {
            globals: HashMap::from([("ai_api_key".to_string(), Some("leak".to_string()))]),
            book_settings: Vec::new(),
        };
        assert_eq!(
            do_undo_promote_book_settings(&foreign_global, &db, &sync)
                .unwrap_err()
                .to_string(),
            "READER_SETTING_KEY_INVALID"
        );

        let foreign_book_key = ReaderSettingsPromotionUndo {
            globals: HashMap::new(),
            book_settings: vec![PromotedBookSetting {
                book_id: "book1".to_string(),
                key: "toc_expanded".to_string(),
                value: "[1]".to_string(),
            }],
        };
        assert!(do_undo_promote_book_settings(&foreign_book_key, &db, &sync).is_err());
        assert!(get_book_settings(&db, "book1").is_empty());
        assert_eq!(get_global_setting(&db, "ai_api_key"), None);
    }

    #[test]
    fn invalid_delete_key_fails_before_changing_any_row() {
        let (_dir, db) = setup();
        let sync = SyncWriter::new("dev-A".into());
        do_set_book_settings_bulk(
            "book1",
            &HashMap::from([("font_size".to_string(), "24".to_string())]),
            &db,
            &sync,
        )
        .unwrap();

        assert!(do_delete_book_settings(
            "book1",
            &["font_size".to_string(), "page_turn_animation".to_string()],
            &db,
            &sync,
        )
        .is_err());
        assert_eq!(
            get_book_settings(&db, "book1")
                .get("font_size")
                .map(String::as_str),
            Some("24")
        );
    }

    #[test]
    fn ocr_settings_address_survives_the_move_to_services() {
        // The OCR HUD's settings button sends the current address; the reader
        // used to send the pre-move one. Both must land on Services → OCR.
        for section in ["services", "tools"] {
            assert_eq!(
                super::settings_destination_payload(section, Some("ocr")).unwrap(),
                serde_json::json!({ "section": "services", "view": "ocr" }),
                "{section} → OCR did not resolve",
            );
        }
    }

    #[test]
    fn every_services_view_is_addressable() {
        for view in super::SERVICES_VIEWS {
            assert_eq!(
                super::settings_destination_payload("services", Some(view)).unwrap(),
                serde_json::json!({ "section": "services", "view": view }),
            );
        }
    }

    #[test]
    fn a_section_without_a_view_addresses_the_section() {
        assert_eq!(
            super::settings_destination_payload("tools", None).unwrap(),
            serde_json::Value::String("tools".to_string()),
        );
    }

    #[test]
    fn an_unknown_view_is_rejected_rather_than_guessed() {
        assert!(super::settings_destination_payload("services", Some("nope")).is_err());
        assert!(super::settings_destination_payload("tools", Some("models")).is_err());
    }
}

/// Tabs inside the services section that other windows may deep-link to.
/// Mirrors `SERVICES_VIEWS` in `src/components/settings-destination.ts`.
const SERVICES_VIEWS: &[&str] = &["models", "embedding", "speech", "ocr"];

/// Resolve an open-settings address into the payload the main window listens
/// for, or reject it. OCR used to live under `tools`; the frontend normalizer
/// still forwards that address to `services`, so it stays accepted here.
fn settings_destination_payload(section: &str, view: Option<&str>) -> AppResult<serde_json::Value> {
    match view {
        Some("ocr") if section == "tools" => {
            Ok(serde_json::json!({ "section": "services", "view": "ocr" }))
        }
        Some(view) if section == "services" && SERVICES_VIEWS.contains(&view) => {
            Ok(serde_json::json!({ "section": "services", "view": view }))
        }
        Some(_) => Err(AppError::Other("SETTINGS_DESTINATION_INVALID".to_string())),
        None => Ok(serde_json::Value::String(section.to_string())),
    }
}

/// Emit an open-settings event to the main window from any window.
#[tauri::command]
pub fn open_settings_on_main(
    section: String,
    view: Option<String>,
    app: AppHandle,
) -> AppResult<()> {
    let payload = settings_destination_payload(&section, view.as_deref())?;
    app.emit_to("main", "open-settings", payload)
        .map_err(|e| AppError::Other(e.to_string()))?;
    if let Some(window) = app.get_webview_window("main") {
        window
            .show()
            .map_err(|error| AppError::Other(error.to_string()))?;
        window
            .set_focus()
            .map_err(|error| AppError::Other(error.to_string()))?;
    }
    Ok(())
}

/// Show the main window and switch its library surface from a reader window.
#[tauri::command]
pub fn open_library_on_main(filter: String, app: AppHandle) -> AppResult<()> {
    const ALLOWED_FILTERS: &[&str] = &["all", "reading", "finished", "vocab", "chats", "notes"];
    if !ALLOWED_FILTERS.contains(&filter.as_str()) && !filter.starts_with("collection:") {
        return Err(AppError::Other("LIBRARY_FILTER_INVALID".to_string()));
    }
    app.emit_to("main", "open-library-filter", &filter)
        .map_err(|error| AppError::Other(error.to_string()))?;
    if let Some(window) = app.get_webview_window("main") {
        window
            .show()
            .map_err(|error| AppError::Other(error.to_string()))?;
        window
            .set_focus()
            .map_err(|error| AppError::Other(error.to_string()))?;
    }
    Ok(())
}

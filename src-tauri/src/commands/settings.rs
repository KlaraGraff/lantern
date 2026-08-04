use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap, HashSet};
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
        _ => None,
    }
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
/// per-screen preferences that have no business crossing devices. `font_family`
/// is the exception, because a synced font file is useless if nothing on the
/// second device selects it. Non-whitelisted keys never reach the log at all,
/// so the event stream stays clean rather than being filtered on read.
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

    let now = chrono::Utc::now().timestamp_millis();
    let device = sync.self_device().to_string();
    sync.with_tx(db, now, |tx, events| {
        for (key, value) in settings {
            let syncable = is_syncable_setting(false, key);
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
                    if syncable { device.as_str() } else { "" }
                ],
            )?;
            if syncable {
                events.push(EventBody::SettingSet(SettingPayload {
                    book: None,
                    key: key.clone(),
                    value: Some(value.clone()),
                }));
            }
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

#[derive(Debug, Serialize)]
pub struct ReaderSettingsPromotion {
    pub settings: HashMap<String, String>,
    pub promoted_keys: Vec<String>,
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
        for (_, global_key, value) in &promoted {
            let syncable = is_syncable_setting(false, global_key);
            tx.execute(
                "INSERT INTO settings (key, value, updated_at, updated_by_device)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                   updated_at = excluded.updated_at,
                   updated_by_device = excluded.updated_by_device",
                params![
                    global_key,
                    value,
                    if syncable { now } else { 0 },
                    if syncable { device.as_str() } else { "" }
                ],
            )?;
            changed_settings.insert((*global_key).to_string(), value.clone());
            if syncable {
                events.push(EventBody::SettingSet(SettingPayload {
                    book: None,
                    key: (*global_key).to_string(),
                    value: Some(value.clone()),
                }));
            }
        }

        let mut targets = selected_book_ids.iter().cloned().collect::<HashSet<_>>();
        targets.remove(source_book_id);
        targets.insert(source_book_id.to_string());
        for target in targets {
            for (book_key, _, _) in &promoted {
                delete_book_setting_in_tx(tx, events, &target, book_key, now)?;
            }
        }

        Ok(ReaderSettingsPromotion {
            settings: changed_settings,
            promoted_keys: promoted.into_iter().map(|(key, _, _)| key).collect(),
        })
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

/// Same whitelist rule as the global writer: only `font` publishes.
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
                    if syncable { device.as_str() } else { "" }
                ],
            )?;
            if syncable {
                events.push(EventBody::SettingSet(SettingPayload {
                    book: Some(book_id.to_string()),
                    key: key.clone(),
                    value: Some(value.clone()),
                }));
            }
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::{
        do_delete_book_settings, do_promote_book_settings_to_global, do_set_book_settings_bulk,
        set_settings_bulk_inner,
    };
    use crate::db::Db;
    use crate::sync::writer::SyncWriter;
    use rusqlite::params;
    use std::collections::HashMap;
    use tempfile::TempDir;

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

        let source = get_book_settings(&db, "book1");
        assert_eq!(
            source.get("show_lookup_markers").map(String::as_str),
            Some("false")
        );
        assert!(!source.contains_key("font"));
        assert!(!source.contains_key("font_size"));

        let selected = get_book_settings(&db, "book2");
        assert!(!selected.contains_key("font_size"));
        assert_eq!(
            selected.get("line_spacing").map(String::as_str),
            Some("2.1")
        );
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

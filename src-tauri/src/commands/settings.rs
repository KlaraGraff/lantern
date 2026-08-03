use rusqlite::params;
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::ai::router::{self, AiCredentialView, AiProfileView};
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::secrets::Secrets;
use crate::sync::events::{is_syncable_setting, EventBody, SettingPayload};
use crate::sync::writer::SyncWriter;

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
                    value: value.clone(),
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
    let now = chrono::Utc::now().timestamp_millis();
    let device = sync.self_device().to_string();
    sync.with_tx(db, now, |tx, events| {
        for (key, value) in settings {
            let syncable = is_syncable_setting(true, key);
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
                    value: value.clone(),
                }));
            }
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::{do_set_book_settings_bulk, set_settings_bulk_inner};
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

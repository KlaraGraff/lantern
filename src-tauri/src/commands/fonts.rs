use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::sync::events::{CustomFontPayload, EventBody};
use crate::sync::writer::SyncWriter;

const MAX_FONT_BYTES: u64 = 64 * 1024 * 1024;
const ALLOWED_EXTENSIONS: &[&str] = &["ttf", "otf", "woff", "woff2"];

#[derive(Debug, Clone, Serialize)]
pub struct CustomFont {
    pub id: String,
    pub family_name: String,
    pub format: String,
    pub file_size: i64,
    pub file_path: String,
    pub created_at: i64,
    /// Whether the bytes are on this device's disk yet. With sync, a catalog
    /// row can arrive well before its file does; that is a normal transient
    /// state, not an error. The UI keeps such a font selectable and simply
    /// withholds its `@font-face` rule until this flips true.
    pub file_available: bool,
}

#[derive(Debug, Deserialize, Serialize)]
struct MarkerVisualStyle {
    color: String,
    opacity: f64,
    background: bool,
    underline: bool,
    bold: bool,
    font: String,
}

#[derive(Debug, Deserialize, Serialize)]
struct MarkerStyleConfig {
    version: i64,
    #[serde(
        rename = "markMatchingWords",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    mark_matching_words: Option<bool>,
    #[serde(
        rename = "wordMatchScope",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    word_match_scope: Option<String>,
    manual: MarkerVisualStyle,
    #[serde(rename = "automaticFollowsManual")]
    automatic_follows_manual: bool,
    automatic: MarkerVisualStyle,
}

/// Imported fonts live under the *active* data directory, which is the shared
/// iCloud folder when sync is enabled. That is what makes them replicate: the
/// bytes ride the same plain-file path as `books/` and `covers/` rather than
/// the event log, whose 256 KiB line cap a font would blow straight past.
///
/// This deliberately does not call `resolve_app_data_dir()`. That helper
/// derives paths from `HOME`/`XDG_DATA_HOME` and lands in the wrong place on
/// iOS — see F-003 in docs/roadmap/mobile-ios.md. `Db.data_dir` comes from
/// Tauri's own `app.path().app_data_dir()`.
fn font_dir(db: &Db) -> AppResult<PathBuf> {
    Ok(db.data_dir()?.join("imported-fonts"))
}

pub(crate) fn font_relative_path(file_name: &str) -> String {
    format!("imported-fonts/{file_name}")
}

fn validate_source(path: &Path) -> AppResult<(String, u64)> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .filter(|value| ALLOWED_EXTENSIONS.contains(&value.as_str()))
        .ok_or_else(|| AppError::Other("CUSTOM_FONT_FORMAT_UNSUPPORTED".to_string()))?;
    let metadata = fs::metadata(path)?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_FONT_BYTES {
        return Err(AppError::Other("CUSTOM_FONT_FILE_INVALID".to_string()));
    }
    Ok((extension, metadata.len()))
}

fn decode_font(bytes: &[u8], extension: &str) -> AppResult<Vec<u8>> {
    let decoded = match extension {
        "ttf" | "otf" => bytes.to_vec(),
        "woff" => wuff::decompress_woff1(bytes)
            .map_err(|_| AppError::Other("CUSTOM_FONT_FILE_INVALID".to_string()))?,
        "woff2" => wuff::decompress_woff2(bytes)
            .map_err(|_| AppError::Other("CUSTOM_FONT_FILE_INVALID".to_string()))?,
        _ => {
            return Err(AppError::Other(
                "CUSTOM_FONT_FORMAT_UNSUPPORTED".to_string(),
            ))
        }
    };
    if ttf_parser::Face::parse(&decoded, 0).is_err() {
        return Err(AppError::Other("CUSTOM_FONT_FILE_INVALID".to_string()));
    }
    Ok(decoded)
}

fn family_name_from_font(bytes: &[u8], fallback: &str) -> String {
    if let Ok(face) = ttf_parser::Face::parse(bytes, 0) {
        for name_id in [
            ttf_parser::name_id::TYPOGRAPHIC_FAMILY,
            ttf_parser::name_id::FAMILY,
        ] {
            if let Some(value) = face
                .names()
                .into_iter()
                .filter(|name| name.name_id == name_id)
                .filter_map(|name| name.to_string())
                .find(|value| !value.trim().is_empty())
            {
                return value.trim().chars().take(200).collect();
            }
        }
    }
    fallback.trim().chars().take(200).collect()
}

fn row_to_font(row: &rusqlite::Row<'_>, font_dir: &Path) -> rusqlite::Result<CustomFont> {
    let file_name: String = row.get(2)?;
    let path = font_dir.join(file_name);
    Ok(CustomFont {
        id: row.get(0)?,
        family_name: row.get(1)?,
        file_available: path.is_file(),
        file_path: path.to_string_lossy().into_owned(),
        format: row.get(3)?,
        file_size: row.get(4)?,
        created_at: row.get(5)?,
    })
}

pub(crate) fn read_custom_fonts(db: &Db) -> AppResult<Vec<CustomFont>> {
    let font_dir = font_dir(db)?;
    let conn = db.reader();
    let mut statement = conn.prepare(
        "SELECT id, family_name, file_name, format, file_size, created_at
         FROM custom_fonts ORDER BY family_name COLLATE NOCASE, created_at",
    )?;
    let fonts = statement
        .query_map([], |row| row_to_font(row, &font_dir))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppError::from)?;
    Ok(fonts)
}

fn import_path(path: &Path, db: &Db, sync: &SyncWriter) -> AppResult<CustomFont> {
    let (format, file_size) = validate_source(path)?;
    let bytes = fs::read(path)?;
    if bytes.len() as u64 != file_size {
        return Err(AppError::Other("CUSTOM_FONT_FILE_CHANGED".to_string()));
    }
    let decoded = decode_font(&bytes, &format)?;
    let hash = format!("{:x}", Sha256::digest(&bytes));
    let id = format!("custom-{hash}");
    let file_name = format!("{hash}.{format}");
    let fallback = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Imported font");
    let family_name = family_name_from_font(&decoded, fallback);
    if family_name.is_empty() {
        return Err(AppError::Other("CUSTOM_FONT_NAME_INVALID".to_string()));
    }

    let font_dir = font_dir(db)?;
    fs::create_dir_all(&font_dir)?;
    // Route the destination through the blob validator rather than joining
    // directly, so the content-addressed name is checked by the same rule that
    // guards a name arriving from a peer.
    let destination = db.resolve_path(&font_relative_path(&file_name))?;
    if !destination.exists() {
        let temporary = font_dir.join(format!(".{file_name}.{}.tmp", uuid::Uuid::new_v4()));
        fs::write(&temporary, &bytes)?;
        if let Err(error) = fs::rename(&temporary, &destination) {
            let _ = fs::remove_file(&temporary);
            if !destination.exists() {
                return Err(error.into());
            }
        }
    }

    let created_at = chrono::Utc::now().timestamp_millis();
    let device = sync.self_device().to_string();
    sync.with_tx(db, created_at, |tx, events| {
        tx.execute(
            "INSERT INTO custom_fonts
             (id, family_name, file_name, format, file_size, created_at, updated_at, updated_by_device)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at,
               updated_by_device = excluded.updated_by_device",
            params![
                id,
                family_name,
                file_name,
                format,
                file_size as i64,
                created_at,
                created_at,
                device
            ],
        )?;
        // Re-importing a font that was deleted elsewhere is legitimate: the id
        // is a hash of the bytes, so it is the only id this file can ever have.
        // Clear the tombstone or replay would undo the import on the next tick.
        tx.execute(
            "DELETE FROM _tombstones WHERE entity = 'custom_font' AND id = ?1",
            params![id],
        )?;
        events.push(EventBody::CustomFontUpsert(CustomFontPayload {
            id: id.clone(),
            family_name: family_name.clone(),
            file_name: file_name.clone(),
            format: format.clone(),
            file_size: file_size as i64,
            created_at,
        }));
        Ok(())
    })?;

    let conn = db.reader();
    conn.query_row(
        "SELECT id, family_name, file_name, format, file_size, created_at
         FROM custom_fonts WHERE id = ?1",
        params![id],
        |row| row_to_font(row, &font_dir),
    )
    .map_err(Into::into)
}

#[tauri::command]
pub async fn import_custom_fonts(
    app: AppHandle,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<Vec<CustomFont>> {
    let selected = app
        .dialog()
        .file()
        .add_filter("Font files", ALLOWED_EXTENSIONS)
        .blocking_pick_files()
        .unwrap_or_default();
    let mut imported = Vec::new();
    for path in selected {
        let path = path
            .into_path()
            .map_err(|_| AppError::Other("CUSTOM_FONT_PATH_INVALID".to_string()))?;
        imported.push(import_path(&path, &db, &sync)?);
    }
    if !imported.is_empty() {
        let fonts = read_custom_fonts(&db)?;
        let _ = app.emit("custom-fonts-changed", fonts);
    }
    Ok(imported)
}

#[tauri::command]
pub fn list_custom_fonts(db: State<'_, Db>) -> AppResult<Vec<CustomFont>> {
    read_custom_fonts(&db)
}

/// Un-select `font_id` from the marker style config, leaving the marker to
/// inherit. Shared with sync merge so a delete arriving from a peer performs
/// exactly the same downgrade a local delete does.
pub(crate) fn clear_marker_style_font(tx: &Transaction, font_id: &str) -> AppResult<()> {
    let marker_config = tx
        .query_row(
            "SELECT value FROM settings WHERE key = 'marker_style_config'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let Some(serialized) = marker_config else {
        return Ok(());
    };
    let Ok(mut config) = serde_json::from_str::<MarkerStyleConfig>(&serialized) else {
        return Ok(());
    };
    let mut changed = false;
    if config.manual.font == font_id {
        config.manual.font = "inherit".to_string();
        changed = true;
    }
    if config.automatic.font == font_id {
        config.automatic.font = "inherit".to_string();
        changed = true;
    }
    if changed {
        let serialized =
            serde_json::to_string(&config).map_err(|error| AppError::Other(error.to_string()))?;
        tx.execute(
            "UPDATE settings SET value = ?1 WHERE key = 'marker_style_config'",
            params![serialized],
        )?;
    }
    Ok(())
}

#[tauri::command]
pub fn delete_custom_font(
    id: String,
    app: AppHandle,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<()> {
    if !id.starts_with("custom-") || id.len() != 71 {
        return Err(AppError::Other("CUSTOM_FONT_ID_INVALID".to_string()));
    }
    let font_dir = font_dir(&db)?;
    let file_name = {
        let conn = db.reader();
        conn.query_row(
            "SELECT file_name FROM custom_fonts WHERE id = ?1",
            params![id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
    };
    let Some(file_name) = file_name else {
        return Ok(());
    };
    let path = font_dir.join(&file_name);
    let staged_path = if path.is_file() {
        let staged = font_dir.join(format!(".delete-{}-{}.tmp", file_name, uuid::Uuid::new_v4()));
        fs::rename(&path, &staged)?;
        Some(staged)
    } else {
        None
    };

    let now = chrono::Utc::now().timestamp_millis();
    let device = sync.self_device().to_string();
    let db_result = sync.with_tx(&db, now, |tx, events| {
        tx.execute("DELETE FROM custom_fonts WHERE id = ?1", params![id])?;
        tx.execute(
            "UPDATE settings SET value = 'system', updated_at = ?2, updated_by_device = ?3
             WHERE key = 'font_family' AND value = ?1",
            params![id, now, device],
        )?;
        tx.execute(
            "UPDATE book_settings SET value = 'system', updated_at = ?2, updated_by_device = ?3
             WHERE key = 'font' AND value = ?1",
            params![id, now, device],
        )?;
        clear_marker_style_font(tx, &id)?;
        crate::sync::merge::insert_tombstone(tx, crate::sync::merge::entity::CUSTOM_FONT, &id, now)?;
        events.push(EventBody::CustomFontDelete { id: id.clone() });
        Ok(())
    });
    if let Err(error) = db_result {
        if let Some(staged) = staged_path.as_ref() {
            if let Err(restore_error) = fs::rename(staged, &path) {
                return Err(AppError::Other(format!(
                    "CUSTOM_FONT_DELETE_ROLLBACK_FAILED:{error};{restore_error}"
                )));
            }
        }
        return Err(error);
    }
    if let Some(staged) = staged_path {
        if let Err(error) = fs::remove_file(staged) {
            log::warn!("could not remove staged custom font after database commit: {error}");
        }
    }
    let fonts = read_custom_fonts(&db)?;
    let _ = app.emit("custom-fonts-changed", fonts);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_font_extension() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("font.exe");
        fs::write(&path, b"not a font").unwrap();
        assert!(matches!(
            validate_source(&path),
            Err(AppError::Other(code)) if code == "CUSTOM_FONT_FORMAT_UNSUPPORTED"
        ));
    }

    #[test]
    fn rejects_renamed_non_font_file() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("not-a-font.ttf");
        fs::write(&path, b"this is not an sfnt font").unwrap();
        let (format, _) = validate_source(&path).unwrap();
        let bytes = fs::read(path).unwrap();
        assert!(matches!(
            decode_font(&bytes, &format),
            Err(AppError::Other(code)) if code == "CUSTOM_FONT_FILE_INVALID"
        ));
    }

    #[test]
    fn rejects_truncated_woff_headers() {
        let mut bytes = vec![0_u8; 44];
        let length = bytes.len() as u32;
        bytes[0..4].copy_from_slice(b"wOFF");
        bytes[8..12].copy_from_slice(&length.to_be_bytes());
        bytes[12..14].copy_from_slice(&1_u16.to_be_bytes());
        bytes[16..20].copy_from_slice(&28_u32.to_be_bytes());
        assert!(matches!(
            decode_font(&bytes, "woff"),
            Err(AppError::Other(code)) if code == "CUSTOM_FONT_FILE_INVALID"
        ));
    }
}

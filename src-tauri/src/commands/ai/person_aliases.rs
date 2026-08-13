//! Tauri commands for the person-aliases index-manager section. Thin wrappers
//! over `ai::grounding::aliases` — see that module for the storage rules, the
//! build pass, and `resolve()`. This file owns only entity validation and the
//! `State` plumbing Tauri commands need.

use tauri::{AppHandle, State};

use crate::ai::grounding::aliases;
use crate::db::Db;
use crate::error::AppResult;
use crate::secrets::Secrets;

#[tauri::command]
pub fn list_person_aliases(
    book_id: String,
    db: State<'_, Db>,
) -> AppResult<Vec<aliases::AliasGroupView>> {
    crate::sync::validation::validate_entity_id(&book_id)?;
    aliases::list_person_aliases(&db.reader(), &book_id)
}

/// The rebuild button. Always available regardless of the automatic-analysis
/// switch (see `AutoAnalysisJob`'s module doc, rule 2) — clears `'auto'` rows
/// and re-derives them, leaving anything the reader taught in place.
#[tauri::command]
pub async fn build_person_aliases(
    book_id: String,
    app: AppHandle,
    db: State<'_, Db>,
    secrets: State<'_, Secrets>,
) -> AppResult<()> {
    crate::sync::validation::validate_entity_id(&book_id)?;
    let db = db.inner().clone();
    let secrets = secrets.inner().clone();
    aliases::build_person_aliases(&app, &db, &secrets, &book_id).await
}

/// `kind` distinguishes a taught name ("达西" → "Mr. Darcy", exact-matched by
/// `resolve()`) from a taught description ("那个总在拍马屁的牧师" → "Mr.
/// Collins", matched by embedding similarity in `aliases::resolve_descriptions`
/// — see `aliases::alias_groups`'s doc comment). `source_query` is only
/// meaningful for the latter and is dropped by the storage layer otherwise.
///
/// A `"description"` row added through *this* command is stored without a
/// vector and stays inert until the book's next index run backfills it. The
/// chat's teach button uses `teach_description_alias` below instead, which
/// embeds it on the spot.
#[tauri::command]
pub fn add_person_alias(
    book_id: String,
    canonical: String,
    alias: String,
    kind: String,
    source_query: Option<String>,
    db: State<'_, Db>,
) -> AppResult<String> {
    crate::sync::validation::validate_entity_id(&book_id)?;
    aliases::add_person_alias(
        &db,
        &book_id,
        &canonical,
        &alias,
        &kind,
        source_query.as_deref(),
    )
}

/// What the chat's alias-disclosure footer calls when the reader confirms
/// "记住：这指的是 X". Distinct from `add_person_alias` because it also computes
/// the row's embedding — see `aliases::teach_description_alias` for why that is
/// a separate function and why a failed embedding still returns `Ok`.
///
/// `async` only for the embedding call. The `kind` argument is not exposed: a
/// row taught from a conversation is a description by construction, and letting
/// the frontend pass `"name"` here would buy a vector for a row that will never
/// be matched by one.
#[tauri::command]
pub async fn teach_description_alias(
    book_id: String,
    canonical: String,
    alias: String,
    source_query: Option<String>,
    db: State<'_, Db>,
    secrets: State<'_, Secrets>,
) -> AppResult<String> {
    crate::sync::validation::validate_entity_id(&book_id)?;
    let db = db.inner().clone();
    let secrets = secrets.inner().clone();
    aliases::teach_description_alias(
        &db,
        &secrets,
        &book_id,
        &canonical,
        &alias,
        source_query.as_deref(),
    )
    .await
}

#[tauri::command]
pub fn delete_person_alias(id: String, db: State<'_, Db>) -> AppResult<()> {
    aliases::delete_person_alias(&db, &id)
}

#[tauri::command]
pub fn clear_person_aliases(book_id: String, db: State<'_, Db>) -> AppResult<()> {
    crate::sync::validation::validate_entity_id(&book_id)?;
    aliases::clear_person_aliases(&db, &book_id)
}

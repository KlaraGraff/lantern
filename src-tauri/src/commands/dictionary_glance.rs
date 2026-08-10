//! The free dictionary strip, reported to the mastery engine.
//!
//! Deliberately separate from `commands::dictionary`, which answers "what does
//! this word mean" and must stay a pure query — it is called speculatively,
//! including for words the reader dismisses in a fraction of a second. Whether
//! a definition was actually *read* is a different question, decided by the
//! menu long after the lookup returned, and it gets its own call.
//!
//! See `docs/impls/dictionary-glance-mastery.md`.

use serde::Deserialize;
use tauri::State;

use crate::db::Db;
use crate::error::AppResult;
use crate::mastery::store::{record_glance, GlanceOutcome};
use crate::sync::writer::SyncWriter;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlanceInput {
    pub book_id: String,
    pub word: String,
    /// The definition the reader actually saw, kept so a word filed into the
    /// watchlist by glances alone arrives with something on it. Empty when the
    /// entry had no usable gloss.
    #[serde(default)]
    pub definition: String,
    #[serde(default)]
    pub context_sentence: Option<String>,
    #[serde(default)]
    pub cfi: Option<String>,
}

/// Report that the reader read a dictionary definition and did nothing else.
///
/// The caller is the context menu, and it owns the judgement: the definition
/// rendered, the menu stayed open past the dwell, and no other action was
/// taken. Everything downstream trusts that — see [`record_glance`].
#[tauri::command]
pub fn record_dictionary_glance(
    input: GlanceInput,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<GlanceOutcome> {
    record_dictionary_glance_inner(input, &db, &sync)
}

pub fn record_dictionary_glance_inner(
    input: GlanceInput,
    db: &Db,
    sync: &SyncWriter,
) -> AppResult<GlanceOutcome> {
    let now = chrono::Utc::now().timestamp_millis();
    let device = sync.self_device().to_string();
    sync.with_tx(db, now, |tx, events| {
        record_glance(
            tx,
            events,
            &input.book_id,
            &input.word,
            &input.definition,
            input.context_sentence.as_deref(),
            input.cfi.as_deref(),
            now,
            &device,
        )
    })
}

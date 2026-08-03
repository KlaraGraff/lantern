-- Migration 032 — collapse empty highlight notes to NULL.
--
-- Before the note writers normalized their input, clearing a highlight's note
-- ("仅删除备注") wrote an empty string into `highlights.note` instead of NULL.
-- Nothing rendered differently — both readers of the column gate on a trimmed
-- truthiness check — but the column then disagreed with the `Option<String>`
-- it maps to, so "no note" had two spellings depending on how it got there.
--
-- This pass fixes the rows already on disk. New rows can no longer reach that
-- state: `sync::events::normalized_note` is applied at every point a note
-- enters the local DB (local commands, peer events, peer snapshots).
--
-- SQLite's bare TRIM() strips spaces only, so the character set is spelled out
-- to match Rust's `str::trim` on the whitespace that can realistically appear
-- in a note: tab, newline, carriage return, space.
--
-- `updated_at` and `updated_by_device` are deliberately left alone. This is a
-- representation fix, not an edit to the highlight: bumping the LWW clock would
-- make this device win future merges against peers that hold the same note, and
-- could resurrect a stale note elsewhere in the fleet. Peers converge on their
-- own once they run this migration.
UPDATE highlights
   SET note = NULL
 WHERE note IS NOT NULL
   AND TRIM(note, char(9) || char(10) || char(13) || char(32)) = '';

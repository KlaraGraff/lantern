-- Imported fonts become syncable. See docs/impls/syncable-custom-fonts.md and
-- the reversed-policy note above custom_fonts in migration 022.
--
-- The catalog rows sync as LWW state through the event log. The font binaries do
-- not: the log caps a line at 256 KiB and a file at 16 MiB, while a font may be
-- up to 64 MiB. They move under the active data directory instead and replicate
-- as plain files, exactly like books/ and covers/.
ALTER TABLE custom_fonts ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE custom_fonts ADD COLUMN updated_by_device TEXT NOT NULL DEFAULT 'migration';

-- Existing rows predate sync. Seed them from created_at so they carry a
-- plausible timestamp rather than losing every conflict against a peer.
UPDATE custom_fonts SET updated_at = created_at WHERE updated_at = 0;

-- settings and book_settings stay local-only as tables. Only a whitelist of keys
-- syncs -- font_family globally, font per book -- because a font is something the
-- user acquired and chose, not a per-screen preference like theme or font size.
-- The columns are added to the whole table because SQLite has no per-row schema;
-- the gate is in commands/settings.rs and sync/merge.rs, not here.
--
-- These deliberately stay at 0 rather than being backfilled: a value that has
-- never been written under sync should lose to any real remote write, which is
-- the right outcome for a device joining an established library.
ALTER TABLE settings ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE settings ADD COLUMN updated_by_device TEXT NOT NULL DEFAULT '';
ALTER TABLE book_settings ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE book_settings ADD COLUMN updated_by_device TEXT NOT NULL DEFAULT '';

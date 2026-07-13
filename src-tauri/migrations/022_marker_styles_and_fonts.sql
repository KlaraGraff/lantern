-- Per-occurrence exclusions for whole-book word-marker rules. These rows are
-- synced as LWW state so "remove this occurrence" survives restarts and peers.
CREATE TABLE word_mark_exceptions (
  id TEXT PRIMARY KEY,
  -- Do not add a foreign key to word_mark_rules here. Sync may receive an
  -- exception before the rule event from another peer; the orphan is kept
  -- invisible until that rule arrives, then becomes effective.
  rule_id TEXT NOT NULL,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  normalized_word TEXT NOT NULL,
  location TEXT NOT NULL,
  excluded INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by_device TEXT NOT NULL DEFAULT 'migration',
  UNIQUE(rule_id, location)
);

CREATE INDEX idx_word_mark_exceptions_book
  ON word_mark_exceptions(book_id, excluded, updated_at DESC);
CREATE INDEX idx_word_mark_exceptions_rule
  ON word_mark_exceptions(rule_id, excluded);

-- A successful lookup can mark only the queried occurrence. Keep these
-- automatic marks separate from user-created highlight ranges so styles,
-- range merging, and removal never cross the two ownership boundaries.
CREATE TABLE lookup_occurrence_marks (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  normalized_word TEXT NOT NULL,
  display_word TEXT NOT NULL,
  location TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by_device TEXT NOT NULL DEFAULT 'migration',
  UNIQUE(book_id, location)
);

CREATE INDEX idx_lookup_occurrence_marks_book
  ON lookup_occurrence_marks(book_id, enabled, updated_at DESC);

-- Imported font files are deliberately local-only. Font binaries may have
-- licenses that prohibit redistribution, so neither this catalog nor the
-- files under imported-fonts/ enter the iCloud event log or snapshots.
CREATE TABLE custom_fonts (
  id TEXT PRIMARY KEY,
  family_name TEXT NOT NULL,
  file_name TEXT NOT NULL UNIQUE,
  format TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

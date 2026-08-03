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

-- Imported fonts sync (since migration 031). This reverses the original policy,
-- recorded here so nobody re-derives it from first principles and flips it back:
-- the table was created local-only on the reasoning that font binaries may carry
-- licenses forbidding redistribution.
--
-- That does not describe what happens here. Lantern neither ships nor hosts font
-- files. The user obtains the file themselves and puts it in their own private
-- cloud storage, which replicates it between machines that are all theirs -- the
-- same act as copying a file from one of their own laptops to another. No third
-- party receives anything, so no redistribution occurs, and the license question
-- is between the user and the foundry rather than something Lantern mediates.
--
-- Catalog rows sync through the event log; the binaries under imported-fonts/
-- replicate as plain files in the shared directory, like books/ and covers/.
-- The LWW columns live in migration 031, not here.
-- See docs/impls/syncable-custom-fonts.md.
CREATE TABLE custom_fonts (
  id TEXT PRIMARY KEY,
  family_name TEXT NOT NULL,
  file_name TEXT NOT NULL UNIQUE,
  format TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

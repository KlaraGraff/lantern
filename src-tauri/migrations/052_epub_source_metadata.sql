-- EPUB's dc:language is spec-required but was never read at import time.
-- Stored verbatim (no locale normalization) so a future reader feature can
-- decide what "en-GB" vs "en" means without re-opening the source file.
ALTER TABLE books ADD COLUMN language TEXT;

-- Snapshot of the title/author actually used at import time (dc:title /
-- dc:creator when present, filename / "Unknown Author" fallback otherwise),
-- captured before any AI cleanup exists. A future "revert" action needs this
-- baseline to undo an AI edit without re-parsing the original file. NULL on
-- every book imported before this column existed — intentionally not
-- backfilled, since there is no reliable "original" to reconstruct for them.
ALTER TABLE books ADD COLUMN original_title TEXT;
ALTER TABLE books ADD COLUMN original_author TEXT;

-- OCR v1 stores only immutable derived searchable PDFs. The source remains in
-- `books` and is linked by `book_id + source_sha256`.
CREATE TABLE book_assets (
  id                  TEXT PRIMARY KEY,
  book_id             TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  role                TEXT NOT NULL DEFAULT 'ocr_pdf' CHECK(role = 'ocr_pdf'),
  format              TEXT NOT NULL DEFAULT 'pdf' CHECK(format = 'pdf'),
  relative_path       TEXT NOT NULL,
  content_sha256      TEXT NOT NULL,
  byte_size           INTEGER NOT NULL CHECK(byte_size >= 0),
  source_sha256       TEXT NOT NULL,
  pipeline            TEXT NOT NULL CHECK(pipeline = 'ocrmypdf'),
  pipeline_version    TEXT,
  language_profile    TEXT NOT NULL,
  quality_profile     TEXT NOT NULL DEFAULT 'fast',
  page_count          INTEGER NOT NULL CHECK(page_count > 0),
  supersedes_asset_id TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  updated_by_device   TEXT NOT NULL
);

CREATE UNIQUE INDEX book_assets_relative_path_idx
  ON book_assets(relative_path);
CREATE INDEX book_assets_book_idx
  ON book_assets(book_id, updated_at DESC);

CREATE TABLE book_asset_local_state (
  asset_id     TEXT PRIMARY KEY REFERENCES book_assets(id) ON DELETE CASCADE,
  availability TEXT NOT NULL CHECK(availability IN (
    'remote_only', 'downloading', 'available_verified', 'corrupt'
  )),
  verified_at  INTEGER,
  error_code   TEXT,
  updated_at   INTEGER NOT NULL,
  CHECK(availability <> 'available_verified' OR verified_at IS NOT NULL)
);

CREATE TABLE ocr_jobs (
  id                  TEXT PRIMARY KEY,
  book_id             TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  source_sha256       TEXT NOT NULL,
  state               TEXT NOT NULL CHECK(state IN (
    'queued', 'waiting_source', 'preparing', 'recognizing', 'validating',
    'publishing', 'ready', 'failed', 'cancelled'
  )),
  phase               TEXT,
  pages_done          INTEGER CHECK(pages_done IS NULL OR pages_done >= 0),
  pages_total         INTEGER CHECK(pages_total IS NULL OR pages_total >= 0),
  backend             TEXT,
  backend_version     TEXT,
  language_profile    TEXT,
  quality_profile     TEXT,
  jobs                INTEGER CHECK(jobs IS NULL OR jobs BETWEEN 1 AND 4),
  conversion_version  INTEGER NOT NULL DEFAULT 1,
  result_asset_id     TEXT,
  recognized_pages    INTEGER,
  skipped_pages       INTEGER,
  timed_out_pages     INTEGER,
  failed_pages        INTEGER,
  temporary_path      TEXT,
  error_code          TEXT,
  error_detail        TEXT,
  created_at          INTEGER NOT NULL,
  started_at          INTEGER,
  updated_at          INTEGER NOT NULL,
  CHECK(pages_done IS NULL OR pages_total IS NULL OR pages_done <= pages_total)
);

CREATE UNIQUE INDEX ocr_jobs_one_active
  ON ocr_jobs(book_id)
  WHERE state IN (
    'queued', 'waiting_source', 'preparing', 'recognizing', 'validating',
    'publishing'
  );

CREATE TRIGGER book_assets_immutable
BEFORE UPDATE ON book_assets
BEGIN
  SELECT RAISE(ABORT, 'book asset immutable');
END;

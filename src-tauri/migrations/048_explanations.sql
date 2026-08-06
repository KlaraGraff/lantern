-- 解释既是缓存又是用户数据，靠 saved 区分：saved = 0 的行是缓存，可随时清理；
-- saved = 1 的行是读者按过保存的，只有读者能删。与 lookup_records 一样，
-- 本表暂不进 iCloud 事件流。
CREATE TABLE IF NOT EXISTS explanations (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  passage TEXT NOT NULL,
  normalized_passage TEXT NOT NULL,
  explanation TEXT NOT NULL,
  context_sentence TEXT,
  chapter TEXT,
  -- 空串而不是 NULL：SQLite 的唯一索引认为两个 NULL 互不相等，
  -- 若允许 NULL，没有 cfi 的选段永远命中不了缓存，只会不断插新行。
  cfi TEXT NOT NULL DEFAULT '',
  -- prompt 指纹：explanation_mode + cefr_level（+ 将来的模型档位）。
  -- 读者把 CEFR 从 B1 调到 C1 之后，回放一条 B1 的解释是 bug，不是省钱。
  variant TEXT NOT NULL DEFAULT '',
  provider_profile_id TEXT,
  model TEXT,
  saved INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_explanations_key
  ON explanations(book_id, cfi, normalized_passage, variant);
CREATE INDEX IF NOT EXISTS idx_explanations_saved
  ON explanations(saved, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_explanations_book
  ON explanations(book_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS ai_usage_records (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  provider TEXT NOT NULL,          -- 'anthropic' | 'openai_compat' | 'openai_responses' | ...
  model TEXT NOT NULL DEFAULT '',
  -- 这次调用是谁发起的：'user' = 用户点了按钮；'auto' = 系统自动分析。
  -- 「自动分析」控制台要按这个分组显示用量，所以从第一天就要分开记。
  origin TEXT NOT NULL DEFAULT 'user',
  -- 具体是哪个功能，例如 'lookup' / 'explain' / 'chat' / 'learning_card'。
  feature TEXT NOT NULL DEFAULT '',
  -- provider 返回的 usage 对象，原样 JSON 序列化。绝不挑字段。
  usage_json TEXT NOT NULL,
  -- 从 usage_json 里能提取到就提取，提取不到写 0。仅用于快速求和，
  -- 真相永远以 usage_json 为准。
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage_records(created_at);
CREATE INDEX IF NOT EXISTS idx_ai_usage_origin ON ai_usage_records(origin, created_at);

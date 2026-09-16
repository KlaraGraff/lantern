ALTER TABLE ai_profiles
ADD COLUMN api_mode TEXT NOT NULL DEFAULT 'chat_completions'
CHECK (api_mode IN ('auto', 'chat_completions', 'responses'));

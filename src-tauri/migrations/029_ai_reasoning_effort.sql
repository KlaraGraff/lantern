-- Reasoning effort for chat profiles.
--
-- NULL means "send no reasoning parameter at all" and is distinct from the
-- literal value 'none', which some providers accept as "explicitly do not
-- think". The unsupported-value fallback clears the column back to NULL rather
-- than writing 'none', because a gateway that rejects one effort string tends
-- to reject the other too.
ALTER TABLE ai_profiles ADD COLUMN reasoning_effort TEXT;

-- Off means the effort rides on the chat path only. On means every AI feature
-- sharing this profile (inline translation, vocabulary cards, explanations)
-- carries it too.
ALTER TABLE ai_profiles ADD COLUMN reasoning_effort_all_features INTEGER NOT NULL DEFAULT 0;

-- Effort levels a specific endpoint told us it accepts, learned from the error
-- body of a rejected request. Keyed by model as well as base URL: one gateway
-- serves many models and they rarely agree on which levels exist.
CREATE TABLE IF NOT EXISTS ai_reasoning_effort_hints (
  base_url   TEXT NOT NULL,
  model      TEXT NOT NULL,
  options    TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (base_url, model)
);

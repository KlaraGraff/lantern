-- Voice names a custom TTS endpoint told us it accepts, learned from the error
-- body of a rejected synthesis request.
--
-- There is no standard way to ask an OpenAI-compatible speech endpoint which
-- voices it has — `/v1/models` exists, `/v1/voices` does not — so a rejection is
-- the only reliable source besides the built-in OpenAI names. Keyed by model as
-- well as base URL because one gateway serves several speech models and they do
-- not share a voice set.
CREATE TABLE IF NOT EXISTS speech_voice_hints (
  base_url   TEXT NOT NULL,
  model      TEXT NOT NULL,
  options    TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (base_url, model)
);

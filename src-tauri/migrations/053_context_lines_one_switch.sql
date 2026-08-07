-- One switch behind two doors.
--
-- Context lines shipped with their own settings key, written by the sub-row on
-- the embedding settings page. They are now also a registered automatic
-- analysis job (`commands/auto_analysis.rs`), and that registry keys every
-- job's switch as `auto_analysis_enabled_<job id>`. Left alone, that would be
-- two keys for one feature: turning it off on the embedding page would leave
-- the console showing it on, still spending, with a switch that appeared to do
-- nothing. The console's whole claim is that what it lists is what runs.
--
-- So the registry's key wins — it is the one a reader can find by looking at
-- the list of everything that spends their quota — and the embedding page
-- becomes a second door onto it. This carries over whatever the reader already
-- chose, then drops the old key so nothing can read a stale answer from it.
--
-- Only an explicit value is carried. An absent row means "never touched the
-- switch", and both keys default to on, so there is nothing to preserve.

INSERT INTO settings (key, value)
SELECT 'auto_analysis_enabled_grounding_context', value
FROM settings WHERE key = 'ai_context_lines_enabled'
ON CONFLICT(key) DO UPDATE SET value = excluded.value;

DELETE FROM settings WHERE key = 'ai_context_lines_enabled';

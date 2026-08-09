-- Migration 068 — what a profile card was actually drawn from.
--
-- `profile_cards.evidence` (migration 056) is a phrase the summarizer model
-- wrote about itself, in the same generation call as the conclusion: it reads
-- like a citation but points at nothing. Nothing downstream can check it, and
-- the reader has no way to see the records behind a conclusion about them.
--
-- `evidence_payload` fixes that by storing the exact pre-aggregation block
-- that was handed to the summarizer for this dimension in the run that wrote
-- this conclusion — counts, distributions, and the sampled records
-- themselves. Its shape depends on the slot (follow-up dimensions carry
-- `sampled_examples`, `lookup_pattern` carries a band distribution and sample
-- words, and so on); Rust stores and forwards it verbatim and never parses
-- it, same house pattern as `mastery_events.detail` in migration 038.
--
-- It is a snapshot on purpose, not a query re-run at view time. Recomputing
-- the aggregation when the reader opens the card would show today's reading
-- data, which is not what the conclusion was drawn from — the whole point of
-- the drill-down is that the conclusion and its evidence stay pinned to each
-- other.
--
-- Never enters a prompt: the summarizer already saw this data on the way in,
-- and the follow-up prompt only ever carries conclusions (see
-- `commands::profile::injection_block`).
ALTER TABLE profile_cards ADD COLUMN evidence_payload TEXT;

-- When that snapshot was taken. Distinct from `updated_at`, which also moves
-- on a move/undo/delete — this only moves when a summarizer run rewrote the
-- conclusion, so it is the honest "这条结论是什么时候、根据哪一批记录下的".
ALTER TABLE profile_cards ADD COLUMN evidence_at INTEGER;

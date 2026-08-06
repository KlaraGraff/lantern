-- Migration 039 — the bookkeeping the mastery engine needs to actually run.
-- See docs/impls/wiring-mastery-into-reading.md.
--
-- 037 collects exposures and 038 stores tiers; nothing in between could run
-- twice safely, because reading_word_exposures is a running total. These
-- columns and this table are that missing middle.

-- (a) How far the scorer has already read down each exposure row.
-- encounter_count only ever grows, so a scoring pass that did not remember
-- where it stopped would re-score every exposure the reader has ever had on
-- every run and walk the word straight up to 'mastered'. The delta
-- (encounter_count - scored_encounter_count) is one pass's work, and
-- scored_encounter_count + 1 is the §2.2 occurrence number the diminishing
-- weight table is indexed by — which keeps the sequence continuous across
-- passes instead of restarting at 1 each time.
ALTER TABLE reading_word_exposures
  ADD COLUMN scored_encounter_count INTEGER NOT NULL DEFAULT 0;

-- (b) The same watermark for the lookup-active subset. Both are aggregates,
-- so a pass can know that 3 of the 5 new encounters were on a screen where
-- the reader was looking something else up, but not *which* 3. They are
-- credited to the earliest of the new encounters — the ones carrying the
-- highest §2.2 weight. §2.4 says every boundary breaks toward the reader,
-- and CHAPTER_CREDIT_CAP bounds how far that can go.
ALTER TABLE reading_word_exposures
  ADD COLUMN scored_lookup_active_count INTEGER NOT NULL DEFAULT 0;

-- (c) How many separate days this word was seen on in this chapter.
--
-- The word-detail page promises the reader a sentence with a number in it —
-- "you read it 4 times over 3 days without looking it up" (i18n key
-- vocab.mastery.because.exposure_promotion.detail). Nothing recorded so far
-- can produce that number: the row keeps a running total and a first/last
-- timestamp, and four encounters between those two timestamps could be one
-- afternoon or four weeks.
--
-- Maintained in the upsert with no extra read: the stored last_seen_at is
-- compared, in the reader's local timezone, against the screen being folded
-- in, and the counter advances only when the calendar day differs. Local
-- rather than UTC because the sentence says "days" and means the reader's
-- days. Screens arriving out of order across a day boundary can add one day
-- twice; that is the only inaccuracy, it needs a batch that straddles
-- midnight to happen at all, and it moves a display number by one.
--
-- Backfills to 1 for existing rows rather than 0: those rows record real
-- encounters, and a word seen at all was seen on at least one day. Zero would
-- read as "seen, but on no day".
ALTER TABLE reading_word_exposures
  ADD COLUMN distinct_days INTEGER NOT NULL DEFAULT 1;

-- (d) The running arithmetic behind a tier: credit since the last tier
-- change, and where the word sits in a chain of repeat lookups.
--
-- Device-local, for the same reason reading_word_exposures (037) and
-- mastery_events (038) are: every number here is derived from *this*
-- device's reading behaviour. The conclusion syncs — vocab_words.mastery and
-- the one-sentence mastery_reason are on the syncable path precisely so a
-- second device never shows a changed tier with no explanation — but the
-- half-finished sum behind it has no meaning on a device that did not do the
-- reading.
--
-- No row means no credit and no lookup history, which is the correct reading
-- of a word the engine has never touched; rows are created on first write
-- rather than seeded alongside vocab_words.
CREATE TABLE IF NOT EXISTS mastery_progress (
    vocab_word_id TEXT PRIMARY KEY REFERENCES vocab_words(id) ON DELETE CASCADE,
    -- Credit accrued since the last tier change, never a lifetime total.
    credit REAL NOT NULL DEFAULT 0 CHECK(credit >= 0),
    -- When the previous lookup happened; the repeat window is measured from
    -- this, so a reader who keeps checking a word stays inside one chain.
    last_lookup_at INTEGER,
    lookups_in_window INTEGER NOT NULL DEFAULT 0 CHECK(lookups_in_window >= 0),
    updated_at INTEGER NOT NULL
);

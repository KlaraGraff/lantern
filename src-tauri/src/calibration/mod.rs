//! The local calibration table: a few numbers about *this reader's* own
//! habits, measured from their own history, refreshed once a day.
//!
//! Design: `docs/impls/reading-driven-mastery-and-review.md` §5.2 and §8;
//! `docs/impls/reading-flow-decisions-2026-08-06.md` §4.1.
//!
//! ## What this is not
//!
//! Not machine learning, not a model, not a per-word anything. §8's own
//! words: "算法本身一个字不改，只是把几个原本写死的数字，换成从用户自己的
//! 数据里量出来的数字" (the algorithm itself does not change a single
//! character; a few numbers that used to be hard-coded are swapped for
//! numbers measured from the user's own data). The scoring rules in
//! [`crate::mastery`] are untouched by this module; it only produces one
//! number ([`lookup_rate_scale`]) that rule now reads instead of assuming
//! every reader looks words up at the same rate.
//!
//! ## The two guardrails from §8.2, and exactly where each holds
//!
//! 1. **Not enough samples -> default value.** [`compute`] leaves a
//!    statistic `NULL` in `local_calibration` whenever its own sample floor
//!    isn't cleared ([`MIN_SCREENS_FOR_SPEED`], [`MIN_WORDS_FOR_LOOKUP_RATE`]
//!    below), and [`lookup_rate_scale`] reads a missing rate as "no
//!    calibration yet" and returns the neutral `1.0` — the exact behavior
//!    the scoring engine had before this module existed. See
//!    `too_few_words_leaves_the_rate_unset` and
//!    `lookup_rate_scale_is_neutral_with_no_calibration_data` in
//!    `tests.rs`.
//! 2. **Recompute never rewrites history.** [`recompute`] does exactly one
//!    thing: overwrite the single row in `local_calibration`. Nothing in
//!    this file holds a reference to `vocab_words`, `mastery_progress`, or
//!    `mastery_events` — there is no code path here that could touch a
//!    word's already-decided tier even by accident. The new number only
//!    reaches a word's score the next time
//!    [`crate::mastery::store::score_book_exposures`] runs *forward* from
//!    wherever its watermark currently sits; a recompute with no new
//!    exposures pending changes nothing about any word. See
//!    `recompute_never_touches_already_scored_mastery_state` in `tests.rs`.
//!
//! ## Why this table, not a rewire of the existing per-batch pace check
//!
//! `commands::reading_behavior::reader_median_wpm` already recomputes a
//! pace baseline on every write, from the 500 most recent screens, for the
//! §2.4 too-fast exclusion. That path is left alone here — it is mid-edit
//! by unrelated work on the same files, and its job (exclude one screen at
//! write time) is different from this table's job (decide, once a day, how
//! much a *skip* is worth). `reading_speed_wpm` is still measured and
//! stored below, since §4.1 asks for both statistics side by side, but
//! nothing yet reads it back out; it sits ready for the day the two
//! computations are worth merging into one.
//!
//! ## Cost
//!
//! [`compute`] never loops over `reading_word_exposures` or the full
//! `lookup_records` / `reading_screen_dwells` history in Rust. The lookup
//! rate is two SQL `SUM` aggregates — SQLite's own job, not this process's.
//! The reading-speed median has no SQL aggregate to lean on (SQLite has no
//! `MEDIAN`), so it stays a bounded, recency-ordered fetch of at most
//! [`SPEED_SAMPLE_SCREENS`] rows, mirroring the exact bound
//! `reading_behavior::MEDIAN_PACE_SAMPLE` already uses for the same
//! reason: a stable picture of this reader does not require the whole
//! history, and the cost of a run must not grow with how long they have
//! owned the app.

use rusqlite::{params, Connection, OptionalExtension};

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::mastery::{median_words_per_minute, ScreenPace};

// ---------------------------------------------------------------------------
// Sample-size floors — guardrail 1.
// ---------------------------------------------------------------------------

/// §5.1's own number: "生效门槛：约 30 屏" (effective threshold: about 30
/// screens). Below this, `reading_speed_wpm` stays `NULL` rather than
/// reporting a median built from a handful of screens.
const MIN_SCREENS_FOR_SPEED: i64 = 30;

/// How many most-recent measurable screens the stored median is drawn from.
/// Same bound, same reasoning, as
/// `commands::reading_behavior::MEDIAN_PACE_SAMPLE`.
const SPEED_SAMPLE_SCREENS: i64 = 500;

/// The floor below which `lookup_rate_per_1000` stays `NULL`.
///
/// At 5,000 words, even a reader at the low end of §5.2's own example range
/// (1 lookup per 1000 words) has produced on the order of five lookups —
/// enough that one extra or missing lookup moves the measured rate by at
/// most 0.2 per 1000, not enough to flip which side of the neutral point
/// (see [`lookup_rate_scale`]) the reader lands on. Below this floor the
/// rate is noise, not a habit, and the task's own instruction — do not let
/// a 3-sample median move someone's learning state — applies just as much
/// to a rate as to a median.
const MIN_WORDS_FOR_LOOKUP_RATE: i64 = 5_000;

/// How long a calibration stays fresh before [`maybe_recompute_daily`] runs
/// it again. Expressed as an interval rather than a calendar-day check so a
/// reader who skips a day (or three) still gets exactly one recompute on
/// their next launch, not a backlog — §4.1's "每天启动重算一次" (recompute
/// once per launch, per day) is a ceiling on frequency, not a promise that
/// every calendar day gets its own run.
const RECOMPUTE_INTERVAL_MS: i64 = 24 * 60 * 60 * 1000;

/// One row of `local_calibration` (migration 046), exactly as stored.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Calibration {
    pub reading_speed_wpm: Option<f64>,
    pub reading_speed_sample_screens: i64,
    pub lookup_rate_per_1000: Option<f64>,
    pub lookup_rate_sample_words: i64,
    pub updated_at: i64,
}

/// Read the current calibration without recomputing it. Missing row (should
/// not happen — migration 046 seeds it) reads as
/// `Calibration::default()`: every statistic `None`/zero, `updated_at = 0`,
/// which is indistinguishable from "never calibrated" and therefore safe.
pub fn load(db: &Db) -> AppResult<Calibration> {
    let conn = db.reader();
    load_from_conn(&conn)
}

/// Same read, against a connection or transaction the caller already holds.
/// `rusqlite::Transaction` derefs to `Connection`, so
/// `crate::mastery::store::score_book_exposures`'s own transaction can be
/// passed here directly rather than opening a second connection.
pub(crate) fn load_from_conn(conn: &Connection) -> AppResult<Calibration> {
    let row = conn
        .query_row(
            "SELECT reading_speed_wpm, reading_speed_sample_screens,
                    lookup_rate_per_1000, lookup_rate_sample_words, updated_at
               FROM local_calibration WHERE id = 1",
            [],
            |row| {
                Ok(Calibration {
                    reading_speed_wpm: row.get(0)?,
                    reading_speed_sample_screens: row.get(1)?,
                    lookup_rate_per_1000: row.get(2)?,
                    lookup_rate_sample_words: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            },
        )
        .optional()?;
    Ok(row.unwrap_or_default())
}

/// Recompute both statistics from this device's own history and overwrite
/// the single stored row in place. See the module doc's guardrail 2: this
/// function's only write is to `local_calibration`.
pub fn recompute(db: &Db, now: i64) -> AppResult<Calibration> {
    let calibration = {
        let conn = db.reader();
        compute(&conn, now)?
    };
    let conn = db
        .conn
        .lock()
        .map_err(|_| AppError::Other("DB_LOCK_POISONED".to_string()))?;
    save(&conn, &calibration)?;
    Ok(calibration)
}

/// Run [`recompute`] if the stored row is missing or older than
/// [`RECOMPUTE_INTERVAL_MS`]. Meant to be called once at startup; cheap and
/// idempotent enough to call on every launch, since a fresh calibration
/// makes it a single indexed read followed by a no-op.
pub fn maybe_recompute_daily(db: &Db, now: i64) -> AppResult<bool> {
    let current = load(db)?;
    if now.saturating_sub(current.updated_at) < RECOMPUTE_INTERVAL_MS {
        return Ok(false);
    }
    recompute(db, now)?;
    Ok(true)
}

fn compute(conn: &Connection, now: i64) -> AppResult<Calibration> {
    // -- §5.1: reading speed. Bounded recency scan; median taken in Rust
    // because SQLite has no MEDIAN aggregate. Reuses the pure function the
    // mastery engine already validates against, rather than re-deriving the
    // median-of-paces arithmetic here.
    let mut stmt = conn.prepare(
        "SELECT word_count, dwell_ms FROM reading_screen_dwells
          WHERE word_count > 0 AND dwell_ms > 0
          ORDER BY started_at DESC
          LIMIT ?1",
    )?;
    let screens = stmt
        .query_map(params![SPEED_SAMPLE_SCREENS], |row| {
            Ok(ScreenPace {
                word_count: row.get(0)?,
                dwell_ms: row.get(1)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let reading_speed_sample_screens = screens.len() as i64;
    let reading_speed_wpm = if reading_speed_sample_screens >= MIN_SCREENS_FOR_SPEED {
        median_words_per_minute(&screens)
    } else {
        None
    };

    // -- §5.2: lookup rate. Two SQL SUMs, each a single aggregate row —
    // no per-row Rust iteration over either table.
    let total_lookups: i64 = conn.query_row(
        "SELECT COALESCE(SUM(lookup_count), 0) FROM lookup_records",
        [],
        |row| row.get(0),
    )?;
    let total_words: i64 = conn.query_row(
        "SELECT COALESCE(SUM(word_count), 0) FROM reading_screen_dwells",
        [],
        |row| row.get(0),
    )?;
    let lookup_rate_per_1000 = if total_words >= MIN_WORDS_FOR_LOOKUP_RATE {
        Some(total_lookups.max(0) as f64 * 1000.0 / total_words as f64)
    } else {
        None
    };

    Ok(Calibration {
        reading_speed_wpm,
        reading_speed_sample_screens,
        lookup_rate_per_1000,
        lookup_rate_sample_words: total_words.max(0),
        updated_at: now,
    })
}

fn save(conn: &Connection, calibration: &Calibration) -> AppResult<()> {
    conn.execute(
        "UPDATE local_calibration
            SET reading_speed_wpm = ?1, reading_speed_sample_screens = ?2,
                lookup_rate_per_1000 = ?3, lookup_rate_sample_words = ?4,
                updated_at = ?5
          WHERE id = 1",
        params![
            calibration.reading_speed_wpm,
            calibration.reading_speed_sample_screens,
            calibration.lookup_rate_per_1000,
            calibration.lookup_rate_sample_words,
            calibration.updated_at,
        ],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// §5.2: scaling the "read it, never looked it up" signal by how much a skip
// is worth for *this* reader.
// ---------------------------------------------------------------------------

/// §5.2's low worked example: a reader who looks up about 1 word per 1000
/// read. The design doc's own instance of a rate too low to make a skip
/// worth much.
const LOW_RATE_PER_1000: f64 = 1.0;

/// §5.2's high worked example: about 15 lookups per 1000 words — a reader
/// working through the text closely enough that a word they *did not* stop
/// for is strong evidence.
const HIGH_RATE_PER_1000: f64 = 15.0;

/// The floor on [`lookup_rate_scale`]'s output.
///
/// Never lower, and never zero: §5.2 says a low rate makes the "not looked
/// up" signal *less credible*, not worthless — the same "small but never
/// zero" principle [`crate::mastery`]'s own occurrence weights already
/// follow for a different signal (`TAIL_OCCURRENCE_WEIGHT`). It is also
/// what makes the "never over-credit a low-rate reader" requirement hold
/// by construction rather than by a separate check: 0.5 sits below the 1.0
/// neutral point, so a low-confidence signal can only ever be discounted
/// from the unscaled amount, never inflated past it.
const MIN_SCALE: f64 = 0.5;

/// The ceiling on [`lookup_rate_scale`]'s output. Symmetric with
/// [`MIN_SCALE`] around the neutral point — 1.0 sits exactly halfway
/// between 0.5 and 1.5 — so a reader who looks up often is rewarded by
/// exactly as much as a reader who rarely does is discounted.
const MAX_SCALE: f64 = 1.5;

/// How much a "read this word, did not look it up" exposure is worth for a
/// reader with this lookup rate, as a multiplier on the credit
/// [`crate::mastery::apply_exposures`] would otherwise grant that exposure.
/// The mastery thresholds themselves ([`crate::mastery`]'s `FAMILIAR_CREDIT`
/// / `MASTERED_CREDIT`) are never touched — see that module's doc comment
/// for why 4.0 is load-bearing for the word-detail page's own copy. Scaling
/// the credit each exposure earns has the same practical effect §5.2's
/// table describes (a high-lookup-rate reader effectively needs fewer
/// exposures to promote, a low-rate reader more) without moving a number
/// the UI already promises the reader is exact.
///
/// ## The derivation
///
/// §5.2 gives two worked examples and states what they mean, but not a
/// formula. Turning it into one:
///
/// 1. **Anchor the two examples to the two ends of the output range** —
///    [`LOW_RATE_PER_1000`] to [`MIN_SCALE`], [`HIGH_RATE_PER_1000`] to
///    [`MAX_SCALE`] — since those are the only two points the design
///    actually commits to; everything between and beyond them is this
///    module's own extrapolation, kept as small as it can be.
/// 2. **Interpolate in *log* space, not linear.** Lookup rate spans more
///    than an order of magnitude between the two anchors. What should move
///    the scale by a fixed amount is the reader's rate *doubling*, not an
///    additive step of lookups-per-1000 — going from 1 to 2 per 1000 says
///    as much about a reader's habit as going from 7 to 14 does. Log-linear
///    interpolation is exactly the curve where equal *ratios* of rate
///    produce equal steps of scale; a linear interpolation would instead
///    make almost the entire 0.5–1.5 range trigger inside the first couple
///    of lookups-per-1000, which contradicts the two examples' own spacing
///    (1 and 15, not 1 and 2).
/// 3. **The neutral point falls out of steps 1 and 2, rather than being
///    chosen.** Log-linear interpolation between two anchor pairs puts
///    `scale = 1.0` at the *geometric* mean of the two rate anchors —
///    `sqrt(1 * 15) ≈ 3.87` per 1000 words. Nothing in §5.2 names this
///    number; it is what falls out of taking the two examples at face
///    value and refusing to also invent a third anchor.
/// 4. **Clamp outside `[1, 15]` rather than extrapolate further.** Nothing
///    in §5.2 says what a 50-per-1000 or a 0.1-per-1000 reader's skip
///    should be worth, and guessing past the two given examples is exactly
///    what the design warns against elsewhere for a harder case (§5.3:
///    "正确的处理不是硬猜，是识别出数据不足然后不下结论" — the right
///    response to thin evidence is not a bold guess, it is recognizing the
///    data does not support a conclusion and not drawing one). Clamping
///    both ends means the two guardrails below hold for every possible
///    input, not just the ones between the anchors.
///
/// ## Why this cannot over-credit a low-lookup-rate reader
///
/// `lookup_rate_scale` is monotonically non-decreasing in `rate`, and its
/// range is `[0.5, 1.5]` with `1.0` (no change from today's fixed
/// constants) at the geometric-mean rate. So for any reader at or below
/// that midpoint — which includes every rate §5.2 calls "low" — the
/// returned scale is **at most** 1.0: this signal can only discount their
/// credit relative to the unscaled baseline, never inflate it. The task's
/// requirement is exactly this: not a specific number, but a structural
/// guarantee that a low-lookup-rate reader is never *over*-credited by it.
///
/// `None` (no calibration yet, or [`MIN_WORDS_FOR_LOOKUP_RATE`] not
/// cleared) returns exactly `1.0` — guardrail 1: unmeasured means
/// unchanged, never guessed at.
pub fn lookup_rate_scale(rate_per_1000: Option<f64>) -> f64 {
    let Some(rate) = rate_per_1000.filter(|r| r.is_finite() && *r > 0.0) else {
        return 1.0;
    };
    let clamped = rate.clamp(LOW_RATE_PER_1000, HIGH_RATE_PER_1000);
    let t = (clamped.ln() - LOW_RATE_PER_1000.ln())
        / (HIGH_RATE_PER_1000.ln() - LOW_RATE_PER_1000.ln());
    MIN_SCALE + t * (MAX_SCALE - MIN_SCALE)
}

#[cfg(test)]
mod tests;

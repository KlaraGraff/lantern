# Item 4 — Reading behavior exclusion rules, raw evidence

Raw facts only. No verdicts. Computed against the two real, on-disk databases:

- prod: `~/Library/Application Support/com.klaragraff.lantern/lantern.db`
- dev: `~/Library/Application Support/com.klaragraff.lantern-dev/lantern.db`

Both were **copied read-only** (including their `-wal`/`-shm` sidecars, so the
copy reflects any not-yet-checkpointed rows) into the scratchpad before any
querying; nothing was written to the real files. All computation below was
done in Python 3 against CSV exports of the copies — no product code was
modified, no `git add`/`commit` was run.

## 1. Source of truth — quoted lines

### Idle exclusion — `src-tauri/src/commands/reading_behavior.rs`

```
39:const IDLE_SCREEN_MS: i64 = 5 * 60 * 1000;
```

```
205:            let is_idle_screen = dwell_ms >= IDLE_SCREEN_MS && screen.operation_count == 0;
```

`dwell_ms` at that point (line 183) is `screen.ended_at - screen.started_at`,
i.e. exactly the `dwell_ms` column value (the INSERT at lines 185-203 stores
this same computed value). So the idle rule, restated over the stored
columns, is:

```
dwell_ms >= 300000 AND operation_count == 0
```

This confirms the user's summary exactly — the AND of both conditions, never
dwell time alone, matching the migration comment in
`src-tauri/migrations/037_reading_behavior.sql`:

```
-- was open >= 5 minutes AND had zero operations -> exclude as unreliable
-- evidence (per the user's explicit correction: it is the AND of both
-- conditions, never dwell time alone).
```

### Skim exclusion — `src-tauri/src/mastery/mod.rs`

```
111:const FAST_SCREEN_WPM_MULTIPLE: f64 = 3.0;
```

```
367:fn exceeds_pace_limit(words_per_minute: f64, median_wpm: Option<f64>) -> bool {
368:    let Some(median) = median_wpm.filter(|m| m.is_finite() && *m > 0.0) else {
369:        return false;
370:    };
371:    words_per_minute.is_finite() && words_per_minute > median * FAST_SCREEN_WPM_MULTIPLE
372:}
```

```
405:pub fn is_screen_too_fast(screen: ScreenPace, reader_median_wpm: Option<f64>) -> bool {
406:    if screen.word_count <= 0 || screen.dwell_ms <= 0 {
407:        return false;
408:    }
409:    let wpm = screen.word_count as f64 * 60_000.0 / screen.dwell_ms as f64;
410:    exceeds_pace_limit(wpm, reader_median_wpm)
411:}
```

So: **wpm = word_count * 60000 / dwell_ms**, and a screen is only ever
evaluated (never excluded, per line 406-408) when `word_count > 0 AND
dwell_ms > 0`. `exceeds_pace_limit` also breaks toward *not excluding* when
`wpm` or `median` is non-finite (comment at 364-366: "an unmeasurable screen
is a data problem, and §2.4 says data problems break toward the reader").

The median itself — `src-tauri/src/mastery/mod.rs:536-552`:

```
536:pub fn median_words_per_minute(screens: &[ScreenPace]) -> Option<f64> {
537:    let mut paces: Vec<f64> = screens
538:        .iter()
539:        .filter(|screen| screen.word_count > 0 && screen.dwell_ms > 0)
540:        .map(|screen| screen.word_count as f64 * 60_000.0 / screen.dwell_ms as f64)
541:        .collect();
542:    if paces.is_empty() {
543:        return None;
544:    }
545:    paces.sort_by(f64::total_cmp);
546:    let middle = paces.len() / 2;
547:    if paces.len().is_multiple_of(2) {
548:        Some((paces[middle - 1] + paces[middle]) / 2.0)
549:    } else {
550:        Some(paces[middle])
551:    }
552:}
```

And what feeds it — `src-tauri/src/commands/reading_behavior.rs:49, 125-141`:

```
49:const MEDIAN_PACE_SAMPLE: i64 = 500;
```

```
125:fn reader_median_wpm(tx: &rusqlite::Transaction<'_>) -> AppResult<Option<f64>> {
126:    let mut stmt = tx.prepare(
127:        "SELECT word_count, dwell_ms FROM reading_screen_dwells
128:          WHERE word_count > 0 AND dwell_ms > 0
129:          ORDER BY started_at DESC
130:          LIMIT ?1",
131:    )?;
132:    let screens = stmt
133:        .query_map(params![MEDIAN_PACE_SAMPLE], |row| {
134:            Ok(ScreenPace {
135:                word_count: row.get("word_count")?,
136:                dwell_ms: row.get("dwell_ms")?,
137:            })
138:        })?
139:        .collect::<Result<Vec<_>, _>>()?;
140:    Ok(median_words_per_minute(&screens))
141:}
```

**Important correction to the task's own summary**: this query has **no
`book_id` filter**. The median is computed across the reader's whole local
database (all books), not per book — "reader" here means "this SQLite file",
not "this book". §2.4/§5.1's median baseline is a single number per
`reading_screen_dwells` table. Per-book distributions are still reported
below (item 3 asks for them "where the schema supports it"), but the actual
skim exclusion applied by the code uses one **database-wide** median per db,
computed over the most recent (by `started_at` desc) `MEDIAN_PACE_SAMPLE` =
500 rows with `word_count > 0 AND dwell_ms > 0` — since both real dbs have
fewer than 500 such rows, in practice this means "all measurable rows in
the db."

One more subtlety confirmed by reading the write path
(`reading_behavior.rs:175`): the median is computed **once per batch,
before that batch's own new rows are inserted** — so in the live system a
screen is never compared against a median that includes itself. For this
historical replay there is no "at time of write" snapshot to recover; we
compute the median once over each db's full current `reading_screen_dwells`
contents, which is the closest faithful reconstruction available from the
final state of the table.

### Table schema — `src-tauri/migrations/037_reading_behavior.sql`

Identical in both databases (verified below):

```sql
CREATE TABLE reading_screen_dwells (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  chapter TEXT,
  cfi TEXT,
  started_at INTEGER NOT NULL CHECK(started_at > 0),
  ended_at INTEGER NOT NULL CHECK(ended_at >= started_at),
  dwell_ms INTEGER NOT NULL CHECK(dwell_ms >= 0),
  operation_count INTEGER NOT NULL DEFAULT 0 CHECK(operation_count >= 0),
  lookup_count INTEGER NOT NULL DEFAULT 0 CHECK(lookup_count >= 0),
  word_count INTEGER NOT NULL DEFAULT 0 CHECK(word_count >= 0),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_reading_screen_dwells_book_started
  ON reading_screen_dwells(book_id, started_at DESC);
```

Note the column `CHECK` constraints already forbid `dwell_ms < 0`, so a
negative `dwell_ms` cannot exist in either database (confirmed empirically
below: 0 rows with `dwell_ms <= 0` in either db).

## 2. Commands run

```bash
# Read-only copies (including WAL/SHM so uncommitted/checkpointed pages come along)
cp "$HOME/Library/Application Support/com.klaragraff.lantern/lantern.db"     "$SCRATCH/prod-lantern.db"
cp "$HOME/Library/Application Support/com.klaragraff.lantern/lantern.db-wal" "$SCRATCH/prod-lantern.db-wal"
cp "$HOME/Library/Application Support/com.klaragraff.lantern/lantern.db-shm" "$SCRATCH/prod-lantern.db-shm"
cp "$HOME/Library/Application Support/com.klaragraff.lantern-dev/lantern.db"     "$SCRATCH/dev-lantern.db"
cp "$HOME/Library/Application Support/com.klaragraff.lantern-dev/lantern.db-wal" "$SCRATCH/dev-lantern.db-wal"
cp "$HOME/Library/Application Support/com.klaragraff.lantern-dev/lantern.db-shm" "$SCRATCH/dev-lantern.db-shm"

sqlite3 "$SCRATCH/prod-lantern.db" ".schema reading_screen_dwells"
sqlite3 "$SCRATCH/dev-lantern.db"  ".schema reading_screen_dwells"
sqlite3 "$SCRATCH/prod-lantern.db" "SELECT COUNT(*) FROM reading_screen_dwells;"
sqlite3 "$SCRATCH/dev-lantern.db"  "SELECT COUNT(*) FROM reading_screen_dwells;"

sqlite3 -header -csv "$SCRATCH/prod-lantern.db" \
  "SELECT id, book_id, chapter, cfi, started_at, ended_at, dwell_ms, operation_count, lookup_count, word_count, created_at FROM reading_screen_dwells ORDER BY started_at;" \
  > docs/impls/automation-review/evidence/item-4-dwells-prod.csv
sqlite3 -header -csv "$SCRATCH/dev-lantern.db" \
  "SELECT id, book_id, chapter, cfi, started_at, ended_at, dwell_ms, operation_count, lookup_count, word_count, created_at FROM reading_screen_dwells ORDER BY started_at;" \
  > docs/impls/automation-review/evidence/item-4-dwells-dev.csv

# Anomaly sanity checks against the live copies (not just the CSV)
sqlite3 "$SCRATCH/prod-lantern.db" "SELECT COUNT(*) FROM reading_screen_dwells WHERE dwell_ms<=0;"   # -> 0
sqlite3 "$SCRATCH/dev-lantern.db"  "SELECT COUNT(*) FROM reading_screen_dwells WHERE dwell_ms<=0;"   # -> 0
sqlite3 "$SCRATCH/prod-lantern.db" "SELECT COUNT(*) FROM reading_screen_dwells WHERE word_count IS NULL;" # -> 0
sqlite3 "$SCRATCH/dev-lantern.db"  "SELECT COUNT(*) FROM reading_screen_dwells WHERE word_count IS NULL;" # -> 0
sqlite3 "$SCRATCH/prod-lantern.db" "SELECT MAX(dwell_ms) FROM reading_screen_dwells;"  # -> 45358
sqlite3 "$SCRATCH/dev-lantern.db"  "SELECT MAX(dwell_ms) FROM reading_screen_dwells;"  # -> 114862

python3 analyze_dwells.py item-4-dwells-prod.csv item-4-dwells-dev.csv   # full script quoted/embedded below
```

Full analysis script (`analyze_dwells.py`, run from the scratchpad, reading
only the two CSV exports — no direct DB access at analysis time):

```python
IDLE_SCREEN_MS = 5 * 60 * 1000          # reading_behavior.rs:39
FAST_SCREEN_WPM_MULTIPLE = 3.0          # mastery/mod.rs:111
MEDIAN_PACE_SAMPLE = 500                # reading_behavior.rs:49

def median_words_per_minute(pairs):     # transcription of mastery/mod.rs:536-552
    paces = [wc * 60_000.0 / dm for (wc, dm) in pairs if wc > 0 and dm > 0]
    if not paces:
        return None
    paces.sort()
    n = len(paces)
    middle = n // 2
    if n % 2 == 0:
        return (paces[middle - 1] + paces[middle]) / 2.0
    else:
        return paces[middle]

def exceeds_pace_limit(wpm, median):    # mastery/mod.rs:367-372
    if median is None or not math.isfinite(median) or median <= 0.0:
        return False
    return math.isfinite(wpm) and wpm > median * FAST_SCREEN_WPM_MULTIPLE

def is_screen_too_fast(word_count, dwell_ms, median):  # mastery/mod.rs:405-411
    if word_count <= 0 or dwell_ms <= 0:
        return False
    wpm = word_count * 60_000.0 / dwell_ms
    return exceeds_pace_limit(wpm, median)

def reader_median_wpm(rows):            # reading_behavior.rs:125-141
    filtered = [r for r in rows if r["word_count"] > 0 and r["dwell_ms"] > 0]
    filtered.sort(key=lambda r: r["started_at"], reverse=True)
    top = filtered[:MEDIAN_PACE_SAMPLE]
    pairs = [(r["word_count"], r["dwell_ms"]) for r in top]
    return median_words_per_minute(pairs), len(top)
```

Percentiles use linear interpolation between order statistics (numpy's
default `"linear"` method) over each metric's full row set.

## 3. Schema dump and row counts

Both databases returned byte-identical `CREATE TABLE reading_screen_dwells`
and index DDL (shown in §1 above).

| db | total rows | distinct book_id |
|---|---|---|
| prod | 212 | 1 (`cb8d61b1-e5e2-4fdd-9024-6ccd08ae4e6e`, "Embracing Hope") |
| dev | 169 | 3 (`3f97c78a…` "The Adventures of Tom Sawyer", `73cca713…` "Embracing Hope", `a3adbb72…` "Little Prince") |

Raw exports: `item-4-dwells-prod.csv` (213 lines incl. header), `item-4-dwells-dev.csv` (170 lines incl. header), alongside this file.

## 4. Distributions

### 4.1 prod (n=212, single book)

| metric | min | p10 | p25 | p50 | p75 | p90 | p95 | p99 | max |
|---|---|---|---|---|---|---|---|---|---|
| dwell_ms | 120 | 616.1 | 1004.3 | 1849.0 | 3792.8 | 7172.0 | 10392.2 | 32708.7 | 45358 |
| word_count | 94 | 143 | 143 | 189 | 206 | 213 | 213 | 236.8 | 535 |
| wpm (word_count>0 & dwell_ms>0, n=212) | 200.9 | 1419.3 | 2829.9 | 5619.3 | 10734.4 | 17678.6 | 20505.9 | 28151.6 | 93000.0 |

operation_count histogram (prod): `0` → 211 rows, `1` → 0, `2` → 0, `3+` → 1 row.

### 4.2 dev (n=169, 3 books)

Whole-db:

| metric | min | p10 | p25 | p50 | p75 | p90 | p95 | p99 | max |
|---|---|---|---|---|---|---|---|---|---|
| dwell_ms | 6 | 513.8 | 855.0 | 1476.0 | 4153.0 | 7578.4 | 14785.8 | 82317.0 | 114862 |
| word_count | 0 | 30 | 80 | 133 | 200 | 246 | 249 | 255.3 | 256 |
| wpm (word_count>0 & dwell_ms>0, n=166) | 51.2 | 613.9 | 1314.7 | 3529.4 | 11035.2 | 19601.4 | 26179.5 | 107838.4 | 530000.0 |

operation_count histogram (dev): `0` → 153 rows, `1` → 9 rows, `2` → 7 rows, `3+` → 0 rows.

Per book (dev), same metrics:

| book | n | dwell_ms min/p50/max | word_count min/p50/max | wpm (measurable n) min/p50/max |
|---|---|---|---|---|
| 73cca713… "Embracing Hope" | 86 | 6 / 1156.5 / 19754 | 9 / 163.5 / 256 | (86) 455.2 / 7075.0 / 530000.0 |
| 3f97c78a… "Tom Sawyer" | 42 | 441 / 4978.0 / 85564 | 0 / 149.5 / 255 | (41) 106.2 / 2360.0 / 27210.9 |
| a3adbb72… "Little Prince" | 41 | 515 / 1321.0 / 114862 | 0 / 66.0 / 211 | (39) 51.2 / 2177.4 / 17774.0 |

(Full percentile sets for each book are in the raw script output; reported
here at min/median/max for brevity — the whole-db rows above are the ones
that actually feed the code's exclusion rules, since the median query is
not book-scoped.)

## 5. IDLE rule applied to every row

Rule: `dwell_ms >= 300000 AND operation_count == 0`.

| db | excluded | total | % |
|---|---|---|---|
| prod | 0 | 212 | 0.00% |
| dev | 0 | 169 | 0.00% |

**No row in either database reaches the 5-minute dwell floor.** Max dwell in
prod is 45,358 ms (45.4 s); max dwell in dev is 114,862 ms (114.9 s, ≈1.9
min). The idle rule excludes nothing in the real data collected so far —
there is no exhaustive list to show because it is empty in both databases.

## 6. SKIM rule applied to every row

Rule: for rows with `word_count > 0 AND dwell_ms > 0`, `wpm = word_count *
60000 / dwell_ms`; excluded when `wpm > median * 3.0`, median computed
per §1 above (whole-db, most recent ≤500 measurable rows).

| db | median wpm | sample size for median | 3x threshold | excluded | total | % |
|---|---|---|---|---|---|---|
| prod | 5619.280252199985 | 212 | 16857.8408 | 23 | 212 | 10.85% |
| dev | 3529.375958156732 | 166 | 10588.1279 | 44 | 169 | 26.04% |

### 6.1 prod — all 23 excluded (skimmed) rows

All 23 rows are in the one prod book, `cb8d61b1… "Embracing Hope"`, chapters
"Foreword by Alexander Vesely-Frankl" and "Introduction by Dr. Tobias Esch".

| id | chapter | started_at | dwell_ms | dwell_min | operation_count | lookup_count | word_count | wpm | ×median |
|---|---|---|---|---|---|---|---|---|---|
| c756356a-af4a-4e9c-8c00-b5c73d2cc392 | Foreword by Alexander Vesely-Frankl | 1786047200871 | 612 | 0.0102 | 0 | 0 | 213 | 20882.35 | 3.716 |
| 24658c47-988a-4365-99f0-b985f0def77e | Foreword by Alexander Vesely-Frankl | 1786047202571 | 582 | 0.0097 | 0 | 0 | 213 | 21958.76 | 3.908 |
| f66a6748-3476-4d5e-9b7d-d72bb1d1d52f | Foreword by Alexander Vesely-Frankl | 1786047224518 | 581 | 0.0097 | 0 | 0 | 198 | 20447.50 | 3.639 |
| b2f77a91-d28d-4438-b735-6cd6ed4c7474 | Foreword by Alexander Vesely-Frankl | 1786047262813 | 717 | 0.0120 | 0 | 0 | 213 | 17824.27 | 3.172 |
| a5200e94-136f-44eb-a047-2fd90ff52c7c | Foreword by Alexander Vesely-Frankl | 1786047264654 | 643 | 0.0107 | 0 | 0 | 213 | 19875.58 | 3.537 |
| 281ce1a2-9489-4a92-abd3-8e119f42870e | Foreword by Alexander Vesely-Frankl | 1786047300702 | 483 | 0.0080 | 0 | 0 | 227 | 28198.76 | 5.018 |
| a33b530a-fedb-4362-a27b-2f4295a492e2 | Foreword by Alexander Vesely-Frankl | 1786047301185 | 629 | 0.0105 | 0 | 0 | 213 | 20317.97 | 3.616 |
| e167421e-8952-4784-a06e-d012e45ce446 | Foreword by Alexander Vesely-Frankl | 1786047346649 | 714 | 0.0119 | 0 | 0 | 213 | 17899.16 | 3.185 |
| 110e4197-dd4f-41ad-aecd-e63a922a1fa8 | Foreword by Alexander Vesely-Frankl | 1786047364402 | 616 | 0.0103 | 0 | 0 | 199 | 19383.12 | 3.449 |
| faeada6a-ac6e-4055-b2e0-808f6e5ec7bb | Foreword by Alexander Vesely-Frankl | 1786048245535 | 279 | 0.0046 | 0 | 0 | 204 | 43870.97 | 7.807 |
| 545b7c53-9198-4e6c-9b2d-609ea0b39437 | Foreword by Alexander Vesely-Frankl | 1786052339248 | 120 | 0.0020 | 0 | 0 | 186 | 93000.00 | 16.550 |
| 00418ce7-ccea-4caf-91b6-94ecc9024164 | Foreword by Alexander Vesely-Frankl | 1786052452680 | 617 | 0.0103 | 0 | 0 | 186 | 18087.52 | 3.219 |
| f59ff7c2-de6e-4515-8046-66b19b0579f7 | Foreword by Alexander Vesely-Frankl | 1786052788291 | 417 | 0.0069 | 0 | 0 | 193 | 27769.78 | 4.942 |
| d30f15ac-3ebb-43c4-9956-95c530718d53 | Introduction by Dr. Tobias Esch | 1786053075113 | 697 | 0.0116 | 0 | 0 | 208 | 17905.31 | 3.186 |
| afcdfed6-4220-4f15-ab29-96fbfdd93c2e | Introduction by Dr. Tobias Esch | 1786053180544 | 425 | 0.0071 | 0 | 0 | 143 | 20188.24 | 3.593 |
| 0ba37e2f-31d8-429b-a240-0b2781c144c6 | Foreword by Alexander Vesely-Frankl | 1786053182912 | 450 | 0.0075 | 0 | 0 | 186 | 24800.00 | 4.413 |
| 1df2547d-e7e3-4ebf-bae2-715af7ea23c7 | Foreword by Alexander Vesely-Frankl | 1786053183362 | 432 | 0.0072 | 0 | 0 | 191 | 26527.78 | 4.721 |
| 7eedec94-9af8-40b0-b10c-354d9cd01e9e | Introduction by Dr. Tobias Esch | 1786053275643 | 484 | 0.0081 | 0 | 0 | 143 | 17727.27 | 3.155 |
| 5b0efb76-5230-4ad4-925b-9c8a9374e30f | Introduction by Dr. Tobias Esch | 1786053299129 | 445 | 0.0074 | 0 | 0 | 143 | 19280.90 | 3.431 |
| 1494acc1-faa0-4a90-a52b-95ce3ea2d883 | Introduction by Dr. Tobias Esch | 1786058850966 | 589 | 0.0098 | 0 | 0 | 202 | 20577.25 | 3.662 |
| 5760a371-7826-4967-a426-0568e374a2d5 | Introduction by Dr. Tobias Esch | 1786058863514 | 566 | 0.0094 | 0 | 0 | 201 | 21307.42 | 3.792 |
| c0ea3118-4fc3-4165-9237-411a7036f32f | Introduction by Dr. Tobias Esch | 1786058905314 | 703 | 0.0117 | 0 | 0 | 202 | 17240.40 | 3.068 |
| 17eaf8df-d742-41dc-9fd7-728c6d81306b | Introduction by Dr. Tobias Esch | 1786119219510 | 481 | 0.0080 | 0 | 0 | 170 | 21205.82 | 3.774 |

All 23 have `operation_count = 0, lookup_count = 0`, `book_id =
cb8d61b1-e5e2-4fdd-9024-6ccd08ae4e6e`. `cfi` is present on every row but
omitted from the table for width; it is in the CSV export.

### 6.2 dev — all 44 excluded (skimmed) rows

| id | book_id | chapter | started_at | dwell_ms | operation_count | lookup_count | word_count | wpm | ×median |
|---|---|---|---|---|---|---|---|---|---|
| 16303b83-b6fc-442d-9bde-48aa6b72bb55 | 73cca713… | Foreword by Alexander Vesely-Frankl | 1786187949501 | 527 | 0 | 0 | 98 | 11157.50 | 3.161 |
| a24156ae-55c0-4007-8116-21cc0bf0ba45 | 73cca713… | Foreword by Alexander Vesely-Frankl | 1786192088360 | 1090 | 0 | 0 | 204 | 11229.36 | 3.182 |
| 35b2e845-6c6d-483a-b016-d5e9e73ecefe | 73cca713… | Foreword by Alexander Vesely-Frankl | 1786192089450 | 444 | 0 | 0 | 253 | 34189.19 | 9.687 |
| 10b470ba-4a8f-4b91-bb45-acd29636d25a | 73cca713… | Foreword by Alexander Vesely-Frankl | 1786192103696 | 1071 | 0 | 0 | 206 | 11540.62 | 3.270 |
| ad52d1bf-f344-4820-aac6-6821b9bc5768 | 73cca713… | Foreword by Alexander Vesely-Frankl | 1786192110222 | 899 | 0 | 0 | 188 | 12547.27 | 3.555 |
| dab901e1-aa94-490d-b81e-b54178c392df | 73cca713… | (untitled/blank) | 1786192111121 | 728 | 0 | 0 | 157 | 12939.56 | 3.666 |
| 25055946-2524-4052-a2da-0edd4af6b55a | 3f97c78a… | CONTENTS | 1786192174694 | 878 | 0 | 0 | 206 | 14077.45 | 3.989 |
| 33bd2211-e553-44f9-b8c8-635cf0520293 | 3f97c78a… | CONTENTS | 1786192181253 | 931 | 0 | 0 | 200 | 12889.37 | 3.652 |
| e29715bd-5985-4e8b-a232-bec5a0611ea7 | 3f97c78a… | CONTENTS | 1786192182184 | 867 | 0 | 0 | 200 | 13840.83 | 3.922 |
| fb81e02d-ce67-4872-90df-9b65c05a6be1 | 3f97c78a… | CONTENTS | 1786192183051 | 1117 | 0 | 0 | 200 | 10743.06 | 3.044 |
| f0c444f2-91b7-4b16-a408-0cd1cfc37619 | 3f97c78a… | CONTENTS | 1786192184168 | 441 | 0 | 0 | 200 | 27210.88 | 7.710 |
| f83cd408-f9b9-4ef5-b5c7-0280072da308 | 3f97c78a… | CONTENTS | 1786192184609 | 773 | 0 | 0 | 200 | 15523.93 | 4.398 |
| 63cf1820-4f72-4484-b54b-fe4c1245d67e | 73cca713… | Introduction by Dr. Tobias Esch | 1786192192626 | 665 | 0 | 0 | 247 | 22285.71 | 6.314 |
| e450b7b9-d5a9-4693-aec2-e7578c4eef1d | 73cca713… | Introduction by Dr. Tobias Esch | 1786192193291 | 518 | 0 | 0 | 253 | 29305.02 | 8.303 |
| b64ef43a-03c1-4ebc-972a-da2f7743e4dd | 73cca713… | Introduction by Dr. Tobias Esch | 1786192199163 | 683 | 0 | 0 | 246 | 21610.54 | 6.123 |
| 2a098446-d23e-4b7b-b2c0-423bfcbfc64f | 73cca713… | Introduction by Dr. Tobias Esch | 1786192206538 | 964 | 0 | 0 | 246 | 15311.20 | 4.338 |
| 34020796-6f94-4eb4-9ca9-d7612e5eeb91 | 73cca713… | Introduction by Dr. Tobias Esch | 1786192207502 | 672 | 0 | 0 | 246 | 21964.29 | 6.223 |
| b0f9e081-e4a0-4fe0-825e-6ca83ccdb352 | 73cca713… | Introduction by Dr. Tobias Esch | 1786192208174 | 509 | 0 | 0 | 246 | 28998.04 | 8.216 |
| f48a76ae-6475-4f1c-a620-5f9b73ebf77b | 73cca713… | Introduction by Dr. Tobias Esch | 1786192208683 | 716 | 0 | 0 | 246 | 20614.53 | 5.841 |
| 6cc6df45-0a0c-4bcb-8be7-0b6ba726f04e | 73cca713… | Introduction by Dr. Tobias Esch | 1786192336075 | 952 | 0 | 0 | 209 | 13172.27 | 3.732 |
| 3f4c3d76-e24b-48e3-aea7-c1d1e3e0c5dc | 73cca713… | Introduction by Dr. Tobias Esch | 1786192338982 | 708 | 0 | 0 | 246 | 20847.46 | 5.907 |
| e8405453-845a-4cf4-9567-6eec03d506f3 | 73cca713… | Introduction by Dr. Tobias Esch | 1786192359108 | 500 | 0 | 0 | 240 | 28800.00 | 8.160 |
| c076f1d5-fd11-4291-8092-730bcf8accb5 | 73cca713… | Introduction by Dr. Tobias Esch | 1786192359608 | 551 | 2 | 2 | 212 | 23085.30 | 6.541 |
| 64d7c19a-c0d6-4eaf-9995-fd410887e6c0 | 73cca713… | Note from the Publisher | 1786192361622 | 1114 | 2 | 2 | 212 | 11418.31 | 3.235 |
| c1be1934-3f35-4f27-868f-4db8222a1e8c | 73cca713… | Introduction by Dr. Tobias Esch | 1786192362736 | 441 | 2 | 2 | 80 | 10884.35 | 3.084 |
| 722c4064-3798-4863-a156-42ffb246e9b3 | 73cca713… | Introduction by Dr. Tobias Esch | 1786192374450 | 461 | 0 | 0 | 212 | 27592.19 | 7.818 |
| 39a10f52-c9e5-40d3-a3cb-b0d32d20d45d | 73cca713… | Introduction by Dr. Tobias Esch | 1786192384899 | 715 | 0 | 0 | 212 | 17790.21 | 5.041 |
| 100f90ee-2cb9-481c-80db-debbad185afc | 73cca713… | Introduction by Dr. Tobias Esch | 1786192387500 | 450 | 0 | 0 | 240 | 32000.00 | 9.067 |
| 316c3731-a6ef-4f46-bc2e-33d90189827f | 73cca713… | Introduction by Dr. Tobias Esch | 1786192387950 | 883 | 0 | 0 | 256 | 17395.24 | 4.929 |
| 3dff9b55-461c-4ba5-8fd1-89a7b70c1dae | a3adbb72… | Antoine de Saint-Exupéry | 1786192954329 | 754 | 0 | 0 | 168 | 13368.70 | 3.788 |
| adc56767-4a1f-4cb2-81f0-d42ad9ea29eb | a3adbb72… | Antoine de Saint-Exupéry | 1786192959513 | 700 | 0 | 0 | 173 | 14828.57 | 4.201 |
| 8eb52c02-b44f-47d5-a31c-14678cd6e071 | a3adbb72… | Antoine de Saint-Exupéry | 1786192997087 | 701 | 0 | 0 | 190 | 16262.48 | 4.608 |
| 6184f526-4dec-4531-b90f-51e4a57e0ad0 | a3adbb72… | Antoine de Saint-Exupéry | 1786192997788 | 584 | 0 | 0 | 173 | 17773.97 | 5.036 |
| 14423ef0-8656-456d-a48c-00748a10fea1 | 73cca713… | Introduction by Dr. Tobias Esch | 1786193347172 | 450 | 0 | 0 | 135 | 18000.00 | 5.100 |
| be6f086c-f324-48d1-93bd-95349289e926 | 73cca713… | Introduction by Dr. Tobias Esch | 1786193348989 | 500 | 0 | 0 | 170 | 20400.00 | 5.780 |
| 40cedc6f-20ec-4235-bd0c-b0fecf6dd5d3 | 73cca713… | Introduction by Dr. Tobias Esch | 1786193349489 | 833 | 0 | 0 | 178 | 12821.13 | 3.633 |
| 6f16ea91-b5ef-4b43-a0eb-7de411ae0656 | 73cca713… | Introduction by Dr. Tobias Esch | 1786193350322 | 466 | 0 | 0 | 164 | 21115.88 | 5.983 |
| 566ade80-3188-4d7b-9085-69928aceb8dd | 73cca713… | Introduction by Dr. Tobias Esch | 1786193350788 | 568 | 0 | 0 | 178 | 18802.82 | 5.328 |
| a52e77d0-8429-4fb3-addb-4370302cf32a | 73cca713… | Introduction by Dr. Tobias Esch | 1786193352622 | 617 | 0 | 0 | 163 | 15850.89 | 4.491 |
| d21f8ecc-db54-4596-9d45-ec6017f75d5b | 73cca713… | Note from the Publisher | 1786193354806 | 433 | 0 | 0 | 80 | 11085.45 | 3.141 |
| 01d3a61e-2a1e-42bf-b558-5f2fbb4cfa37 | 73cca713… | Note from the Publisher | 1786193448069 | 13 | 0 | 0 | 53 | 244615.38 | 69.308 |
| 58941cc1-ea23-4625-b7fb-c92eef724061 | 73cca713… | Note from the Publisher | 1786193448169 | 6 | 0 | 0 | 53 | 530000.00 | 150.168 |
| de150633-cf79-40ad-b5db-762a7b544aad | 73cca713… | Conquering Transience | 1786193476797 | 417 | 0 | 0 | 107 | 15395.68 | 4.362 |
| ab27d089-e388-46c1-9b88-075e49f3567c | 73cca713… | Introduction by Dr. Tobias Esch | 1786193478798 | 899 | 0 | 0 | 170 | 11345.94 | 3.215 |

`book_id` prefixes: `73cca713…` = `73cca713-7828-4dab-bafb-d415d08045f4`
("Embracing Hope"), `3f97c78a…` = `3f97c78a-33f4-4874-8284-7df82b3e8ffb`
("The Adventures of Tom Sawyer"), `a3adbb72…` = `a3adbb72-42bd-497d-a86b-b412fb81ecea`
("Little Prince"). `dab901e1-aa94-490d-b81e-b54178c392df`'s chapter column
is an empty string in the source row. All other columns (`cfi`,
`created_at`, `ended_at`) are present in the CSV export but omitted here for
width.

## 7. Boundary probe

### 7.1 Idle boundary (dwell_ms within ±10% of 300,000 ms, i.e. 270,000–330,000 ms / 4.5–5.5 min)

prod: 0 rows. dev: 0 rows. (Consistent with §5 — nothing in either db comes
remotely close to the 5-minute floor; the longest dwell recorded anywhere is
114,862 ms ≈ 1.9 minutes, dev.)

### 7.2 Skim boundary (wpm within ±10% of 3× each db's own median)

prod: threshold band 15172.06–18543.62 wpm (10% band around 16857.84). 11 rows:

| id | chapter | dwell_ms | word_count | wpm |
|---|---|---|---|---|
| b2f77a91-d28d-4438-b735-6cd6ed4c7474 | Foreword by Alexander Vesely-Frankl | 717 | 213 | 17824.27 |
| e167421e-8952-4784-a06e-d012e45ce446 | Foreword by Alexander Vesely-Frankl | 714 | 213 | 17899.16 |
| 00418ce7-ccea-4caf-91b6-94ecc9024164 | Foreword by Alexander Vesely-Frankl | 617 | 186 | 18087.52 |
| d30f15ac-3ebb-43c4-9956-95c530718d53 | Introduction by Dr. Tobias Esch | 697 | 208 | 17905.31 |
| 02ba1e32-24fc-4fb1-a42a-43449511d654 | Introduction by Dr. Tobias Esch | 540 | 143 | 15888.89 |
| 7eedec94-9af8-40b0-b10c-354d9cd01e9e | Introduction by Dr. Tobias Esch | 484 | 143 | 17727.27 |
| f2d64b2e-9a45-4148-941b-a49e74c0632c | Introduction by Dr. Tobias Esch | 540 | 143 | 15888.89 |
| 1b53967c-5427-437d-8488-6426cdaf910a | Introduction by Dr. Tobias Esch | 523 | 143 | 16405.35 |
| 9509623e-c4d9-45e1-b137-2c407cfb2927 | Introduction by Dr. Tobias Esch | 526 | 143 | 16311.79 |
| c0ea3118-4fc3-4165-9237-411a7036f32f | Introduction by Dr. Tobias Esch | 703 | 202 | 17240.40 |
| 3240a144-525a-4ec8-a6de-bcd9c15efdb7 | Introduction by Dr. Tobias Esch | 783 | 201 | 15402.30 |

Note: `02ba1e32…`, `f2d64b2e…`, `1b53967c…`, `9509623e…`, `3240a144…` sit
just *under* the 3× threshold (15172–16858 wpm) and are therefore **not**
excluded in §6.1 — they are boundary-adjacent survivors, listed here for the
probe, not part of the excluded-row list above.

dev: threshold band 9529.32–11646.94 wpm (10% band around 10588.13). 13 rows:

| id | book_id | chapter | dwell_ms | word_count | wpm |
|---|---|---|---|---|---|
| f87eadea-e36c-4be9-91bc-d0ef50ece6e4 | 3f97c78a… | 8. | 885 | 150 | 10169.49 |
| d43a04d1-ed98-4950-ab04-c74073f68578 | 3f97c78a… | PREFACE | 987 | 159 | 9665.65 |
| 16303b83-b6fc-442d-9bde-48aa6b72bb55 | 73cca713… | Foreword by Alexander Vesely-Frankl | 527 | 98 | 11157.50 |
| a24156ae-55c0-4007-8116-21cc0bf0ba45 | 73cca713… | Foreword by Alexander Vesely-Frankl | 1090 | 204 | 11229.36 |
| 10b470ba-4a8f-4b91-bb45-acd29636d25a | 73cca713… | Foreword by Alexander Vesely-Frankl | 1071 | 206 | 11540.62 |
| fb81e02d-ce67-4872-90df-9b65c05a6be1 | 3f97c78a… | CONTENTS | 1117 | 200 | 10743.06 |
| a0c72537-1afc-440f-aa24-ec27b62c77a9 | 73cca713… | Introduction by Dr. Tobias Esch | 458 | 80 | 10480.35 |
| 64d7c19a-c0d6-4eaf-9995-fd410887e6c0 | 73cca713… | Note from the Publisher | 1114 | 212 | 11418.31 |
| c1be1934-3f35-4f27-868f-4db8222a1e8c | 73cca713… | Introduction by Dr. Tobias Esch | 441 | 80 | 10884.35 |
| b523ae9a-31e2-40d5-af6c-86df5f8f2f74 | 73cca713… | Introduction by Dr. Tobias Esch | 1299 | 212 | 9792.15 |
| 98a7fb27-8d7d-4c16-a561-e273cfb7228e | 73cca713… | Introduction by Dr. Tobias Esch | 967 | 170 | 10548.09 |
| d21f8ecc-db54-4596-9d45-ec6017f75d5b | 73cca713… | Note from the Publisher | 433 | 80 | 11085.45 |
| ab27d089-e388-46c1-9b88-075e49f3567c | 73cca713… | Introduction by Dr. Tobias Esch | 899 | 170 | 11345.94 |

`f87eadea…`, `d43a04d1…`, `a0c72537…`, `b523ae9a…`, `98a7fb27…` sit just
under the 3× threshold (9529–10588 wpm) and are **not** part of the §6.2
excluded list; the rest (`16303b83…`, `a24156ae…`, `10b470ba…`, `fb81e02d…`,
`64d7c19a…`, `c1be1934…`, `d21f8ecc…`, `ab27d089…`) are already in §6.2 —
they are the lower tail of the excluded set, closest to the line.

## 8. Anomaly probe

Checked conditions: `word_count = 0 OR NULL`, `dwell_ms <= 0`, `dwell_ms >
3,600,000` (1 hour), `wpm` non-finite.

| db | word_count=0/NULL | dwell_ms<=0 | dwell_ms>1hr | wpm non-finite |
|---|---|---|---|---|
| prod | 0 | 0 | 0 | 0 |
| dev | 3 | 0 | 0 | 0 |

`dwell_ms <= 0` and `word_count IS NULL` are also independently confirmed
against the live SQLite copies (not just the CSV) via direct `COUNT(*)`
queries — both 0 in both dbs, consistent with the `CHECK(dwell_ms >= 0)` and
`NOT NULL DEFAULT 0` constraints in the schema, which make a negative
`dwell_ms` or NULL `word_count` impossible to write in the first place.
Max `dwell_ms` observed: 45,358 (prod), 114,862 (dev) — neither exceeds 1
hour.

The 3 dev anomalies, in full:

| id | book_id | chapter | cfi | started_at | ended_at | dwell_ms | dwell_min | operation_count | lookup_count | word_count | wpm | idle rule | skim rule |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 3f4faad3-a9de-4e26-8d0a-d8216c51ebc0 | 3f97c78a… | THE ADVENTURES OF TOM SAWYER | epubcfi(/6/2!/4/22,/2,/6) | 1786187193433 | 1786187199561 | 6128 | 0.1021 | 0 | 0 | 0 | 0.0 | not excluded (dwell_ms 6128 < 300000) | not excluded (`word_count <= 0` short-circuits `is_screen_too_fast` at line 406, returns `false` before computing wpm) |
| b93756da-1951-41a8-b576-157f4181a397 | a3adbb72… | (empty) | epubcfi(/6/2!/4,/2[fhox7y4sgwy],/4[fhox7y4sgwz]/2) | 1786192751914 | 1786192752903 | 989 | 0.0165 | 0 | 0 | 0 | 0.0 | not excluded | not excluded (same short-circuit) |
| d6b4a9dc-ac57-4c0f-ae3d-a985615d3def | a3adbb72… | The Little Prince | epubcfi(/6/6!/4,/34[fhox7y4sg01],/36[fhox7y4sg02]) | 1786192802033 | 1786192802888 | 855 | 0.0143 | 0 | 0 | 0 | 0.0 | not excluded | not excluded |

All three are `word_count = 0` rows (a screen with no measurable text —
e.g. a title/cover page or an empty scroll position). Per the source at
`mastery/mod.rs:406-408`, a `word_count <= 0` (or `dwell_ms <= 0`) screen
returns `false` from `is_screen_too_fast` immediately, before `wpm` is ever
computed — so it is **kept**, not excluded, by the skim rule; no
division-by-zero or crash occurs because the guard runs first. It is also
not idle-excluded since none of the three reach the 5-minute floor. No row
in either database triggers a crash or an unhandled case in either rule as
transcribed.

The two most extreme wpm values in the raw data — `01d3a61e-2a1e-42bf-b558-5f2fbb4cfa37`
(dwell_ms=13, word_count=53, wpm=244615.38) and `58941cc1-ea23-4625-b7fb-c92eef724061`
(dwell_ms=6, word_count=53, wpm=530000.00), both in dev — are **not**
anomalies under the checked conditions (word_count and dwell_ms are both
positive, dwell is far under 1 hour, wpm is finite) even though the pace is
implausible for human reading; they are correctly picked up by the skim
rule (§6.2, both listed, at 69.3× and 150.2× the median respectively) since
`wpm` is finite and the guard conditions do not treat "implausibly fast" as
its own anomaly class — only non-finite/negative/zero values are.

# Item 5 — Does frequency-band difficulty discriminate real texts? (raw evidence)

Empirical test only. No verdicts below — raw numbers for someone else to judge.

## STEP 1 — the real code

### Word-frequency table

File: `src-tauri/src/word_frequency/mod.rs`

- Table source: `include_str!("english-fiction.tsv")` (`src-tauri/src/word_frequency/mod.rs:127`) — Google Books Ngram Corpus v3, English Fiction subcorpus, 1-grams, books published 2010–2019, CC BY 3.0 (module doc, `mod.rs:60-79`).
- Size: 50,000 commonest fiction words in the source file, collapsing to **49,999** distinct normalized entries (one pair — "OK"/"ok" — collapses to one key). Verified by the existing test:
  ```
  src/word_frequency/tests.rs:189-211
  fn the_table_parses_into_fifty_thousand_words_across_every_band() {
      let parsed = table();
      assert_eq!(parsed.len(), 49_999, ...);
  ```
- Tokenisation/normalisation before lookup: `normalize_learning_term` (`src-tauri/src/sync/events.rs:113-117`):
  ```rust
  pub fn normalize_learning_term(value: &str) -> String {
      value
          .trim_matches(|character: char| !character.is_alphanumeric() && character != '\'')
          .to_lowercase()
  }
  ```
  Applied both when the table is parsed (`mod.rs:198`) and when a query word is looked up (`mod.rs:259`) — case-insensitive, punctuation-trimmed, apostrophes kept.
- Band boundaries (`src-tauri/src/word_frequency/mod.rs:129-146`):
  ```rust
  const BAND_1_MAX_RANK: u32 = 1_000;
  const BAND_2_MAX_RANK: u32 = 3_000;
  const BAND_3_MAX_RANK: u32 = 5_000;
  const BAND_4_MAX_RANK: u32 = 20_000;

  fn band_for_rank(rank: u32) -> u8 {
      if rank <= BAND_1_MAX_RANK { 1 }
      else if rank <= BAND_2_MAX_RANK { 2 }
      else if rank <= BAND_3_MAX_RANK { 3 }
      else if rank <= BAND_4_MAX_RANK { 4 }
      else { 5 }
  }
  ```
  Band meanings per the module doc (`mod.rs:30-41`): band 1 = rank 1–1,000 (near-closed set of function words + highest-frequency content words); band 2 = rank 1,001–3,000 (common everyday vocabulary); band 3 = rank 3,001–5,000 (starts requiring genuine vocabulary study); band 4 = rank 5,001–20,000 (specialized/literary vocabulary); band 5 = rank 20,001+ (rare enough to be a strong signal regardless of reader level).
- A word not in the table: `lookup`/`lookup_with` (`mod.rs:250-272`) first try the exact normalized spelling against the table, then fall back to sibling spellings recorded in the `word_forms` table (migration 027, lemmatization fallback — `mod.rs:94-108`, `274-345`). If neither the word nor any linked form is in the table, the function returns `Ok(None)` — "genuine unknown", **never coerced into band 5** (`mod.rs:239-249`). Production code (`book_difficulty.rs`) puts these into a separate `unlisted`/`band_unlisted` bucket, distinct from band 5.

### Banding function (book-level aggregation)

File: `src-tauri/src/commands/book_difficulty.rs`

- Tokenizer used to turn a book's text into countable words (`book_difficulty.rs:170-192`):
  ```rust
  pub(crate) fn tokenize(text: &str) -> Vec<String> {
      let mut tokens = Vec::new();
      let mut current = String::new();
      for character in text.chars() {
          if character.is_alphanumeric() {
              current.extend(character.to_lowercase());
          } else if character == '\'' || character == '\u{2019}' {
              current.push('\'');
          } else {
              flush_token(&mut tokens, &mut current);
          }
      }
      flush_token(&mut tokens, &mut current);
      tokens
  }

  fn flush_token(tokens: &mut Vec<String>, current: &mut String) {
      let token = current.trim_matches('\'');
      if token.chars().count() > 1 && !token.chars().all(char::is_numeric) {
          tokens.push(token.to_string());
      }
      current.clear();
  }
  ```
  Unicode letter/digit runs, lowercased, word-internal apostrophes (both `'` and the typographic `’`) kept so `don't` stays one token; single characters and bare numbers are dropped.
- Counting (`book_difficulty.rs:198-206`) is by occurrence, deduped by form (`count_words`), then folded onto bands by `accumulate`/`accumulate_with` (`book_difficulty.rs:213-237`), which calls `word_frequency::lookup_with` per distinct word and adds that word's occurrence count into the matching band, or into `unlisted` on a miss.
- The real end-to-end caller, `compute_and_store` (`book_difficulty.rs:439-487`), does exactly: extract book text → `count_words(...)` → `accumulate(db, &counts)` → store `BandTally` — i.e. the two functions above **are** the production banding pipeline once book text is available as plain text blocks. EPUB/PDF extraction (`ai::grounding::source`) sits only upstream of this and does not affect banding.

## Layer driven

Drove the **real production entry points directly**: `tokenize`, `count_words`, and `word_frequency::lookup_with` (via a `FormIndex` built the same way `accumulate_with` builds one) — the exact code `compute_and_store` calls once it has book text. No reimplementation of tokenisation or banding logic.

One layer was skipped deliberately: EPUB/PDF **extraction** (`ai::grounding::source::extract_source_text`), because the test inputs are already plain `.txt` files — extraction only produces plain text blocks that get fed into `count_words`, so skipping it does not touch the banding logic under test.

One data dependency was substituted: `word_frequency::lookup_with`'s lemmatization fallback reads the app's `word_forms` table (populated opportunistically from AI-assisted lookups the user has actually made). The test used a **freshly initialized, empty** SQLite db (via the same `test_db()` helper the module's own unit tests use — `TempDir` + `Db::init`), so `word_forms` was empty and the fallback path, while genuinely exercised (same code, same query), never had a row to match against. This means: every word classified into bands 1–5 below was matched by **exact-spelling table lookup only**; a small number of inflected forms that a populated `word_forms` table (from real usage) might have resolved instead land in `unlisted` here. This does not change the frequency table or the banding thresholds — only how many "unlisted" words a live install with accumulated lemma data might additionally resolve.

## STEP 2 — texts

| # | Title | Source | Word count (tokens, production tokenizer) |
|---|-------|--------|---|
| 1 | The Little Prince (Saint-Exupéry, EN translation) | Local dev db `lantern-dev/lantern.db`, `books.id = a3adbb72-42bd-497d-a86b-b412fb81ecea`, reconstructed from `book_chunks` (96 chunks) | 17,688 |
| 2 | The Adventures of Tom Sawyer (Twain) | Local dev db `lantern-dev/lantern.db`, `books.id = 3f97c78a-33f4-4874-8284-7df82b3e8ffb`, reconstructed from `book_chunks` (350 chunks) | 72,002 |
| 3 | Pride and Prejudice (Austen) | Local main db `lantern/lantern.db`, `books.id = 06503125-8d05-4ef2-a74c-208f8051b3bf`, reconstructed from `book_chunks` (598 chunks) | 118,092 |
| 4 | Moby-Dick (Melville) | Project Gutenberg, `https://www.gutenberg.org/cache/epub/2701/pg2701.txt` (boilerplate stripped between the `*** START OF ***` / `*** END OF ***` markers) | 209,758 |
| 5 | On the Origin of Species (Darwin) | Project Gutenberg, `https://www.gutenberg.org/cache/epub/1228/pg1228.txt` (boilerplate stripped) | 152,084 |
| 6 | Alice's Adventures in Wonderland (Carroll) | Project Gutenberg, `https://www.gutenberg.org/cache/epub/11/pg11.txt` (boilerplate stripped) | 25,706 |

Databases were opened read-only (`sqlite3 "file:<path>?mode=ro"`); `book_chunks.text` was concatenated in `chunk_index` order per book.

Lengths span roughly 4x (17.7k to 209.8k tokens), so results are reported both on the **full text** and on a **normalised first-50,000-token sample** (using the same production `tokenize`) for every text long enough to have one. The Little Prince (17,688 tokens) and Alice (25,706 tokens) are both shorter than 50,000 tokens, so only their full-text numbers exist — noted explicitly in the raw output below.

## Exact commands run

```bash
export PATH="$HOME/.cargo/bin:$PATH"

# Local book text extraction (read-only)
sqlite3 "file:$HOME/Library/Application Support/com.klaragraff.lantern-dev/lantern.db?mode=ro" \
  "SELECT text FROM book_chunks WHERE book_id='a3adbb72-42bd-497d-a86b-b412fb81ecea' ORDER BY chunk_index;" \
  > .../scratchpad/texts/little_prince.txt
sqlite3 "file:$HOME/Library/Application Support/com.klaragraff.lantern-dev/lantern.db?mode=ro" \
  "SELECT text FROM book_chunks WHERE book_id='3f97c78a-33f4-4874-8284-7df82b3e8ffb' ORDER BY chunk_index;" \
  > .../scratchpad/texts/tom_sawyer.txt
sqlite3 "file:$HOME/Library/Application Support/com.klaragraff.lantern/lantern.db?mode=ro" \
  "SELECT text FROM book_chunks WHERE book_id='06503125-8d05-4ef2-a74c-208f8051b3bf' ORDER BY chunk_index;" \
  > .../scratchpad/texts/pride_and_prejudice.txt

# Gutenberg texts
curl -s -L "https://www.gutenberg.org/cache/epub/2701/pg2701.txt" -o .../scratchpad/texts/moby_dick_raw.txt
curl -s -L "https://www.gutenberg.org/cache/epub/1228/pg1228.txt" -o .../scratchpad/texts/origin_of_species_raw.txt
curl -s -L "https://www.gutenberg.org/cache/epub/11/pg11.txt"     -o .../scratchpad/texts/alice_raw.txt
# then sed between the "*** START OF" / "*** END OF" line numbers found via grep -n, into
# moby_dick.txt / origin_of_species.txt / alice.txt

cd ~/vibecoding/Lantern/src-tauri
cargo test --lib commands::book_difficulty::tests::evidence_item5_band_analysis -- --nocapture
```

## Temporary test file (full source)

Appended temporarily inside the existing `#[cfg(test)] mod tests { ... }` block of
`src-tauri/src/commands/book_difficulty.rs` (which already has `use super::*;` bringing in
`tokenize`, `count_words`, `word_frequency::{lookup_with, FormIndex}`, `HashMap`, and the
module's own `test_db()` helper). Deleted after the run — see confirmation at the end of this
file.

```rust
    // TEMPORARY — empirical evidence gathering for docs/impls/automation-review
    // item 5 (does frequency-band difficulty discriminate real texts). Reads
    // plain-text files from disk and drives the real production tokenize /
    // count_words / lookup_with pipeline. Delete before committing.
    #[test]
    fn evidence_item5_band_analysis() {
        use std::fs;

        struct TextSpec {
            name: &'static str,
            path: &'static str,
        }

        let base = "/private/tmp/claude-501/-Users-lijianwei-vibecoding-Lantern/b8f809b9-1dd3-4524-ac33-1fb2f65183cc/scratchpad/texts";
        let specs = [
            TextSpec {
                name: "1. The Little Prince (Saint-Exupery, EN translation)",
                path: "little_prince.txt",
            },
            TextSpec {
                name: "2. The Adventures of Tom Sawyer (Twain)",
                path: "tom_sawyer.txt",
            },
            TextSpec {
                name: "3. Pride and Prejudice (Austen)",
                path: "pride_and_prejudice.txt",
            },
            TextSpec {
                name: "4. Moby-Dick (Melville)",
                path: "moby_dick.txt",
            },
            TextSpec {
                name: "5. On the Origin of Species (Darwin)",
                path: "origin_of_species.txt",
            },
            TextSpec {
                name: "6. Alice's Adventures in Wonderland (Carroll)",
                path: "alice.txt",
            },
        ];

        let (_dir, db) = test_db();
        let forms = FormIndex::new(&db);

        fn analyze(label: &str, tokens: &[String], forms: &FormIndex) {
            let mut counts: HashMap<String, i64> = HashMap::new();
            for t in tokens {
                *counts.entry(t.clone()).or_insert(0) += 1;
            }
            let total_tokens: i64 = tokens.len() as i64;
            let distinct_words = counts.len();

            let mut distinct_band = [0i64; 5];
            let mut distinct_unlisted = 0i64;
            let mut token_band = [0i64; 5];
            let mut token_unlisted = 0i64;
            let mut examples_band: [Vec<(String, i64)>; 5] =
                [Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new()];
            let mut examples_unlisted: Vec<(String, i64)> = Vec::new();

            let mut words: Vec<&String> = counts.keys().collect();
            words.sort();
            for word in words {
                let count = counts[word];
                match lookup_with(forms, word).unwrap() {
                    Some(entry) => {
                        let idx = (entry.band.clamp(1, 5) - 1) as usize;
                        distinct_band[idx] += 1;
                        token_band[idx] += count;
                        examples_band[idx].push((word.clone(), count));
                    }
                    None => {
                        distinct_unlisted += 1;
                        token_unlisted += count;
                        examples_unlisted.push((word.clone(), count));
                    }
                }
            }

            for v in examples_band.iter_mut() {
                v.sort_by(|a, b| b.1.cmp(&a.1));
            }
            examples_unlisted.sort_by(|a, b| b.1.cmp(&a.1));

            println!("\n=== {label} ===");
            println!("total_tokens={total_tokens} distinct_words={distinct_words}");
            println!(
                "{:<10} {:>10} {:>8} {:>12} {:>8}",
                "band", "distinct", "dist%", "tokens", "tok%"
            );
            for b in 0..5 {
                println!(
                    "{:<10} {:>10} {:>7.2}% {:>12} {:>7.2}%",
                    format!("band{}", b + 1),
                    distinct_band[b],
                    100.0 * distinct_band[b] as f64 / distinct_words as f64,
                    token_band[b],
                    100.0 * token_band[b] as f64 / total_tokens as f64
                );
            }
            println!(
                "{:<10} {:>10} {:>7.2}% {:>12} {:>7.2}%",
                "unlisted",
                distinct_unlisted,
                100.0 * distinct_unlisted as f64 / distinct_words as f64,
                token_unlisted,
                100.0 * token_unlisted as f64 / total_tokens as f64
            );

            let hard_share =
                (distinct_band[3] + distinct_band[4] + distinct_unlisted) as f64 / distinct_words as f64;
            println!(
                "hard_word_share (band4+band5+unlisted / distinct) = {:.4} ({:.2}%)",
                hard_share,
                hard_share * 100.0
            );

            let mut cum = 0i64;
            for k in 0..5 {
                cum += token_band[k];
                println!(
                    "cumulative_token_coverage_through_band{} = {:.2}%",
                    k + 1,
                    100.0 * cum as f64 / total_tokens as f64
                );
            }
            println!(
                "cumulative_token_coverage_through_band5_plus_unlisted = {:.2}%",
                100.0 * (cum + token_unlisted) as f64 / total_tokens as f64
            );

            for b in 0..5 {
                let sample: Vec<String> = examples_band[b]
                    .iter()
                    .take(20)
                    .map(|(w, c)| format!("{w}({c})"))
                    .collect();
                println!("band{}_examples: {}", b + 1, sample.join(", "));
            }
            let unlisted_sample: Vec<String> = examples_unlisted
                .iter()
                .take(20)
                .map(|(w, c)| format!("{w}({c})"))
                .collect();
            println!("unlisted_examples: {}", unlisted_sample.join(", "));
        }

        for spec in &specs {
            let full_path = format!("{base}/{}", spec.path);
            let text =
                fs::read_to_string(&full_path).unwrap_or_else(|e| panic!("read {full_path}: {e}"));
            let tokens = tokenize(&text);
            analyze(&format!("{} — FULL TEXT", spec.name), &tokens, &forms);

            if tokens.len() > 50_000 {
                let sample = &tokens[..50_000];
                analyze(
                    &format!("{} — FIRST 50,000 TOKENS", spec.name),
                    sample,
                    &forms,
                );
            } else {
                println!(
                    "\n=== {} — FIRST 50,000 TOKENS === SKIPPED: only {} tokens total",
                    spec.name,
                    tokens.len()
                );
            }
        }
    }
```

## Complete unedited raw stdout

```
   Compiling lantern v2.13.1 (~/vibecoding/Lantern/src-tauri)
    Finished `test` profile [unoptimized + debuginfo] target(s) in 12.72s
     Running unittests src/lib.rs (target/debug/deps/lantern_lib-4e6aedd3f66cd1d0)

running 1 test

=== 1. The Little Prince (Saint-Exupery, EN translation) — FULL TEXT ===
total_tokens=17688 distinct_words=2553
band         distinct    dist%       tokens     tok%
band1             754   29.53%        13797   78.00%
band2             634   24.83%         1773   10.02%
band3             311   12.18%          621    3.51%
band4             558   21.86%          892    5.04%
band5             148    5.80%          273    1.54%
unlisted          148    5.80%          332    1.88%
hard_word_share (band4+band5+unlisted / distinct) = 0.3345 (33.45%)
cumulative_token_coverage_through_band1 = 78.00%
cumulative_token_coverage_through_band2 = 88.03%
cumulative_token_coverage_through_band3 = 91.54%
cumulative_token_coverage_through_band4 = 96.58%
cumulative_token_coverage_through_band5 = 98.12%
cumulative_token_coverage_through_band5_plus_unlisted = 100.00%
band1_examples: the(1120), to(505), and(406), of(389), that(328), he(320), you(309), is(306), little(291), it(268), in(225), was(211), said(196), my(164), not(162), his(160), me(153), but(151), for(145), one(144)
band2_examples: prince(212), planet(73), flower(55), stars(42), saint(28), drawing(24), grown(24), desert(20), snake(16), lamp(15), flowers(14), orders(13), matters(12), star(12), draw(11), french(11), sand(11), demanded(10), france(10), million(9)
band3_examples: sheep(40), fox(36), consequence(16), sunset(11), roses(10), magnificent(8), millions(8), lighted(7), literary(6), unique(6), visits(6), admire(5), bushes(5), merchant(5), absurd(4), africa(4), bells(4), bolt(4), departure(4), disturbed(4)
band4_examples: ups(21), conceited(13), thorns(13), businessman(12), don't(11), explorer(10), narrator(10), asteroid(9), tame(9), extinct(8), hum(8), inhabited(8), tamed(8), globe(7), chickens(5), illustrated(5), muzzle(5), seeds(5), thirst(5), thirsty(5)
band5_examples: geographer(23), boa(13), lamplighter(13), volcanoes(12), constrictor(8), cannot(7), pulley(7), aviator(5), ephemeral(5), sunsets(5), astronomer(4), baobab(4), doesn't(4), acclaim(3), caterpillars(3), ermine(3), haven't(3), hommes(3), thunderstruck(3), arras(2)
unlisted_examples: chapter(54), exupéry(23), de(19), baobabs(17), prince's(9), tippler(9), switchman(8), antoine(6), lamplighters(6), constrictors(5), le(5), des(4), exupéry's(4), prix(4), sahara(4), françois(3), jean(3), casablanca(2), com(2), courrier(2)

=== 1. The Little Prince (Saint-Exupery, EN translation) — FIRST 50,000 TOKENS === SKIPPED: only 17688 tokens total

=== 2. The Adventures of Tom Sawyer (Twain) — FULL TEXT ===
total_tokens=72002 distinct_words=7467
band         distinct    dist%       tokens     tok%
band1             951   12.74%        51760   71.89%
band2            1411   18.90%         6157    8.55%
band3             992   13.29%         2791    3.88%
band4            2640   35.36%         5562    7.72%
band5             877   11.75%         2074    2.88%
unlisted          596    7.98%         3658    5.08%
hard_word_share (band4+band5+unlisted / distinct) = 0.5508 (55.08%)
cumulative_token_coverage_through_band1 = 71.89%
cumulative_token_coverage_through_band2 = 80.44%
cumulative_token_coverage_through_band3 = 84.31%
cumulative_token_coverage_through_band4 = 92.04%
cumulative_token_coverage_through_band5 = 94.92%
cumulative_token_coverage_through_band5_plus_unlisted = 100.00%
band1_examples: the(3968), and(3171), to(1772), of(1539), he(1199), was(1172), it(1155), in(994), that(914), his(826), you(777), with(654), but(594), they(564), for(547), had(514), him(434), as(410), she(389), at(388)
band2_examples: presently(82), village(54), cave(53), anybody(50), awful(44), judge(30), sunday(29), treasure(29), camp(27), hill(27), knife(27), bet(26), mighty(26), cat(23), fence(23), smoke(22), grave(21), midnight(21), breakfast(19), everybody(19)
band3_examples: reckon(73), widow(39), candle(25), adventures(22), ghosts(21), conscience(19), finn(18), revenge(18), solemn(16), melancholy(14), stir(14), alley(13), sprang(13), bury(12), daylight(12), ceased(11), dig(11), fetch(11), gratitude(11), haunted(11)
band4_examples: don't(223), it's(160), potter(53), can't(50), didn't(50), you're(33), they're(31), pirates(26), couldn't(22), bout(18), auntie(17), index(17), tavern(17), pirate(16), warn't(16), awhile(15), he'd(15), tick(15), we're(15), dismal(14)
band5_examples: ain't(123), that's(113), won't(58), wouldn't(48), what's(41), we'll(39), he's(34), muff(34), you'll(33), huckleberry(28), you'd(27), you've(18), hadn't(17), let's(15), they'll(11), they'd(10), we've(10), compositions(9), man's(9), shucks(9)
unlisted_examples: tom(774), huck(248), chapter(193), joe(147), tom's(115), becky(108), i'll(102), injun(87), sid(78), polly(53), em(46), i'm(45), sawyer(44), i'd(43), i've(43), thatcher(42), mary(39), joe's(35), harper(34), there's(32)

=== 2. The Adventures of Tom Sawyer (Twain) — FIRST 50,000 TOKENS ===
total_tokens=50000 distinct_words=6354
band         distinct    dist%       tokens     tok%
band1             927   14.59%        35680   71.36%
band2            1270   19.99%         4309    8.62%
band3             842   13.25%         1987    3.97%
band4            2152   33.87%         4111    8.22%
band5             697   10.97%         1484    2.97%
unlisted          466    7.33%         2429    4.86%
hard_word_share (band4+band5+unlisted / distinct) = 0.5217 (52.17%)
cumulative_token_coverage_through_band1 = 71.36%
cumulative_token_coverage_through_band2 = 79.98%
cumulative_token_coverage_through_band3 = 83.95%
cumulative_token_coverage_through_band4 = 92.17%
cumulative_token_coverage_through_band5 = 95.14%
cumulative_token_coverage_through_band5_plus_unlisted = 100.00%
band1_examples: the(2767), and(2267), to(1216), of(1094), he(885), was(824), it(756), in(687), his(651), that(601), you(521), with(499), but(406), for(388), they(356), had(347), him(342), she(312), as(290), on(282)
band2_examples: presently(58), village(40), anybody(35), camp(26), awful(23), fence(23), cat(22), sunday(22), grave(20), knife(20), midnight(17), spirit(16), island(14), joy(14), minister(14), occurred(14), terror(14), bet(13), breakfast(13), faces(13)
band3_examples: reckon(35), conscience(19), adventures(17), finn(15), solemn(15), ghosts(11), melancholy(11), blessed(10), punishment(10), sprang(10), bark(9), ceased(9), charm(9), prize(9), stir(9), bible(8), cautiously(8), examination(8), gratitude(8), log(8)
band4_examples: don't(138), it's(89), potter(53), didn't(29), can't(27), pirates(26), you're(24), they're(16), auntie(14), tick(14), dismal(13), pirate(13), bout(12), couldn't(12), index(12), sermon(12), hearted(11), raft(11), superintendent(11), tickets(11)
band5_examples: ain't(73), that's(68), won't(38), muff(34), he's(30), wouldn't(29), huckleberry(26), what's(20), you'd(18), you'll(18), you've(13), hadn't(11), compositions(9), whitewash(8), vii(7), viii(7), xii(7), xiii(7), xvii(7), xviii(7)
unlisted_examples: tom(547), chapter(167), joe(114), tom's(96), huck(92), sid(70), i'll(57), becky(50), injun(43), polly(43), mary(36), sawyer(35), i'm(29), em(28), harper(28), i'd(27), thatcher(26), i've(24), jim(19), ben(17)

=== 3. Pride and Prejudice (Austen) — FULL TEXT ===
total_tokens=118092 distinct_words=6339
band         distinct    dist%       tokens     tok%
band1             884   13.95%        90138   76.33%
band2            1153   18.19%         9810    8.31%
band3             746   11.77%         3896    3.30%
band4            2317   36.55%         7010    5.94%
band5             907   14.31%         1569    1.33%
unlisted          332    5.24%         5669    4.80%
hard_word_share (band4+band5+unlisted / distinct) = 0.5610 (56.10%)
cumulative_token_coverage_through_band1 = 76.33%
cumulative_token_coverage_through_band2 = 84.64%
cumulative_token_coverage_through_band3 = 87.93%
cumulative_token_coverage_through_band4 = 93.87%
cumulative_token_coverage_through_band5 = 95.20%
cumulative_token_coverage_through_band5_plus_unlisted = 100.00%
band1_examples: the(4331), to(4163), of(3610), and(3584), her(2225), in(1879), was(1847), she(1710), that(1579), it(1535), not(1429), you(1357), he(1336), his(1272), be(1241), as(1180), had(1177), for(1060), with(1052), but(1002)
band2_examples: manner(99), feelings(86), subject(84), sisters(76), ill(75), therefore(75), ladies(74), happiness(72), opinion(68), colonel(65), character(64), received(61), affection(58), regard(49), object(48), perfectly(47), pride(47), ought(45), scarcely(45), carriage(44)
band3_examples: kitty(69), behaviour(53), acquaintance(52), daughters(51), manners(44), assure(39), consequence(32), sensible(32), resolved(31), astonishment(30), countenance(30), kindness(29), obliged(29), compliment(26), expressed(26), admiration(25), attended(24), express(24), gratitude(24), relations(24)
band4_examples: agreeable(45), civility(42), amiable(36), ladyship(30), neighbourhood(29), attachment(27), attentions(26), exceedingly(26), wholly(26), disposition(25), humour(25), persuaded(25), acquainted(24), depend(23), dislike(23), inquiries(23), prevented(23), inclination(22), pleasing(22), endeavour(21)
band5_examples: cannot(112), father's(19), etc(13), partiality(13), shire(12), imprudent(11), elopement(9), imprudence(9), commendation(8), gentlemanlike(8), lady's(8), civilities(7), disapprobation(7), endeavours(7), humoured(7), patroness(7), raptures(7), abhorrence(6), forbearance(6), mortifying(6)
unlisted_examples: mr(786), elizabeth(597), darcy(374), mrs(343), bennet(294), jane(263), bingley(257), wickham(162), collins(156), lydia(133), catherine(110), lizzy(95), longbourn(88), gardiner(84), netherfield(73), charlotte(68), lucas(65), chapter(61), meryton(57), london(55)

=== 3. Pride and Prejudice (Austen) — FIRST 50,000 TOKENS ===
total_tokens=50000 distinct_words=4412
band         distinct    dist%       tokens     tok%
band1             825   18.70%        37608   75.22%
band2             918   20.81%         4354    8.71%
band3             548   12.42%         1657    3.31%
band4            1458   33.05%         2955    5.91%
band5             476   10.79%          682    1.36%
unlisted          187    4.24%         2744    5.49%
hard_word_share (band4+band5+unlisted / distinct) = 0.4807 (48.07%)
cumulative_token_coverage_through_band1 = 75.22%
cumulative_token_coverage_through_band2 = 83.92%
cumulative_token_coverage_through_band3 = 87.24%
cumulative_token_coverage_through_band4 = 93.15%
cumulative_token_coverage_through_band5 = 94.51%
cumulative_token_coverage_through_band5_plus_unlisted = 100.00%
band1_examples: the(1871), to(1762), and(1557), of(1535), her(908), in(800), was(703), that(661), she(648), not(646), it(637), you(590), he(562), his(533), be(510), with(493), as(477), for(445), is(428), had(422)
band2_examples: ladies(55), sisters(48), manner(46), subject(45), therefore(42), ill(35), happiness(34), opinion(33), feelings(31), ball(29), dance(29), affection(26), convinced(26), fortune(26), pride(26), character(25), consider(24), everybody(24), invitation(24), regard(24)
band3_examples: daughters(35), assure(25), manners(20), sensible(20), compliment(19), acquaintance(18), behaviour(17), consequence(16), countenance(16), kitty(14), obliged(14), addressed(13), admiration(13), favour(13), kindness(13), elegant(12), persuade(12), praise(12), superior(12), admire(11)
band4_examples: agreeable(33), amiable(22), civility(16), attentions(15), neighbourhood(15), eldest(13), depend(11), dine(11), exceedingly(11), humour(11), pleasing(11), delicacy(10), disposition(10), felicity(10), inclination(10), inquiries(10), ladyship(10), acquainted(9), dances(9), endeavour(9)
band5_examples: cannot(52), father's(9), patroness(7), civilities(5), raptures(5), affability(4), commendation(4), fancying(4), gentlemanlike(4), humoured(4), partiality(4), shire(4), whist(4), apologising(3), complaisance(3), composedly(3), deficient(3), disapprobation(3), easiness(3), etc(3)
unlisted_examples: mr(458), elizabeth(259), bingley(167), bennet(165), darcy(165), mrs(157), jane(124), collins(110), wickham(58), lucas(56), catherine(55), charlotte(54), netherfield(45), longbourn(41), lizzy(38), lydia(34), bingley's(31), meryton(31), william(30), chapter(29)

=== 4. Moby-Dick (Melville) — FULL TEXT ===
total_tokens=209758 distinct_words=17359
band         distinct    dist%       tokens     tok%
band1             971    5.59%       141689   67.55%
band2            1760   10.14%        19810    9.44%
band3            1483    8.54%         8826    4.21%
band4            6289   36.23%        22996   10.96%
band5            3645   21.00%         7918    3.77%
unlisted         3211   18.50%         8519    4.06%
hard_word_share (band4+band5+unlisted / distinct) = 0.7572 (75.72%)
cumulative_token_coverage_through_band1 = 67.55%
cumulative_token_coverage_through_band2 = 76.99%
cumulative_token_coverage_through_band3 = 81.20%
cumulative_token_coverage_through_band4 = 92.16%
cumulative_token_coverage_through_band5 = 95.94%
cumulative_token_coverage_through_band5_plus_unlisted = 100.00%
band1_examples: the(14535), of(6624), and(6447), to(4627), in(4184), that(2990), his(2532), it(2420), but(1818), he(1778), as(1742), is(1723), with(1723), was(1645), for(1618), all(1526), this(1396), at(1320), by(1205), not(1150)
band2_examples: ye(431), thou(269), deck(199), fish(167), aye(155), crew(138), thus(133), thee(131), thy(113), leg(91), oil(90), iron(88), ships(88), cabin(87), heads(87), dick(83), tail(82), length(78), ocean(76), instant(75)
band3_examples: boats(147), sail(102), sailor(79), peculiar(56), coffin(52), craft(52), savage(52), vessel(48), lance(45), queer(44), cape(40), concerning(40), mortal(40), plainly(39), darted(38), sailed(38), aspect(37), hence(32), jet(32), species(31)
band4_examples: whale(1110), whales(272), sperm(244), mast(129), don't(119), voyage(103), flask(101), it's(100), leviathan(92), seas(87), ere(79), pip(67), aloft(63), spout(61), ivory(56), sailors(52), sharks(51), bows(49), carpenter(44), nigh(44)
band5_examples: whaling(133), he's(98), that's(94), harpooneer(77), harpoon(76), cannot(69), whalemen(69), fishery(65), what's(53), man's(51), forecastle(39), bulwarks(38), flukes(37), blubber(34), harpoons(32), won't(32), leeward(29), mariners(29), shipmates(28), scuttle(24)
unlisted_examples: ahab(440), chapter(308), stubb(236), queequeg(226), starbuck(179), pequod(129), whale's(129), nantucket(97), moby(85), ship's(80), ahab's(77), bildad(74), jonah(73), peleg(70), i'll(65), there's(64), mr(63), harpooneers(56), tashtego(54), pequod's(49)

=== 4. Moby-Dick (Melville) — FIRST 50,000 TOKENS ===
total_tokens=50000 distinct_words=7936
band         distinct    dist%       tokens     tok%
band1             914   11.52%        34568   69.14%
band2            1307   16.47%         4514    9.03%
band3             895   11.28%         1964    3.93%
band4            2714   34.20%         4936    9.87%
band5            1125   14.18%         1797    3.59%
unlisted          981   12.36%         2221    4.44%
hard_word_share (band4+band5+unlisted / distinct) = 0.6074 (60.74%)
cumulative_token_coverage_through_band1 = 69.14%
cumulative_token_coverage_through_band2 = 78.16%
cumulative_token_coverage_through_band3 = 82.09%
cumulative_token_coverage_through_band4 = 91.96%
cumulative_token_coverage_through_band5 = 95.56%
cumulative_token_coverage_through_band5_plus_unlisted = 100.00%
band1_examples: the(3025), and(1660), of(1505), to(1190), in(969), that(691), his(655), he(547), it(521), was(492), but(446), with(420), for(388), all(380), as(375), at(344), is(326), him(306), this(303), not(283)
band2_examples: ye(124), thou(64), deck(34), board(31), cabin(30), pipe(25), leg(23), island(22), ocean(22), thee(21), thy(21), aye(20), fish(20), ships(20), mate(18), oil(18), chief(17), fellow(17), hat(17), mighty(17)
band3_examples: sail(26), savage(19), cape(17), craft(17), queer(17), sailor(16), vessel(14), sailed(13), aboard(12), boats(12), merchant(12), smoking(11), chapel(10), dignity(10), horn(10), native(10), plainly(10), coffin(9), concerning(9), heavens(9)
band4_examples: whale(146), voyage(44), whales(44), don't(42), it's(40), landlord(31), sailors(19), seas(19), mast(18), leviathan(17), ere(15), sperm(15), pulpit(14), ashore(13), woe(13), bows(12), can't(12), didn't(12), flask(12), ivory(12)
band5_examples: whaling(66), harpooneer(42), he's(37), shipmates(26), harpoon(25), that's(24), tomahawk(19), whalemen(19), what's(19), fishery(15), cannot(14), bulwarks(12), cannibal(12), ain't(11), chowder(10), won't(9), cannibals(7), counterpane(7), forecastle(7), mariners(7)
unlisted_examples: chapter(171), queequeg(145), bildad(74), peleg(70), ahab(62), jonah(54), nantucket(45), pequod(42), stubb(30), i'll(20), starbuck(18), ship's(17), bedford(16), hussey(16), queequeg's(15), whale's(15), mr(14), em(13), mrs(13), harpooneers(12)

=== 5. On the Origin of Species (Darwin) — FULL TEXT ===
total_tokens=152084 distinct_words=6925
band         distinct    dist%       tokens     tok%
band1             782   11.29%        99088   65.15%
band2            1017   14.69%        16284   10.71%
band3             711   10.27%         9845    6.47%
band4            2302   33.24%        17768   11.68%
band5            1116   16.12%         5863    3.86%
unlisted          997   14.40%         3236    2.13%
hard_word_share (band4+band5+unlisted / distinct) = 0.6375 (63.75%)
cumulative_token_coverage_through_band1 = 65.15%
cumulative_token_coverage_through_band2 = 75.86%
cumulative_token_coverage_through_band3 = 82.33%
cumulative_token_coverage_through_band4 = 94.02%
cumulative_token_coverage_through_band5 = 97.87%
cumulative_token_coverage_through_band5_plus_unlisted = 100.00%
band1_examples: the(10296), of(7858), and(4440), in(4018), to(3607), that(2083), have(1763), be(1656), as(1591), on(1557), is(1419), by(1356), which(1229), or(1190), we(1157), are(1137), from(1132), for(1124), it(1054), with(999)
band2_examples: forms(403), natural(384), animals(297), thus(273), period(245), cases(226), generally(199), common(197), degree(191), characters(183), birds(167), parts(160), closely(158), facts(157), produced(143), character(140), theory(137), manner(127), slight(120), amount(114)
band3_examples: species(1542), plants(335), distinct(258), structure(225), conditions(222), groups(184), instance(165), islands(145), domestic(141), parent(141), beings(120), descended(103), hence(99), instincts(82), variety(81), increase(76), laws(74), instinct(70), produce(69), tend(66)
band4_examples: varieties(434), selection(416), intermediate(160), modified(153), individuals(145), inhabitants(143), organic(142), organs(139), differences(135), breeds(133), allied(131), habits(125), seeds(117), productions(114), widely(113), extinct(108), insects(104), variation(103), descendants(102), formations(102)
band5_examples: genera(220), modification(165), genus(149), hybrids(136), cannot(125), geological(99), sterility(97), pollen(86), variability(81), variable(74), naturalists(72), glacial(58), mammals(58), progenitor(56), modifications(55), etc(54), affinities(49), analogous(47), domestication(44), disuse(43)
unlisted_examples: mr(116), chapter(91), dr(45), silurian(36), gärtner(32), naturalised(32), madeira(30), zealand(30), de(28), homologous(28), larvæ(28), cirripedes(25), intercrossing(24), galapagos(23), lyell(22), fertilised(21), fossiliferous(20), fertilisation(17), owen(17), st(17)

=== 5. On the Origin of Species (Darwin) — FIRST 50,000 TOKENS ===
total_tokens=50000 distinct_words=4266
band         distinct    dist%       tokens     tok%
band1             677   15.87%        32738   65.48%
band2             754   17.67%         5365   10.73%
band3             452   10.60%         3376    6.75%
band4            1402   32.86%         5902   11.80%
band5             545   12.78%         1767    3.53%
unlisted          436   10.22%          852    1.70%
hard_word_share (band4+band5+unlisted / distinct) = 0.5586 (55.86%)
cumulative_token_coverage_through_band1 = 65.48%
cumulative_token_coverage_through_band2 = 76.21%
cumulative_token_coverage_through_band3 = 82.96%
cumulative_token_coverage_through_band4 = 94.76%
cumulative_token_coverage_through_band5 = 98.30%
cumulative_token_coverage_through_band5_plus_unlisted = 100.00%
band1_examples: the(3305), of(2478), and(1479), in(1366), to(1344), that(702), be(602), have(527), as(518), is(490), which(445), or(439), by(426), from(393), on(382), for(375), it(359), are(353), this(322), with(320)
band2_examples: natural(149), animals(138), thus(97), forms(80), generally(75), cases(71), characters(71), character(67), common(65), struggle(59), degree(57), amount(53), manner(53), period(53), parts(52), birds(51), individual(51), subject(48), closely(47), flower(47)
band3_examples: species(558), plants(150), structure(87), distinct(85), domestic(82), conditions(76), instance(52), beings(47), increase(47), parent(47), variety(47), groups(44), hence(37), descended(34), seed(33), effects(29), growth(29), tend(29), laws(27), competition(24)
band4_examples: selection(214), varieties(194), individuals(87), breeds(86), differences(68), variation(59), breed(58), organic(56), generations(49), modified(46), differ(44), insects(44), variations(43), descendants(42), inhabitants(42), climate(40), offspring(39), pigeon(38), sub(38), vary(38)
band5_examples: genera(98), genus(58), cannot(52), variability(52), pollen(44), modification(37), variable(36), etc(25), naturalists(23), disuse(22), domestication(20), correlation(19), modifications(18), divergence(17), seedlings(17), diversified(16), geological(16), analogous(15), domesticated(15), man's(15)
unlisted_examples: chapter(45), mr(37), intercrossing(19), fertilisation(14), naturalised(13), dr(12), hermaphrodites(11), madeira(10), polymorphic(9), acclimatisation(7), anthers(7), pouter(7), st(7), cirripedes(6), corolla(6), diversification(6), geoffroy(6), intercrosses(6), watson(6), wollaston(6)

=== 6. Alice's Adventures in Wonderland (Carroll) — FULL TEXT ===
total_tokens=25706 distinct_words=2624
band         distinct    dist%       tokens     tok%
band1             805   30.68%        20265   78.83%
band2             663   25.27%         1900    7.39%
band3             318   12.12%          801    3.12%
band4             593   22.60%         1409    5.48%
band5             139    5.30%          552    2.15%
unlisted          106    4.04%          779    3.03%
hard_word_share (band4+band5+unlisted / distinct) = 0.3194 (31.94%)
cumulative_token_coverage_through_band1 = 78.83%
cumulative_token_coverage_through_band2 = 86.23%
cumulative_token_coverage_through_band3 = 89.34%
cumulative_token_coverage_through_band4 = 94.82%
cumulative_token_coverage_through_band5 = 96.97%
cumulative_token_coverage_through_band5_plus_unlisted = 100.00%
band1_examples: the(1651), and(874), to(729), she(541), it(530), of(515), said(462), in(370), you(365), was(357), that(280), as(263), her(248), at(212), on(193), all(182), with(181), had(178), but(170), for(153)
band2_examples: queen(68), cat(35), march(34), curious(19), court(18), mad(16), bill(14), ought(14), begin(13), cook(13), dance(13), grow(13), size(13), pool(12), growing(11), hurried(11), hurry(11), birds(10), bottle(10), creatures(10)
band3_examples: rabbit(49), mouse(43), jury(22), soup(18), hastily(16), anxiously(14), cats(13), majesty(12), pig(12), queer(12), gloves(11), lessons(10), offended(10), remark(10), angrily(9), butter(9), eagerly(8), moral(8), adventures(7), fetch(7)
band4_examples: don't(61), it's(57), mock(57), turtle(57), duchess(39), hare(31), can't(28), caterpillar(28), you're(23), didn't(14), dodo(13), footman(13), they're(13), pigeon(12), wasn't(11), couldn't(9), knave(9), pepper(9), serpent(9), timidly(9)
band5_examples: gryphon(55), hatter(55), dormouse(39), that's(34), won't(24), doesn't(16), wouldn't(13), croquet(10), you'd(10), hadn't(8), haven't(8), it'll(8), whiting(8), hedgehog(7), isn't(7), lobsters(7), oop(7), she's(7), slates(7), soo(7)
unlisted_examples: alice(386), i'm(59), i've(34), i'll(31), chapter(24), there's(24), alice's(13), dinah(11), i'd(11), queen's(8), cheshire(7), lory(7), william(7), shan't(6), tis(5), ann(4), bill's(4), mabel(4), mary(4), ootiful(4)

=== 6. Alice's Adventures in Wonderland (Carroll) — FIRST 50,000 TOKENS === SKIPPED: only 25706 tokens total
test commands::book_difficulty::tests::evidence_item5_band_analysis ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 1488 filtered out; finished in 0.56s
```

## Summary table

Distinct-word band shares (%), full text. `hard_word_share` = (band4 + band5 + unlisted distinct words) / distinct words. Cumulative columns are **token-weighted** coverage.

| Text | Distinct words | band1% | band2% | band3% | band4% | band5% | unlisted% | hard_word_share | cum. coverage @band3 (tokens) | cum. coverage @band5 (tokens) |
|---|---|---|---|---|---|---|---|---|---|---|
| 1. The Little Prince | 2,553 | 29.53 | 24.83 | 12.18 | 21.86 | 5.80 | 5.80 | 33.45% | 91.54% | 98.12% |
| 6. Alice's Adventures in Wonderland | 2,624 | 30.68 | 25.27 | 12.12 | 22.60 | 5.30 | 4.04 | 31.94% | 89.34% | 96.97% |
| 2. The Adventures of Tom Sawyer | 7,467 | 12.74 | 18.90 | 13.29 | 35.36 | 11.75 | 7.98 | 55.08% | 84.31% | 94.92% |
| 3. Pride and Prejudice | 6,339 | 13.95 | 18.19 | 11.77 | 36.55 | 14.31 | 5.24 | 56.10% | 87.93% | 95.20% |
| 5. On the Origin of Species | 6,925 | 11.29 | 14.69 | 10.27 | 33.24 | 16.12 | 14.40 | 63.75% | 82.33% | 97.87% |
| 4. Moby-Dick | 17,359 | 5.59 | 10.14 | 8.54 | 36.23 | 21.00 | 18.50 | 75.72% | 81.20% | 95.94% |

Same table, **first-50,000-token normalised sample** (Little Prince and Alice omitted — both shorter than 50,000 tokens; see raw stdout above for their full-text-only numbers):

| Text | Distinct words | band1% | band2% | band3% | band4% | band5% | unlisted% | hard_word_share | cum. coverage @band3 (tokens) | cum. coverage @band5 (tokens) |
|---|---|---|---|---|---|---|---|---|---|---|
| 2. The Adventures of Tom Sawyer | 6,354 | 14.59 | 19.99 | 13.25 | 33.87 | 10.97 | 7.33 | 52.17% | 83.95% | 95.14% |
| 3. Pride and Prejudice | 4,412 | 18.70 | 20.81 | 12.42 | 33.05 | 10.79 | 4.24 | 48.07% | 87.24% | 94.51% |
| 5. On the Origin of Species | 4,266 | 15.87 | 17.67 | 10.60 | 32.86 | 12.78 | 10.22 | 55.86% | 82.96% | 98.30% |
| 4. Moby-Dick | 7,936 | 11.52 | 16.47 | 11.28 | 34.20 | 14.18 | 12.36 | 60.74% | 82.09% | 95.56% |

## Cleanup confirmation

The temporary test function was removed from `src-tauri/src/commands/book_difficulty.rs` after this run, and `git status --porcelain` was re-checked to confirm only the evidence file(s) under `docs/impls/automation-review/evidence/` are new.

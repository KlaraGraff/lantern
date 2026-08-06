use super::*;

/// Every number in §2.2 is a decimal that does not survive binary floating
/// point exactly (0.4, 0.2, 0.05). Compare within a tolerance far tighter
/// than any threshold this module branches on.
fn assert_close(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() < 1e-9,
        "expected {expected}, got {actual}"
    );
}

/// A plain exposure: not looked-up-active, paced normally.
fn exposure(chapter_occurrence: u32) -> Exposure {
    Exposure {
        chapter_occurrence,
        on_lookup_active_screen: false,
        screen_words_per_minute: 200.0,
    }
}

fn chapter(occurrences: impl IntoIterator<Item = u32>) -> ChapterExposures {
    ChapterExposures::new(occurrences.into_iter().map(exposure).collect())
}

/// A batch with no pace baseline, so the too-fast filter stays out of the
/// way of tests that are about something else.
fn batch(chapters: Vec<ChapterExposures>) -> ExposureBatch {
    ExposureBatch {
        reader_median_wpm: None,
        chapters,
    }
}

#[test]
fn tier_strings_match_the_values_stored_in_vocab_words() {
    for tier in [Tier::New, Tier::Learning, Tier::Familiar, Tier::Mastered] {
        assert_eq!(Tier::from_db_str(tier.as_str()), Some(tier));
    }
    assert_eq!(Tier::from_db_str("archived"), None);
    assert!(Tier::New < Tier::Learning && Tier::Learning < Tier::Familiar);
    assert!(Tier::Familiar < Tier::Mastered);
}

/// The sentence the word-detail page promises the reader — "you read it 4
/// times across 3 days and never looked it up" — has to land on Familiar,
/// and three such readings must not.
#[test]
fn four_unlooked_up_readings_in_different_chapters_land_exactly_on_familiar() {
    let three = apply_exposures(
        &WordState::new(Tier::Learning, 0.0),
        &batch(vec![chapter([1]), chapter([1]), chapter([1])]),
    );
    assert_eq!(three.tier, Tier::Learning);
    assert!(!three.changed);
    assert_close(three.credit, 3.0);

    let four = apply_exposures(
        &WordState::new(Tier::Learning, 0.0),
        &batch(vec![chapter([1]), chapter([1]), chapter([1]), chapter([1])]),
    );
    assert_eq!(four.tier, Tier::Familiar);
    assert!(four.changed);
    assert_eq!(four.reason, Some(REASON_EXPOSURE_PROMOTION));
}

/// §2.2's whole point: reading a word five times in one chapter moves the
/// number every single time, just by less each time. A flat step would be
/// the app telling the reader their effort did not count.
#[test]
fn repeats_inside_one_chapter_shrink_but_never_stop_counting() {
    let mut totals = Vec::new();
    for count in 1..=5u32 {
        let decision = apply_exposures(
            &WordState::new(Tier::Learning, 0.0),
            &batch(vec![chapter(1..=count)]),
        );
        assert_eq!(decision.tier, Tier::Learning, "five repeats must not promote");
        totals.push(decision.credit);
    }
    assert_close(totals[0], 1.0);
    assert_close(totals[4], 1.75);
    for pair in totals.windows(2) {
        assert!(
            pair[1] > pair[0],
            "credit went flat between {} and {}",
            pair[0],
            pair[1]
        );
    }
}

#[test]
fn one_chapter_can_never_contribute_more_than_two_credit() {
    let decision = apply_exposures(
        &WordState::new(Tier::Learning, 0.0),
        &batch(vec![chapter(1..=40)]),
    );
    assert_close(decision.credit, CHAPTER_CREDIT_CAP);
    assert_eq!(decision.tier, Tier::Learning);
}

/// The cap is on what the chapter contributes, boost included — a chapter
/// the reader worked through word by word reaches the cap sooner, it does
/// not get a larger one.
#[test]
fn the_boost_counts_against_the_same_chapter_cap() {
    let boosted = ChapterExposures::new(
        (1..=40)
            .map(|occurrence| Exposure {
                on_lookup_active_screen: true,
                ..exposure(occurrence)
            })
            .collect(),
    );
    let decision = apply_exposures(&WordState::new(Tier::Learning, 0.0), &batch(vec![boosted]));
    assert_close(decision.credit, CHAPTER_CREDIT_CAP);
}

/// A word skipped on a screen where the reader was busy looking *other*
/// words up is stronger evidence, and that difference has to be able to
/// decide an outcome, not just a decimal.
#[test]
fn a_skip_on_a_lookup_active_screen_can_be_what_tips_a_word_over() {
    let state = WordState::new(Tier::Learning, 2.8);
    let ordinary = apply_exposures(&state, &batch(vec![chapter([1])]));
    assert_eq!(ordinary.tier, Tier::Learning);
    assert_close(ordinary.credit, 3.8);

    let boosted = apply_exposures(
        &state,
        &batch(vec![ChapterExposures::new(vec![Exposure {
            on_lookup_active_screen: true,
            ..exposure(1)
        }])]),
    );
    assert_eq!(boosted.tier, Tier::Familiar);
    assert!(boosted.changed);
}

#[test]
fn promotion_resets_credit_to_zero() {
    let decision = apply_exposures(
        &WordState::new(Tier::Familiar, 7.5),
        &batch(vec![chapter([1]), chapter([1])]),
    );
    assert_eq!(decision.tier, Tier::Mastered);
    // The second chapter's 1.0 is discarded with the reset, not carried into
    // the new tier.
    assert_close(decision.credit, 0.0);
}

#[test]
fn demotion_resets_credit_to_zero() {
    let decision = apply_lookup(&WordState::new(Tier::Mastered, 6.0), Lookup { at_ms: 1_000 });
    assert_eq!(decision.tier, Tier::Familiar);
    assert_close(decision.credit, 0.0);
}

/// §2.3: one lookup means "I was unsure", not "I never knew this". Dropping
/// a Mastered word all the way back would be the "前功尽弃" feeling the
/// design explicitly refuses.
#[test]
fn a_first_lookup_costs_exactly_one_tier() {
    let decision = apply_lookup(&WordState::new(Tier::Mastered, 3.0), Lookup { at_ms: 1_000 });
    assert_eq!(decision.tier, Tier::Familiar);
    assert!(decision.changed);
    assert_eq!(decision.reason, Some(REASON_LOOKUP_DEMOTION));
    assert!(!decision.is_book_blocker);
    assert_eq!(decision.lookups_in_window, 1);
}

#[test]
fn a_second_lookup_inside_the_window_drops_straight_to_learning() {
    let first = apply_lookup(&WordState::new(Tier::Mastered, 3.0), Lookup { at_ms: 0 });
    let state = WordState {
        tier: first.tier,
        credit: first.credit,
        last_lookup_at_ms: Some(0),
        lookups_in_window: first.lookups_in_window,
    };

    let second = apply_lookup(
        &state,
        Lookup {
            at_ms: REPEAT_LOOKUP_WINDOW_MS - 1,
        },
    );
    assert_eq!(second.tier, Tier::Learning);
    assert!(second.changed);
    assert_eq!(second.reason, Some(REASON_REPEAT_LOOKUP_DEMOTION));
    assert!(!second.is_book_blocker);
    assert_eq!(second.lookups_in_window, 2);
}

#[test]
fn a_third_lookup_inside_the_window_marks_the_word_a_blocker_for_its_book() {
    let state = WordState {
        tier: Tier::Learning,
        credit: 0.0,
        last_lookup_at_ms: Some(1_000),
        lookups_in_window: 2,
    };
    let third = apply_lookup(&state, Lookup { at_ms: 2_000 });
    assert_eq!(third.tier, Tier::Learning);
    // Already at the floor, so nothing moved — and "nothing moved" is what
    // §2.6's timeline must not fill up with. The blocker flag is what this
    // lookup produced; `lookups_in_window` is where it persists.
    assert!(!third.changed);
    assert_eq!(third.reason, None);
    assert!(third.is_book_blocker);
    assert_eq!(third.lookups_in_window, 3);
}

/// The common case the rule above exists for: most of a reader's words sit at
/// Learning, and looking one up there moved nothing. No row, every time.
#[test]
fn a_lookup_on_a_word_already_at_the_floor_writes_no_timeline_row() {
    let decision = apply_lookup(&WordState::new(Tier::Learning, 2.5), Lookup { at_ms: 1_000 });
    assert_eq!(decision.tier, Tier::Learning);
    assert!(!decision.changed);
    assert_eq!(decision.reason, None);
    // The lookup still costs the credit it had built up toward Familiar.
    assert_close(decision.credit, 0.0);
}

/// The window is measured from the *previous* lookup, and falling outside it
/// starts the ladder over — two lookups a month apart are two separate
/// moments of doubt, not an escalation.
#[test]
fn a_lookup_outside_the_window_starts_the_ladder_over() {
    let state = WordState {
        tier: Tier::Mastered,
        credit: 0.0,
        last_lookup_at_ms: Some(0),
        lookups_in_window: 2,
    };
    let decision = apply_lookup(
        &state,
        Lookup {
            at_ms: REPEAT_LOOKUP_WINDOW_MS + 1,
        },
    );
    assert_eq!(decision.tier, Tier::Familiar);
    assert_eq!(decision.reason, Some(REASON_LOOKUP_DEMOTION));
    assert_eq!(decision.lookups_in_window, 1);
}

/// A lookup on a word nobody has classified yet files it as Learning rather
/// than leaving it at New — New means "never assessed", and the reader just
/// assessed it.
#[test]
fn a_lookup_on_an_unassessed_word_files_it_as_learning() {
    let decision = apply_lookup(&WordState::default(), Lookup { at_ms: 1_000 });
    assert_eq!(decision.tier, Tier::Learning);
    assert!(decision.changed);
}

#[test]
fn a_screen_read_far_faster_than_the_readers_own_median_contributes_nothing() {
    let median = 200.0;
    let skimmed = ExposureBatch {
        reader_median_wpm: Some(median),
        chapters: vec![ChapterExposures::new(vec![Exposure {
            screen_words_per_minute: median * 3.5,
            ..exposure(1)
        }])],
    };
    let decision = apply_exposures(&WordState::new(Tier::Learning, 0.0), &skimmed);
    assert_close(decision.credit, 0.0);
    assert!(!decision.changed);
}

#[test]
fn a_screen_merely_faster_than_usual_still_counts_in_full() {
    let median = 200.0;
    for multiple in [2.9, FAST_SCREEN_WPM_MULTIPLE] {
        let brisk = ExposureBatch {
            reader_median_wpm: Some(median),
            chapters: vec![ChapterExposures::new(vec![Exposure {
                screen_words_per_minute: median * multiple,
                ..exposure(1)
            }])],
        };
        let decision = apply_exposures(&WordState::new(Tier::Learning, 0.0), &brisk);
        assert_close(decision.credit, 1.0);
    }
}

/// No baseline means no such thing as "too fast" — §2.4 would rather
/// over-count than shut a reader out.
#[test]
fn without_a_pace_baseline_nothing_is_excluded_for_speed() {
    let decision = apply_exposures(
        &WordState::new(Tier::Learning, 0.0),
        &batch(vec![ChapterExposures::new(vec![Exposure {
            screen_words_per_minute: 9_000.0,
            ..exposure(1)
        }])]),
    );
    assert_close(decision.credit, 1.0);
}

#[test]
fn mastered_is_a_ceiling_that_further_reading_cannot_move() {
    let state = WordState::new(Tier::Mastered, 0.0);
    let decision = apply_exposures(
        &state,
        &batch(vec![chapter([1]), chapter([1]), chapter([1]), chapter([1])]),
    );
    assert_eq!(decision.tier, Tier::Mastered);
    assert!(!decision.changed);
    assert_eq!(decision.reason, None);
    assert_close(decision.credit, 0.0);
}

#[test]
fn median_pace_of_an_even_number_of_screens_averages_the_middle_two() {
    let screens = [
        ScreenPace {
            word_count: 100,
            dwell_ms: 60_000,
        },
        ScreenPace {
            word_count: 400,
            dwell_ms: 60_000,
        },
        ScreenPace {
            word_count: 300,
            dwell_ms: 60_000,
        },
        ScreenPace {
            word_count: 200,
            dwell_ms: 60_000,
        },
    ];
    assert_close(median_words_per_minute(&screens).unwrap(), 250.0);
}

#[test]
fn median_pace_of_an_odd_number_of_screens_is_the_middle_one() {
    let screens = [
        ScreenPace {
            word_count: 150,
            dwell_ms: 30_000,
        }, // 300 wpm
        ScreenPace {
            word_count: 100,
            dwell_ms: 60_000,
        }, // 100 wpm
        ScreenPace {
            word_count: 100,
            dwell_ms: 30_000,
        }, // 200 wpm
    ];
    assert_close(median_words_per_minute(&screens).unwrap(), 200.0);
}

/// No history, or only screens with nothing measurable on them, must read as
/// "run no speed filter" — never as a median of zero, which would exclude
/// every screen the reader ever turns.
#[test]
fn median_pace_without_usable_screens_is_none_not_zero() {
    assert_eq!(median_words_per_minute(&[]), None);
    assert_eq!(
        median_words_per_minute(&[
            ScreenPace {
                word_count: 0,
                dwell_ms: 60_000,
            },
            ScreenPace {
                word_count: 300,
                dwell_ms: 0,
            },
        ]),
        None
    );
}

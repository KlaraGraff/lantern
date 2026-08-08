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
        lookup_rate_scale: 1.0,
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
        assert_eq!(
            decision.tier,
            Tier::Learning,
            "five repeats must not promote"
        );
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
    let decision = apply_lookup(
        &WordState::new(Tier::Mastered, 6.0),
        Lookup { at_ms: 1_000 },
    );
    assert_eq!(decision.tier, Tier::Familiar);
    assert_close(decision.credit, 0.0);
}

/// §2.3: one lookup means "I was unsure", not "I never knew this". Dropping
/// a Mastered word all the way back would be the "前功尽弃" feeling the
/// design explicitly refuses.
#[test]
fn a_first_lookup_costs_exactly_one_tier() {
    let decision = apply_lookup(
        &WordState::new(Tier::Mastered, 3.0),
        Lookup { at_ms: 1_000 },
    );
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
    let decision = apply_lookup(
        &WordState::new(Tier::Learning, 2.5),
        Lookup { at_ms: 1_000 },
    );
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
        lookup_rate_scale: 1.0,
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
            lookup_rate_scale: 1.0,
            chapters: vec![ChapterExposures::new(vec![Exposure {
                screen_words_per_minute: median * multiple,
                ..exposure(1)
            }])],
        };
        let decision = apply_exposures(&WordState::new(Tier::Learning, 0.0), &brisk);
        assert_close(decision.credit, 1.0);
    }
}

/// No baseline switches off the *relative* gate only — §2.4 would rather
/// over-count than shut out a reader it has no history for, so a brisk but
/// human pace still earns credit.
#[test]
fn without_a_pace_baseline_a_human_pace_is_still_counted() {
    let decision = apply_exposures(
        &WordState::new(Tier::Learning, 0.0),
        &batch(vec![ChapterExposures::new(vec![Exposure {
            screen_words_per_minute: 450.0,
            ..exposure(1)
        }])]),
    );
    assert_close(decision.credit, 1.0);
}

/// The absolute gate is not switched off by a missing baseline. 9_000 wpm
/// used to earn full credit here for exactly that reason; it is a page-turn,
/// and it now earns nothing.
#[test]
fn without_a_pace_baseline_a_page_turn_still_earns_nothing() {
    let decision = apply_exposures(
        &WordState::new(Tier::Learning, 0.0),
        &batch(vec![ChapterExposures::new(vec![Exposure {
            screen_words_per_minute: 9_000.0,
            ..exposure(1)
        }])]),
    );
    assert_close(decision.credit, 0.0);
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

// -- §5.2 lookup-rate scaling -------------------------------------------

/// The scale multiplies every exposure's gain, so a reader calibrated at
/// 0.5x needs twice as many otherwise-identical readings to reach the same
/// credit as the neutral (1.0x) case above.
#[test]
fn a_low_lookup_rate_scale_halves_the_credit_from_an_identical_exposure() {
    let discounted = ExposureBatch {
        lookup_rate_scale: 0.5,
        ..batch(vec![chapter([1])])
    };
    let decision = apply_exposures(&WordState::new(Tier::Learning, 0.0), &discounted);
    assert_close(decision.credit, 0.5);
}

#[test]
fn a_high_lookup_rate_scale_grants_more_credit_from_an_identical_exposure() {
    let boosted = ExposureBatch {
        lookup_rate_scale: 1.5,
        ..batch(vec![chapter([1])])
    };
    let decision = apply_exposures(&WordState::new(Tier::Learning, 0.0), &boosted);
    assert_close(decision.credit, 1.5);
}

/// `ExposureBatch::default()` — what any caller gets from
/// `#[derive(Default)]` without setting the field — must behave as "no
/// calibration", i.e. today's unscaled arithmetic, not as "calibrated to
/// zero credit for everything". This is `sanitized_lookup_rate_scale`'s own
/// job, exercised here from the public entry point.
#[test]
fn a_default_constructed_batch_applies_no_lookup_rate_scaling() {
    let default_batch = ExposureBatch {
        chapters: vec![chapter([1])],
        ..ExposureBatch::default()
    };
    assert_close(default_batch.lookup_rate_scale, 0.0);
    let decision = apply_exposures(&WordState::new(Tier::Learning, 0.0), &default_batch);
    assert_close(decision.credit, 1.0);
}

/// A negative or non-finite scale is a caller bug, not a real calibration —
/// it must fall back to neutral rather than propagate NaN or invert the
/// sign of a credit.
#[test]
fn an_invalid_lookup_rate_scale_falls_back_to_neutral() {
    for invalid in [-1.0, f64::NAN, f64::INFINITY, 0.0] {
        let weird = ExposureBatch {
            lookup_rate_scale: invalid,
            ..batch(vec![chapter([1])])
        };
        let decision = apply_exposures(&WordState::new(Tier::Learning, 0.0), &weird);
        assert_close(decision.credit, 1.0);
    }
}

// -- §2.2 auto-finish gate ---------------------------------------------

/// A normal complete read: progress cleared 95, and the reader stayed on
/// the vast majority of the book's screens at their own pace.
#[test]
fn a_normal_complete_read_clears_the_gate() {
    assert!(should_auto_finish(96, 85, 100));
    assert!(finish_coverage_met(85, 100));
}

/// Sitting exactly on both floors still counts — §2.2's boundaries all
/// break toward the reader, never away from them.
#[test]
fn sitting_exactly_on_both_floors_still_passes() {
    assert!(should_auto_finish(95, 80, 100));
}

/// One point under either floor fails — these are floors, not roundable
/// targets.
#[test]
fn just_under_either_floor_fails() {
    assert!(!should_auto_finish(94, 100, 100), "progress one under 95");
    assert!(!finish_coverage_met(79, 100), "coverage one under 80%");
    assert!(!should_auto_finish(96, 79, 100), "coverage carries the gate");
}

/// Flipping through fast: progress reaches 100 (every screen was turned),
/// but almost none of them were dwelt at normal pace, so almost none count
/// toward coverage.
#[test]
fn rapid_flip_through_to_the_end_fails_on_coverage() {
    assert!(!should_auto_finish(100, 3, 100));
}

/// Jumping straight to the last page: progress reads 100, and the handful
/// of screens the reader actually landed on were read at a perfectly normal
/// pace — but there are only a couple of them against the book's whole
/// screen count, so coverage never clears 80%.
#[test]
fn jumping_straight_to_the_last_page_fails_on_coverage() {
    assert!(!should_auto_finish(100, 2, 100));
}

/// Cross-device: this device's local screen history only covers the half
/// of the book read here, so coverage cannot clear 80% no matter how
/// carefully those screens were read. §2.2's accepted failure direction —
/// this degrades to the last-screen hint, not a wrong auto-mark.
#[test]
fn cross_device_reading_leaves_local_coverage_short() {
    assert!(!should_auto_finish(96, 48, 100));
}

/// No screen total to measure against (e.g. a layout that has not settled)
/// must never read as "fully covered" by default.
#[test]
fn no_screen_total_never_auto_finishes() {
    assert!(!finish_coverage_met(1_000, 0));
    assert!(!finish_coverage_met(1_000, -1));
    assert!(!should_auto_finish(100, 1_000, 0));
}

// --- the two pace gates ---

/// A screen 800 words long, dwelt on for `dwell_ms`.
fn screen(dwell_ms: i64) -> ScreenPace {
    ScreenPace { word_count: 800, dwell_ms }
}

/// The ordinary case both gates are written to leave alone: a normal reading
/// pace, well under the absolute ceiling and well under 3x this reader's own
/// median.
#[test]
fn a_normally_paced_screen_passes_both_gates() {
    // 800 words in 4 minutes = 200 wpm.
    assert!(!is_screen_too_fast(screen(240_000), Some(220.0)));
}

/// The gap the relative gate alone cannot close, and the reason
/// `ABSOLUTE_MAX_WPM` exists. A median dragged up by page-turns puts the 3x
/// gate at 16_881 wpm, so a 6_300 wpm screen — 189 words in 1.8 seconds, a
/// real row from a real database — sails through the relative check. Nobody
/// reads that fast.
#[test]
fn a_page_turn_is_caught_even_when_the_relative_gate_waves_it_through() {
    let page_turn = ScreenPace { word_count: 189, dwell_ms: 1_800 };
    let contaminated_median = 5_627.0;
    // Stated as arithmetic rather than by calling `exceeds_pace_limit`: that
    // function now answers with both gates, so it can no longer witness what
    // the relative one would have said on its own.
    assert!(
        6_300.0 < contaminated_median * FAST_SCREEN_WPM_MULTIPLE,
        "precondition: the relative gate alone does not catch this"
    );
    assert!(is_screen_too_fast(page_turn, Some(contaminated_median)));
}

/// The converse gap, and the reason the relative gate is not replaced by the
/// absolute one: a screen can be unremarkable in absolute terms and still be
/// three times faster than this particular reader ever goes.
#[test]
fn a_screen_under_the_ceiling_still_fails_this_readers_own_baseline() {
    // 800 words in 96 seconds = 500 wpm: under 600, but 5x a 100 wpm median.
    assert!(is_screen_too_fast(screen(96_000), Some(100.0)));
}

/// The absolute gate needs no baseline, so a reader with no pace history is
/// still protected from having page-turns credited to them. §2.4's "break
/// toward the reader" applies to the personalised half only.
#[test]
fn the_absolute_gate_applies_with_no_median_at_all() {
    assert!(is_screen_too_fast(screen(10_000), None)); // 4_800 wpm
    assert!(!is_screen_too_fast(screen(240_000), None)); // 200 wpm
}

/// Every boundary in §2.4 breaks toward including the reader, so a screen
/// sitting exactly on a limit is kept.
#[test]
fn a_screen_exactly_on_either_limit_is_kept() {
    assert!(!exceeds_pace_limit(ABSOLUTE_MAX_WPM, None));
    assert!(!exceeds_pace_limit(300.0, Some(100.0)));
    assert!(exceeds_pace_limit(300.001, Some(100.0)));
}

/// Unmeasurable screens stay a data problem, not an exclusion — unchanged by
/// the absolute gate, which must not turn a garbage pace into a verdict.
#[test]
fn unmeasurable_screens_are_still_never_excluded() {
    assert!(!is_screen_too_fast(ScreenPace { word_count: 0, dwell_ms: 1_000 }, None));
    assert!(!is_screen_too_fast(ScreenPace { word_count: 800, dwell_ms: 0 }, None));
    assert!(!is_screen_too_fast(ScreenPace { word_count: -5, dwell_ms: 1_000 }, None));
    assert!(!exceeds_pace_limit(f64::NAN, Some(200.0)));
    assert!(!exceeds_pace_limit(f64::INFINITY, Some(200.0)));
}

/// The exposure path shares `exceeds_pace_limit`, so it inherits the absolute
/// gate rather than needing its own copy — this pins that it really does.
#[test]
fn the_exposure_path_inherits_the_absolute_gate() {
    let flipped = Exposure {
        chapter_occurrence: 1,
        on_lookup_active_screen: false,
        screen_words_per_minute: 6_300.0,
    };
    assert!(is_too_fast(&flipped, Some(5_627.0)));
    assert!(is_too_fast(&flipped, None));
}

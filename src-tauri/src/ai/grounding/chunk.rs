use super::{BlockText, SectionText, CHUNK_MAX_TOKENS, CHUNK_TARGET_TOKENS, SNIPPET_MAX_CHARS};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChunkDraft {
    pub section_index: i64,
    pub section_href: Option<String>,
    pub section_title: Option<String>,
    pub char_start: Option<i64>,
    pub char_end: Option<i64>,
    pub text: String,
    pub snippet: String,
    pub token_estimate: usize,
}

fn is_cjk(character: char) -> bool {
    matches!(character as u32,
        0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF |
        0x3040..=0x309F | 0x30A0..=0x30FF | 0xAC00..=0xD7AF
    )
}

pub fn estimate_tokens(text: &str) -> usize {
    let cjk = text.chars().filter(|character| is_cjk(*character)).count();
    let non_cjk_bytes = text.len().saturating_sub(
        text.chars()
            .filter(|character| is_cjk(*character))
            .map(char::len_utf8)
            .sum::<usize>(),
    );
    cjk + non_cjk_bytes.div_ceil(4)
}

fn normalize_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate_at_boundary(value: &str, maximum: usize) -> String {
    let chars = value.chars().collect::<Vec<_>>();
    if chars.len() <= maximum {
        return value.to_string();
    }
    let mut end = maximum;
    while end > 0
        && !chars[end - 1].is_whitespace()
        && !matches!(chars[end - 1], '。' | '．' | '.' | '!' | '?' | '！' | '？')
    {
        end -= 1;
    }
    if end == 0 {
        end = maximum;
    }
    chars[..end]
        .iter()
        .collect::<String>()
        .trim_end()
        .to_string()
}

fn snippet_for(text: &str) -> String {
    truncate_at_boundary(&normalize_whitespace(text), SNIPPET_MAX_CHARS)
}

/// Terminators that end a sentence on their own. Chinese prose puts no space
/// after `。`, so requiring one — as the halfwidth rule does — finds no
/// boundary anywhere in a Chinese paragraph.
const TERMINATORS_ALWAYS_CUT: [char; 3] = ['。', '！', '？'];

/// Terminators that only end a sentence when whitespace or the end of the text
/// follows. That lookahead is what keeps `3.14`, `v2.13.1` and `$1.50` whole.
const TERMINATORS_CUT_BEFORE_SPACE: [char; 4] = ['.', '!', '?', '．'];

/// Words whose trailing period belongs to the word. Without this the reader is
/// quoted `Mr.` as an example sentence — these fire constantly in English
/// fiction, which is most of what Lantern reads.
const ABBREVIATIONS: [&str; 24] = [
    "mr", "mrs", "ms", "dr", "prof", "st", "mt", "fr", "jr", "sr", "rev", "hon", "no", "vs", "etc",
    "al", "cf", "fig", "approx", "inc", "ltd", "co", "dept", "univ",
];

/// Punctuation that belongs to the sentence it closes rather than to the next
/// one: the `」` in `好的。」`, or the `！` in `真的吗？！`. Cutting straight after
/// the terminator would start the following sentence with an orphaned bracket.
fn is_sentence_tail(character: char) -> bool {
    matches!(
        character,
        '」' | '』'
            | '）'
            | '》'
            | '〉'
            | '】'
            | '〕'
            | '｝'
            | '”'
            | '’'
            | '"'
            | '\''
            | ')'
            | ']'
            | '}'
    ) || TERMINATORS_ALWAYS_CUT.contains(&character)
        || TERMINATORS_CUT_BEFORE_SPACE.contains(&character)
}

/// Whether the `.` at `dot_index` is part of a word rather than the end of a
/// sentence. Three shapes, cheapest first: a run of periods (`paused...`), a
/// dotted initialism recognised by shape rather than by dictionary (`U.S.`,
/// `Ph.D.`, `e.g.`), and the abbreviation list above.
///
/// Each of these errs toward *not* cutting. That is the safe direction: an
/// under-split example sentence is longer than it needed to be, an over-split
/// one is a fragment the reader cannot read.
fn is_word_internal_period(chars: &[char], dot_index: usize) -> bool {
    if dot_index > 0 && chars[dot_index - 1] == '.' {
        return true;
    }
    if dot_index >= 2 && chars[dot_index - 2] == '.' {
        return true;
    }
    let start = chars[..dot_index]
        .iter()
        .rposition(|character| !character.is_alphabetic())
        .map_or(0, |position| position + 1);
    if start == dot_index {
        return false;
    }
    let word = chars[start..dot_index]
        .iter()
        .flat_map(|character| character.to_lowercase())
        .collect::<String>();
    ABBREVIATIONS.contains(&word.as_str())
}

pub(crate) fn sentence_split(text: &str) -> Vec<String> {
    let chars = text.chars().collect::<Vec<_>>();
    let mut chunks = Vec::new();
    let mut start = 0;
    let mut index = 0;
    while index < chars.len() {
        let character = chars[index];
        let cut_at = if TERMINATORS_ALWAYS_CUT.contains(&character) {
            let mut tail = index + 1;
            while tail < chars.len() && is_sentence_tail(chars[tail]) {
                tail += 1;
            }
            Some(tail)
        } else if TERMINATORS_CUT_BEFORE_SPACE.contains(&character)
            && (index + 1 == chars.len() || chars[index + 1].is_whitespace())
            && !(character == '.' && is_word_internal_period(&chars, index))
        {
            Some(index + 1)
        } else {
            None
        };
        let Some(cut_at) = cut_at else {
            index += 1;
            continue;
        };
        let sentence: String = chars[start..cut_at].iter().collect();
        if !sentence.trim().is_empty() {
            chunks.push(sentence);
        }
        start = cut_at;
        index = cut_at;
    }
    if start < chars.len() {
        let rest: String = chars[start..].iter().collect();
        if !rest.trim().is_empty() {
            chunks.push(rest);
        }
    }
    if chunks.is_empty() {
        vec![text.to_string()]
    } else {
        chunks
    }
}

fn split_oversized_block(block: &BlockText) -> Vec<BlockText> {
    if estimate_tokens(&block.text) <= CHUNK_MAX_TOKENS {
        return vec![block.clone()];
    }
    let sentences = sentence_split(&block.text);
    let mut result = Vec::new();
    let mut current = String::new();
    for sentence in sentences {
        let next = if current.is_empty() {
            sentence.clone()
        } else {
            format!("{current} {sentence}")
        };
        if !current.is_empty() && estimate_tokens(&next) > CHUNK_MAX_TOKENS {
            result.push(BlockText {
                text: current,
                char_start: block.char_start,
                char_end: block.char_end,
            });
            current = sentence;
        } else {
            current = next;
        }
    }
    if !current.is_empty() {
        result.push(BlockText {
            text: current,
            char_start: block.char_start,
            char_end: block.char_end,
        });
    }
    result
}

fn draft(section: &SectionText, blocks: &[BlockText]) -> Option<ChunkDraft> {
    let text = blocks
        .iter()
        .map(|block| block.text.trim())
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if text.is_empty() {
        return None;
    }
    Some(ChunkDraft {
        section_index: section.section_index,
        section_href: section.section_href.clone(),
        section_title: section.section_title.clone(),
        char_start: blocks.iter().filter_map(|block| block.char_start).min(),
        char_end: blocks.iter().filter_map(|block| block.char_end).max(),
        snippet: snippet_for(&text),
        token_estimate: estimate_tokens(&text),
        text,
    })
}

pub fn chunk_sections(sections: Vec<SectionText>) -> Vec<ChunkDraft> {
    let mut chunks = Vec::new();
    for section in sections {
        let blocks = section
            .blocks
            .iter()
            .flat_map(split_oversized_block)
            .collect::<Vec<_>>();
        let mut current = Vec::new();
        let mut current_tokens = 0;
        for block in blocks {
            let tokens = estimate_tokens(&block.text);
            if !current.is_empty() && current_tokens + tokens > CHUNK_TARGET_TOKENS {
                if let Some(chunk) = draft(&section, &current) {
                    chunks.push(chunk);
                }
                current.clear();
                current_tokens = 0;
            }
            current_tokens += tokens;
            current.push(block);
        }
        if let Some(chunk) = draft(&section, &current) {
            chunks.push(chunk);
        }
    }
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    fn section(index: i64, blocks: Vec<&str>) -> SectionText {
        SectionText {
            section_index: index,
            section_href: None,
            section_title: None,
            blocks: blocks
                .into_iter()
                .map(|text| BlockText {
                    text: text.to_string(),
                    char_start: None,
                    char_end: None,
                })
                .collect(),
        }
    }

    #[test]
    fn estimates_cjk_conservatively() {
        assert_eq!(estimate_tokens("你好abcd"), 3);
    }

    #[test]
    fn does_not_cross_sections_and_uses_verbatim_snippets() {
        let chunks = chunk_sections(vec![section(0, vec!["One."]), section(1, vec!["Two."])]);
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].section_index, 0);
        assert_eq!(chunks[1].section_index, 1);
        assert!(chunks[0].text.starts_with(&chunks[0].snippet));
    }

    #[test]
    fn splits_oversized_blocks_at_sentence_boundaries() {
        let value = (0..300).map(|_| "Sentence.").collect::<Vec<_>>().join(" ");
        let chunks = chunk_sections(vec![section(0, vec![&value])]);
        assert!(chunks.len() > 1);
        assert!(chunks
            .iter()
            .all(|chunk| chunk.token_estimate <= CHUNK_MAX_TOKENS));
    }

    // ---------------------------------------------------------------------
    // `sentence_split` — direct unit tests.
    //
    // The rule has two halves. `。！？` cut on their own, then swallow any
    // closing bracket or second terminator behind them. `. ! ? ．` cut only
    // when whitespace or the end of the text follows, and `.` additionally
    // has to survive a lookbehind that recognises abbreviations, dotted
    // initialisms and ellipses.
    //
    // Everywhere the rule is unsure it declines to cut. Under-splitting costs
    // a longer example sentence; over-splitting costs a fragment.
    //
    // These sentences are product-visible: they become the example sentences
    // quoted back to the reader in the learning card. A wrong cut shows the
    // reader half a sentence.
    // ---------------------------------------------------------------------

    // --- Abbreviations ---------------------------------------------------

    #[test]
    fn does_not_split_after_a_title_abbreviation() {
        assert_eq!(
            sentence_split("Mr. Holmes lit his pipe."),
            ["Mr. Holmes lit his pipe."]
        );
        assert_eq!(
            sentence_split("Mrs. Hudson knocked twice."),
            ["Mrs. Hudson knocked twice."]
        );
        assert_eq!(
            sentence_split("Dr. Watson arrived late."),
            ["Dr. Watson arrived late."]
        );
        assert_eq!(
            sentence_split("They met on St. James Street."),
            ["They met on St. James Street."]
        );
        assert_eq!(
            sentence_split("Prof. Nakamura wrote the preface."),
            ["Prof. Nakamura wrote the preface."]
        );
    }

    #[test]
    fn does_not_split_after_a_latin_abbreviation() {
        assert_eq!(
            sentence_split("Bring warm clothes, e.g. a coat, before you go."),
            ["Bring warm clothes, e.g. a coat, before you go."]
        );
        assert_eq!(
            sentence_split("The result, i.e. the sum, was wrong."),
            ["The result, i.e. the sum, was wrong."]
        );
        assert_eq!(
            sentence_split("Apples, pears, etc. were on the table."),
            ["Apples, pears, etc. were on the table."]
        );
        assert_eq!(
            sentence_split("It was Ada vs. the machine."),
            ["It was Ada vs. the machine."]
        );
    }

    #[test]
    fn does_not_split_inside_a_dotted_initialism() {
        assert_eq!(
            sentence_split("The U.S. economy slowed sharply."),
            ["The U.S. economy slowed sharply."]
        );
        assert_eq!(
            sentence_split("She earned a Ph.D. in botany."),
            ["She earned a Ph.D. in botany."]
        );
    }

    // --- Decimals and numbers --------------------------------------------

    #[test]
    fn keeps_decimals_and_version_strings_intact() {
        // These pass: the period is followed by a digit, never whitespace.
        assert_eq!(
            sentence_split("Pi is roughly 3.14 in most textbooks."),
            ["Pi is roughly 3.14 in most textbooks."]
        );
        assert_eq!(
            sentence_split("The book cost $1.50 at the fair."),
            ["The book cost $1.50 at the fair."]
        );
        assert_eq!(
            sentence_split("Lantern v2.13.1 fixed the reader."),
            ["Lantern v2.13.1 fixed the reader."]
        );
    }

    #[test]
    fn does_not_split_after_a_numeric_abbreviation() {
        assert_eq!(
            sentence_split("Turn to No. 5 on the list."),
            ["Turn to No. 5 on the list."]
        );
    }

    // --- Ellipses ---------------------------------------------------------

    #[test]
    fn does_not_split_at_a_mid_sentence_ellipsis() {
        assert_eq!(
            sentence_split("He paused... then left."),
            ["He paused... then left."]
        );
    }

    // --- Quotes and brackets ---------------------------------------------

    #[test]
    fn keeps_a_terminator_inside_quotation_marks_with_its_sentence() {
        assert_eq!(
            sentence_split("\"Stop!\" she said."),
            ["\"Stop!\" she said."]
        );
    }

    #[test]
    fn merges_a_parenthetical_terminator_with_the_following_sentence() {
        // Defensible, and asserted as-is: a terminator before `)` is not
        // followed by whitespace, so no cut happens there and the closing
        // bracket keeps its sentence whole. The cost is under-splitting — the
        // next sentence is glued on — which yields a longer example sentence,
        // never a truncated one. Under-splitting is the safe failure direction
        // for a quoted example, so this trade-off is left alone.
        assert_eq!(
            sentence_split("He left early (the door was open.) Nobody noticed."),
            ["He left early (the door was open.) Nobody noticed."]
        );
    }

    // --- CJK punctuation --------------------------------------------------

    #[test]
    fn splits_chinese_sentences_at_full_width_terminators() {
        assert_eq!(
            sentence_split("他说完就走了。屋里安静下来。"),
            ["他说完就走了。", "屋里安静下来。"]
        );
        assert_eq!(
            sentence_split("真的吗？我不信！他笑了。"),
            ["真的吗？", "我不信！", "他笑了。"]
        );
    }

    #[test]
    fn keeps_a_closing_bracket_with_the_sentence_it_closes() {
        // Chinese dialogue closes after the period, not before it. Cutting at
        // the terminator alone would hand the reader an example sentence that
        // opens with a stray `」`.
        assert_eq!(
            sentence_split("他说：「好的。」然后就走了。"),
            ["他说：「好的。」", "然后就走了。"]
        );
        assert_eq!(
            sentence_split("真的吗？！我不信。"),
            ["真的吗？！", "我不信。"]
        );
    }

    #[test]
    fn splits_a_mixed_chinese_and_english_paragraph_at_every_terminator() {
        assert_eq!(
            sentence_split("他读到 Chapter 3。The room was quiet. 然后合上了书。"),
            [
                "他读到 Chapter 3。",
                "The room was quiet.",
                " 然后合上了书。"
            ]
        );
    }

    #[test]
    fn keeps_oversized_chinese_blocks_within_the_token_budget() {
        // The functional consequence of the rule above: Chinese prose puts no
        // space after `。`, so `sentence_split` finds no boundary at all and
        // `split_oversized_block` cannot break the block up.
        let value = (0..300).map(|_| "他说完就走了。").collect::<String>();
        let chunks = chunk_sections(vec![section(0, vec![&value])]);
        assert!(chunks
            .iter()
            .all(|chunk| chunk.token_estimate <= CHUNK_MAX_TOKENS));
    }

    // --- Boundary shapes --------------------------------------------------

    #[test]
    fn returns_the_input_unchanged_when_there_is_no_terminator() {
        assert_eq!(sentence_split("No terminator here"), ["No terminator here"]);
    }

    #[test]
    fn returns_a_single_empty_sentence_for_blank_input() {
        // Defensible, and asserted as-is: the `chunks.is_empty()` fallback
        // returns the original text rather than an empty vector, so blank input
        // round-trips instead of vanishing. Callers (`split_oversized_block`)
        // only reach this with non-empty prose, and `draft` filters empty text
        // out downstream, so the quirk is unreachable in production.
        assert_eq!(sentence_split(""), [""]);
        assert_eq!(sentence_split("   "), ["   "]);
    }

    #[test]
    fn drops_trailing_whitespace_after_the_final_terminator() {
        assert_eq!(sentence_split("Hello.   "), ["Hello."]);
    }

    #[test]
    fn treats_consecutive_terminators_as_one_boundary() {
        assert_eq!(
            sentence_split("Really?! I had no idea."),
            ["Really?!", " I had no idea."]
        );
    }

    #[test]
    fn does_not_split_at_a_newline_without_a_terminator() {
        assert_eq!(
            sentence_split("He turned the page\nand kept reading."),
            ["He turned the page\nand kept reading."]
        );
    }

    #[test]
    fn splits_at_a_terminator_followed_by_a_newline() {
        assert_eq!(
            sentence_split("The end.\nA new line begins."),
            ["The end.", "\nA new line begins."]
        );
    }

    #[test]
    fn carries_the_separating_whitespace_into_the_following_sentence() {
        // Defensible, and asserted as-is: the cut lands immediately after the
        // terminator, so every sentence but the first keeps its leading space.
        // Callers normalise (`normalize_whitespace`) or re-join with a space,
        // so the leading space is invisible in product output.
        assert_eq!(
            sentence_split("One. Two. Three."),
            ["One.", " Two.", " Three."]
        );
    }
}

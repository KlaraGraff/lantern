#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SegmentMode {
    Index,
    Query,
}

fn is_cjk(character: char) -> bool {
    matches!(character as u32,
        0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF |
        0x3040..=0x309F | 0x30A0..=0x30FF | 0xAC00..=0xD7AF
    )
}

fn segment_cjk(run: &[char], mode: SegmentMode, output: &mut Vec<String>) {
    match mode {
        SegmentMode::Index => {
            output.extend(run.iter().map(|character| character.to_string()));
            output.extend(run.windows(2).map(|pair| pair.iter().collect()));
        }
        SegmentMode::Query => {
            if run.len() == 1 {
                output.push(run[0].to_string());
            } else {
                output.extend(run.windows(2).map(|pair| pair.iter().collect()));
            }
        }
    }
}

/// Adds CJK terms that sqlite's unicode61 tokenizer otherwise cannot form.
/// Non-CJK content remains intact for unicode61 to tokenize normally.
pub fn segment_for_fts(text: &str, mode: SegmentMode) -> String {
    let mut output = Vec::new();
    let mut cjk_run = Vec::new();
    let mut other = String::new();

    let flush = |cjk_run: &mut Vec<char>, other: &mut String, output: &mut Vec<String>| {
        if !other.is_empty() {
            output.push(std::mem::take(other));
        }
        if !cjk_run.is_empty() {
            segment_cjk(cjk_run, mode, output);
            cjk_run.clear();
        }
    };

    for character in text.chars() {
        if is_cjk(character) {
            if !other.is_empty() {
                output.push(std::mem::take(&mut other));
            }
            cjk_run.push(character);
        } else {
            if !cjk_run.is_empty() {
                segment_cjk(&cjk_run, mode, &mut output);
                cjk_run.clear();
            }
            other.push(character);
        }
    }
    flush(&mut cjk_run, &mut other, &mut output);
    output.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn indexes_cjk_unigrams_and_bigrams_without_losing_other_runs() {
        assert_eq!(
            segment_for_fts("红楼梦 hello", SegmentMode::Index),
            "红 楼 梦 红楼 楼梦  hello"
        );
    }

    #[test]
    fn query_uses_selective_cjk_bigrams_and_single_character_fallback() {
        assert_eq!(segment_for_fts("宝玉", SegmentMode::Query), "宝玉");
        assert_eq!(segment_for_fts("梦", SegmentMode::Query), "梦");
    }

    #[test]
    fn handles_kana_empty_and_punctuation() {
        assert_eq!(segment_for_fts("かな", SegmentMode::Index), "か な かな");
        assert_eq!(segment_for_fts("", SegmentMode::Query), "");
        assert_eq!(segment_for_fts("!?", SegmentMode::Query), "!?");
    }
}

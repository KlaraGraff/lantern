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

fn sentence_split(text: &str) -> Vec<String> {
    let chars = text.chars().collect::<Vec<_>>();
    let mut chunks = Vec::new();
    let mut start = 0;
    for (index, character) in chars.iter().enumerate() {
        if matches!(character, '。' | '．' | '.' | '!' | '?' | '！' | '？')
            && (index + 1 == chars.len() || chars[index + 1].is_whitespace())
        {
            let sentence: String = chars[start..=index].iter().collect();
            if !sentence.trim().is_empty() {
                chunks.push(sentence);
            }
            start = index + 1;
        }
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
}

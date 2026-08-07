//! Work out what language a book is in, from the book itself.
//!
//! `dc:language` is spec-required and read at import (see `epub.rs`), but a
//! great many real files leave it out — and those are exactly the files this
//! whole area exists for. The fallback is to look at the prose.
//!
//! Deliberately not an AI call. The model earns its keep on titles and
//! authors, where it is genuinely *guessing* at something a filename mangled;
//! language is not a guess. A few hundred words of prose settle it, offline
//! and free, and asking a reader to check the answer would be asking them to
//! confirm that a Chinese book is in Chinese.
//!
//! It runs while the grounding index is being built, on text that has already
//! been extracted for chunking, so it costs one pass over a sample and no I/O
//! of its own.

/// How much prose to look at. `whatlang` is reliable well before this;
/// the rest of a novel adds runtime without adding confidence.
const SAMPLE_CHARS: usize = 2_000;

/// Below this, `whatlang` is guessing from too little evidence. Storing
/// nothing beats storing a coin flip — a NULL invites a later, better answer,
/// whereas a wrong tag looks settled and nobody revisits it.
const MIN_CONFIDENCE: f64 = 0.5;

/// Detect a BCP 47 primary subtag, or `None` when the text is too short, too
/// ambiguous, or in a language this build does not map.
///
/// The tag is bare (`"en"`, not `"en-GB"`): prose reveals the language, not
/// the region, and inventing a region would be inventing information.
/// `dc:language` values keep whatever region they were written with — that
/// one came from the publisher and is a fact about the file.
pub fn detect(text: &str) -> Option<String> {
    let sample: String = text
        .chars()
        .filter(|value| !value.is_control())
        .take(SAMPLE_CHARS)
        .collect();
    if sample.trim().chars().count() < 32 {
        return None;
    }
    let info = whatlang::detect(&sample)?;
    if info.confidence() < MIN_CONFIDENCE {
        return None;
    }
    two_letter_code(info.lang()).map(str::to_string)
}

/// `whatlang` speaks ISO 639-3; `dc:language` and every consumer downstream
/// speak BCP 47, whose primary subtag is ISO 639-1 where one exists. Mapped
/// explicitly rather than by table lookup so an unmapped language yields
/// `None` — a book in a language this build cannot name is better left
/// unlabelled than labelled with a code nothing else understands.
fn two_letter_code(lang: whatlang::Lang) -> Option<&'static str> {
    use whatlang::Lang;
    Some(match lang {
        Lang::Cmn => "zh",
        Lang::Eng => "en",
        Lang::Jpn => "ja",
        Lang::Kor => "ko",
        Lang::Spa => "es",
        Lang::Fra => "fr",
        Lang::Deu => "de",
        Lang::Rus => "ru",
        Lang::Por => "pt",
        Lang::Ita => "it",
        Lang::Nld => "nl",
        Lang::Pol => "pl",
        Lang::Tur => "tr",
        Lang::Ara => "ar",
        Lang::Heb => "he",
        Lang::Hin => "hi",
        Lang::Ben => "bn",
        Lang::Vie => "vi",
        Lang::Tha => "th",
        Lang::Ind => "id",
        Lang::Swe => "sv",
        Lang::Dan => "da",
        Lang::Fin => "fi",
        Lang::Nob => "nb",
        Lang::Ces => "cs",
        Lang::Ell => "el",
        Lang::Ukr => "uk",
        Lang::Hun => "hu",
        Lang::Ron => "ro",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_english_prose() {
        let text = "It is a truth universally acknowledged, that a single man in \
             possession of a good fortune, must be in want of a wife. However little \
             known the feelings or views of such a man may be on his first entering a \
             neighbourhood, this truth is so well fixed in the minds of the surrounding \
             families, that he is considered as the rightful property of some one or \
             other of their daughters.";
        assert_eq!(detect(text).as_deref(), Some("en"));
    }

    #[test]
    fn detects_chinese_prose() {
        let text = "凡是有钱的单身汉，总想娶位太太，这已经成了一条举世公认的真理。\
             这样的单身汉，每逢新搬到一个地方，四邻八舍虽然完全不了解他的性情如何，\
             见解如何，可是，既然这样的一条真理早已在人们心目中根深蒂固，\
             因此人们总是把他看作自己某一个女儿理所应得的一笔财产。";
        assert_eq!(detect(text).as_deref(), Some("zh"));
    }

    #[test]
    fn refuses_to_guess_from_a_scrap() {
        assert_eq!(detect(""), None);
        assert_eq!(detect("Chapter 1"), None);
    }
}

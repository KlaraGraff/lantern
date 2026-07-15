use rusqlite::{params, OptionalExtension};

use super::retrieve::SpoilerCutoff;
use crate::db::Db;
use crate::error::AppResult;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SpoilerResolution {
    pub active: bool,
    pub cutoff: Option<SpoilerCutoff>,
    pub progress: i32,
}

fn parse_text_offset(value: &str) -> Option<i64> {
    if let Some(rest) = value.strip_prefix("textloc:v2:") {
        return rest.split(':').next()?.parse::<i64>().ok();
    }
    value.strip_prefix("textloc:")?.parse::<i64>().ok()
}

fn parse_spine_section(value: &str) -> Option<i64> {
    let prefix = value.strip_prefix("epubcfi(/6/")?;
    let number = prefix
        .split(|character: char| !character.is_ascii_digit())
        .next()?
        .parse::<i64>()
        .ok()?;
    (number >= 2 && number % 2 == 0).then_some(number / 2 - 1)
}

pub(crate) fn cutoff_for_position(render_format: &str, current_cfi: Option<&str>) -> SpoilerCutoff {
    let current_cfi = current_cfi.unwrap_or_default();
    if render_format == "text" {
        SpoilerCutoff::Character(parse_text_offset(current_cfi).unwrap_or(0).max(0))
    } else {
        SpoilerCutoff::Section(parse_spine_section(current_cfi).unwrap_or(0).max(0))
    }
}

pub fn resolve_cutoff(db: &Db, book_id: &str) -> AppResult<SpoilerResolution> {
    let conn = db.reader();
    let global_enabled = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'ai_spoiler_guard'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .map(|value| value != "false")
        .unwrap_or(true);
    let book = conn
        .query_row(
            "SELECT COALESCE(render_format, format), current_cfi, progress FROM books WHERE id = ?1",
            params![book_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, i32>(2)?,
                ))
            },
        )
        .optional()?;
    let override_key = format!("book_spoiler_guard_{book_id}");
    let book_override = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![override_key],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let enabled = match book_override.as_deref() {
        Some("on") => true,
        Some("off") => false,
        _ => global_enabled,
    };

    Ok(match book {
        Some((render_format, current_cfi, progress)) if enabled => SpoilerResolution {
            active: true,
            cutoff: Some(cutoff_for_position(&render_format, current_cfi.as_deref())),
            progress: progress.clamp(0, 100),
        },
        Some((_, _, progress)) => SpoilerResolution {
            active: false,
            cutoff: None,
            progress: progress.clamp(0, 100),
        },
        None => SpoilerResolution {
            active: false,
            cutoff: None,
            progress: 0,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_text_epub_and_pdf_locations() {
        assert_eq!(
            cutoff_for_position("text", Some("textloc:v2:12345:12350")),
            SpoilerCutoff::Character(12345)
        );
        assert_eq!(
            cutoff_for_position("epub", Some("epubcfi(/6/8!/4/2:9)")),
            SpoilerCutoff::Section(3)
        );
        assert_eq!(
            cutoff_for_position("pdf", Some("epubcfi(/6/12)")),
            SpoilerCutoff::Section(5)
        );
        assert_eq!(cutoff_for_position("epub", None), SpoilerCutoff::Section(0));
    }
}

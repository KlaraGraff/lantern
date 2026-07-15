use std::path::Path;

use epub::doc::{EpubDoc, NavPoint};
use scraper::{Html, Selector};

use crate::commands::books::load_prepared_document_for_grounding;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::pdfium;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockText {
    pub text: String,
    pub char_start: Option<i64>,
    pub char_end: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SectionText {
    pub section_index: i64,
    pub section_href: Option<String>,
    pub section_title: Option<String>,
    pub blocks: Vec<BlockText>,
}

fn normalize_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn href_key(value: &str) -> String {
    value
        .split('#')
        .next()
        .unwrap_or(value)
        .trim_start_matches("./")
        .to_string()
}

fn find_toc_title(toc: &[NavPoint], href: &str) -> Option<String> {
    for item in toc {
        if href_key(&item.content.to_string_lossy()) == href_key(href) {
            return (!item.label.trim().is_empty()).then(|| item.label.trim().to_string());
        }
        if let Some(title) = find_toc_title(&item.children, href) {
            return Some(title);
        }
    }
    None
}

pub fn extract_epub(path: &Path) -> AppResult<Vec<SectionText>> {
    let mut doc = EpubDoc::new(path).map_err(|error| AppError::Epub(error.to_string()))?;
    let selector = Selector::parse(
        "p, h1, h2, h3, h4, h5, h6, li, blockquote, dd, dt, td, th, figcaption, pre",
    )
    .expect("valid static selector");
    let heading_selector = Selector::parse("h1, h2, h3").expect("valid static selector");
    let mut sections = Vec::new();

    for section_index in 0..doc.spine.len() {
        if !doc.set_current_chapter(section_index) {
            continue;
        }
        let href = doc
            .get_current_path()
            .map(|path| path.to_string_lossy().to_string());
        let Some((body, _mime)) = doc.get_current_str() else {
            continue;
        };
        let html = Html::parse_document(&body);
        let blocks = html
            .select(&selector)
            .map(|element| normalize_whitespace(&element.text().collect::<Vec<_>>().join(" ")))
            .filter(|text| !text.is_empty())
            .map(|text| BlockText {
                text,
                char_start: None,
                char_end: None,
            })
            .collect::<Vec<_>>();
        if blocks.is_empty() {
            continue;
        }
        let heading = html
            .select(&heading_selector)
            .map(|element| normalize_whitespace(&element.text().collect::<Vec<_>>().join(" ")))
            .find(|text| !text.is_empty());
        let section_title = href
            .as_deref()
            .and_then(|value| find_toc_title(&doc.toc, value))
            .or(heading);
        sections.push(SectionText {
            section_index: section_index as i64,
            section_href: href,
            section_title,
            blocks,
        });
    }
    Ok(sections)
}

pub fn extract_text_book(
    db: &Db,
    book_id: &str,
    expected_source_sha256: Option<&str>,
) -> AppResult<Vec<SectionText>> {
    let document = load_prepared_document_for_grounding(db, book_id, expected_source_sha256)?;
    let mut sections: Vec<SectionText> = Vec::new();
    let mut toc_index = 0usize;

    for chunk in document.chunks {
        for block in chunk.blocks {
            while toc_index + 1 < document.toc.len()
                && document.toc[toc_index + 1].source_offset <= block.source_start
            {
                toc_index += 1;
            }
            let (section_index, section_title) = if document.toc.is_empty() {
                (0_i64, None)
            } else {
                (
                    toc_index as i64,
                    Some(document.toc[toc_index].title.clone()),
                )
            };
            if sections.last().map(|section| section.section_index) != Some(section_index) {
                sections.push(SectionText {
                    section_index,
                    section_href: None,
                    section_title,
                    blocks: Vec::new(),
                });
            }
            let text = normalize_whitespace(&block.text);
            if !text.is_empty() {
                sections
                    .last_mut()
                    .expect("section just created")
                    .blocks
                    .push(BlockText {
                        text,
                        char_start: i64::try_from(block.source_start).ok(),
                        char_end: i64::try_from(block.source_end).ok(),
                    });
            }
        }
    }
    Ok(sections
        .into_iter()
        .filter(|section| !section.blocks.is_empty())
        .collect())
}

fn pdf_page_blocks(text: &str) -> Vec<BlockText> {
    let mut blocks = Vec::new();
    let mut current = Vec::new();
    for line in text.lines() {
        let line = normalize_whitespace(line);
        if line.is_empty() {
            if !current.is_empty() {
                blocks.push(BlockText {
                    text: current.join(" "),
                    char_start: None,
                    char_end: None,
                });
                current.clear();
            }
        } else {
            current.push(line);
        }
    }
    if !current.is_empty() {
        blocks.push(BlockText {
            text: current.join(" "),
            char_start: None,
            char_end: None,
        });
    }
    blocks
}

fn is_scanned_pdf(page_count: i32, total_chars: usize) -> bool {
    page_count > 5 && total_chars < 500
}

/// Extract text-layer PDF content into page-sized sections. PDFs with more
/// than five pages but almost no text are treated as scans so grounding keeps
/// its existing metadata-only fallback rather than indexing meaningless data.
pub fn extract_pdf(path: &Path) -> AppResult<Vec<SectionText>> {
    let pdfium = pdfium::pdfium().map_err(|error| AppError::Other(error.to_string()))?;
    let document = pdfium
        .load_pdf_from_file(path, None)
        .map_err(|error| AppError::Other(error.to_string()))?;
    let page_count = document.pages().len();
    let mut total_chars = 0usize;
    let mut sections = Vec::new();

    for page_index in 0..page_count {
        let page = document
            .pages()
            .get(page_index)
            .map_err(|error| AppError::Other(error.to_string()))?;
        let text = page
            .text()
            .map_err(|error| AppError::Other(error.to_string()))?
            .all();
        total_chars += text.chars().count();
        let blocks = pdf_page_blocks(&text);
        if !blocks.is_empty() {
            sections.push(SectionText {
                section_index: page_index as i64,
                section_href: None,
                section_title: Some(format!("Page {}", page_index + 1)),
                blocks,
            });
        }
    }

    if is_scanned_pdf(page_count, total_chars) {
        return Err(AppError::Other("PDF_TEXT_LAYER_UNAVAILABLE".to_string()));
    }
    Ok(sections)
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::{dictionary, Document, Object, Stream};
    use std::fs;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    fn write_searchable_pdf(path: &Path) {
        let mut document = Document::with_version("1.5");
        let pages_id = document.new_object_id();
        let font_id = document.add_object(dictionary! {
            "Type" => "Font",
            "Subtype" => "Type1",
            "BaseFont" => "Helvetica",
        });
        let content_id = document.add_object(Stream::new(
            dictionary! {},
            b"BT /F1 18 Tf 72 720 Td (A searchable PDF passage.) Tj ET".to_vec(),
        ));
        let page_id = document.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "Contents" => content_id,
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
            "Resources" => dictionary! {
                "Font" => dictionary! { "F1" => font_id },
            },
        });
        document.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => vec![page_id.into()],
                "Count" => 1,
            }),
        );
        let catalog_id = document.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        document.trailer.set("Root", catalog_id);
        document.save(path).unwrap();
    }

    #[test]
    fn extracts_spine_order_and_block_text_from_epub() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("book.epub");
        let file = fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = SimpleFileOptions::default();
        let files = [
            ("mimetype", "application/epub+zip"),
            ("META-INF/container.xml", "<?xml version=\"1.0\"?><container xmlns=\"urn:oasis:names:tc:opendocument:xmlns:container\" version=\"1.0\"><rootfiles><rootfile full-path=\"OEBPS/content.opf\" media-type=\"application/oebps-package+xml\"/></rootfiles></container>"),
            ("OEBPS/content.opf", "<?xml version=\"1.0\"?><package xmlns=\"http://www.idpf.org/2007/opf\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" version=\"2.0\" unique-identifier=\"id\"><metadata><dc:identifier id=\"id\">test</dc:identifier><dc:title>Test</dc:title></metadata><manifest><item id=\"c1\" href=\"one.xhtml\" media-type=\"application/xhtml+xml\"/><item id=\"c2\" href=\"two.xhtml\" media-type=\"application/xhtml+xml\"/><item id=\"toc\" href=\"toc.ncx\" media-type=\"application/x-dtbncx+xml\"/></manifest><spine toc=\"toc\"><itemref idref=\"c1\"/><itemref idref=\"c2\"/></spine></package>"),
            ("OEBPS/toc.ncx", "<?xml version=\"1.0\"?><ncx xmlns=\"http://www.daisy.org/z3986/2005/ncx/\" version=\"2005-1\"><navMap><navPoint id=\"n1\" playOrder=\"1\"><navLabel><text>First</text></navLabel><content src=\"one.xhtml\"/></navPoint><navPoint id=\"n2\" playOrder=\"2\"><navLabel><text>Second</text></navLabel><content src=\"two.xhtml\"/></navPoint></navMap></ncx>"),
            ("OEBPS/one.xhtml", "<html><body><h1>First heading</h1><p>One paragraph.</p></body></html>"),
            ("OEBPS/two.xhtml", "<html><body><p>Two paragraph.</p></body></html>"),
        ];
        for (name, contents) in files {
            zip.start_file(name, options).unwrap();
            zip.write_all(contents.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
        let sections = extract_epub(&path).unwrap();
        assert_eq!(sections.len(), 2);
        assert_eq!(sections[0].section_title.as_deref(), Some("First"));
        assert_eq!(sections[0].blocks[1].text, "One paragraph.");
        assert_eq!(sections[1].blocks[0].text, "Two paragraph.");
    }

    #[test]
    fn pdf_page_blocks_keep_blank_line_paragraph_boundaries() {
        let blocks = pdf_page_blocks("First line\nsecond line\n\nThird paragraph");
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].text, "First line second line");
        assert_eq!(blocks[1].text, "Third paragraph");
    }

    #[test]
    fn extracts_text_layer_pdf_as_page_sections() {
        if crate::pdfium::pdfium().is_err() {
            return;
        }
        let directory = tempfile::TempDir::new().unwrap();
        let path = directory.path().join("searchable.pdf");
        write_searchable_pdf(&path);

        let sections = extract_pdf(&path).unwrap();
        assert_eq!(sections.len(), 1);
        assert_eq!(sections[0].section_index, 0);
        assert_eq!(sections[0].section_title.as_deref(), Some("Page 1"));
        assert!(sections[0].blocks[0]
            .text
            .contains("searchable PDF passage"));
    }

    #[test]
    fn identifies_textless_long_pdfs_as_scanned() {
        assert!(is_scanned_pdf(6, 499));
        assert!(!is_scanned_pdf(5, 0));
        assert!(!is_scanned_pdf(6, 500));
    }
}

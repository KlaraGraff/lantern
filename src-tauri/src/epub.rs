use epub::doc::EpubDoc;
use std::path::Path;

use crate::error::{AppError, AppResult};

pub struct EpubMetadata {
    pub title: String,
    pub author: String,
    pub description: Option<String>,
    /// Verbatim `dc:language` (e.g. "en-GB"), unnormalized — the reader
    /// decides later what a region variant means, this layer just carries it.
    pub language: Option<String>,
    pub cover_data: Option<Vec<u8>>,
}

pub fn extract_metadata(epub_path: &Path) -> AppResult<EpubMetadata> {
    let mut doc = EpubDoc::new(epub_path).map_err(|e| AppError::Epub(e.to_string()))?;

    // `dc:title` is spec-required but plenty of real-world EPUBs (scanner
    // exports, pirate sites) ship it empty or leave it out. Previously this
    // fell back to a hardcoded "Untitled", which buried every such book under
    // one indistinguishable name; the source filename at least carries
    // whatever the downloader/scanner named it.
    let title = doc
        .mdata("title")
        .map(|m| m.value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| fallback_title_from_path(epub_path));

    let author = joined_creators(&doc);

    let description = doc.mdata("description").map(|m| m.value.clone());
    let language = doc
        .mdata("language")
        .map(|m| m.value.trim().to_string())
        .filter(|value| !value.is_empty());

    let cover_data = extract_cover(&mut doc);

    Ok(EpubMetadata {
        title,
        author,
        description,
        language,
        cover_data,
    })
}

fn fallback_title_from_path(epub_path: &Path) -> String {
    let stem = epub_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Untitled")
        .trim();
    if stem.is_empty() {
        "Untitled".to_string()
    } else {
        stem.to_string()
    }
}

/// `dc:creator` may repeat once per contributor on a multi-author book, and
/// the `epub` crate exposes every occurrence via `doc.metadata` (`mdata()`
/// only returns the first). EPUB3 lets each occurrence carry a `role`
/// refinement (e.g. `<meta refines="#id" property="role">edt</meta>`) that
/// would let us separate authors from editors/translators, but real-world
/// files are inconsistent about writing one at all — the Standard Ebooks
/// fixture used in this crate's tests doesn't. Rather than silently dropping
/// an unrole'd contributor (which could just as easily be the sole author),
/// every `dc:creator` value is kept and joined, leaving the reader to sort
/// out who's who by name.
fn joined_creators(doc: &EpubDoc<std::io::BufReader<std::fs::File>>) -> String {
    let names: Vec<&str> = doc
        .metadata
        .iter()
        .filter(|item| item.property == "creator")
        .map(|item| item.value.trim())
        .filter(|value| !value.is_empty())
        .collect();
    if names.is_empty() {
        return "Unknown Author".to_string();
    }
    // "、" is the enumeration comma CJK typography uses between names; a
    // Latin-script book wants ", ". Picking by the names themselves rather
    // than by `dc:language` keeps this right on the files that prompted all
    // of this — the ones whose metadata is missing or wrong.
    let separator = if names.iter().any(|name| name.chars().any(is_cjk)) {
        "、"
    } else {
        ", "
    };
    names.join(separator)
}

fn is_cjk(value: char) -> bool {
    matches!(value,
        '\u{4E00}'..='\u{9FFF}'      // CJK unified ideographs
        | '\u{3400}'..='\u{4DBF}'    // extension A
        | '\u{3040}'..='\u{30FF}'    // kana
        | '\u{AC00}'..='\u{D7AF}'    // hangul
    )
}

fn extract_cover(doc: &mut EpubDoc<std::io::BufReader<std::fs::File>>) -> Option<Vec<u8>> {
    let (data, _mime) = resolve_cover_resource(doc)?;
    Some(data)
}

/// Resolve the cover image bytes + mime, walking through fallback
/// strategies. The `epub` crate's `get_cover()` only handles the
/// EPUB3 `properties="cover-image"` form, so books that declare a
/// `version="3.0"` package but use the legacy EPUB2 `<meta
/// name="cover" content="<id>"/>` pointer (common in older trade
/// publishing pipelines) fall through to `None`. We re-implement the
/// EPUB2 fallback here, then try a couple of conventional ids.
fn resolve_cover_resource(
    doc: &mut EpubDoc<std::io::BufReader<std::fs::File>>,
) -> Option<(Vec<u8>, String)> {
    // The crate resolves the declared cover id without checking what the
    // resource is, so an EPUB2 `<meta name="cover">` naming the cover *page*
    // would hand back XHTML bytes as the book's cover. Same rule as the two
    // fallbacks below: only an `image/*` resource is a cover image.
    if let Some(found) = doc.get_cover().filter(is_image_resource) {
        return Some(found);
    }

    // EPUB2-style: `<meta name="cover" content="<manifest-id>"/>`.
    // The crate parses this into a metadata item with property
    // "cover" whose value is the manifest id.
    if let Some(id) = doc.mdata("cover").map(|m| m.value.clone()) {
        if let Some(resource) = doc.get_resource(&id).filter(is_image_resource) {
            return Some(resource);
        }
    }

    // Conventional ids used by various publisher toolchains when
    // neither the EPUB3 property nor the EPUB2 meta hint is present.
    // Filter on the resource's mime type — `id="cover"` in particular
    // commonly points at `cover.xhtml` (the cover *page*) rather than
    // the cover image, and writing XHTML bytes to `<book_id>.jpg`
    // would render as a broken image in the library.
    for id in ["cover-image", "cover", "ci"] {
        if let Some(resource) = doc.get_resource(id).filter(is_image_resource) {
            return Some(resource);
        }
    }

    None
}

fn is_image_resource(resource: &(Vec<u8>, String)) -> bool {
    resource.1.starts_with("image/")
}

pub fn count_chapters(epub_path: &Path) -> AppResult<usize> {
    let doc = EpubDoc::new(epub_path).map_err(|e| AppError::Epub(e.to_string()))?;
    Ok(doc.get_num_chapters())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;
    use zip::write::SimpleFileOptions;

    /// Build an EPUB from `(path, contents)` pairs, mimetype first and stored.
    fn write_epub(dir: &TempDir, name: &str, files: &[(&str, &str)]) -> std::path::PathBuf {
        let path = dir.path().join(name);
        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let stored =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        let deflated = SimpleFileOptions::default();
        zip.start_file("mimetype", stored).unwrap();
        zip.write_all(b"application/epub+zip").unwrap();
        for (entry, contents) in files {
            zip.start_file(*entry, deflated).unwrap();
            zip.write_all(contents.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
        path
    }

    const CONTAINER: &str = "<?xml version=\"1.0\"?><container xmlns=\"urn:oasis:names:tc:opendocument:xmlns:container\" version=\"1.0\"><rootfiles><rootfile full-path=\"OEBPS/content.opf\" media-type=\"application/oebps-package+xml\"/></rootfiles></container>";

    /// An EPUB2 whose `<meta name="cover">` names the cover *page* — an XHTML
    /// document, not an image. Older trade-publishing pipelines ship this shape
    /// routinely, and the two fallback branches in `resolve_cover_resource`
    /// already reject a non-image for exactly this reason.
    #[test]
    fn epub2_cover_meta_naming_an_xhtml_page_is_not_imported_as_an_image() {
        let dir = TempDir::new().unwrap();
        let opf = "<?xml version=\"1.0\"?><package xmlns=\"http://www.idpf.org/2007/opf\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" version=\"2.0\" unique-identifier=\"id\"><metadata><dc:identifier id=\"id\">probe</dc:identifier><dc:title>Probe</dc:title><meta name=\"cover\" content=\"cover-page\"/></metadata><manifest><item id=\"cover-page\" href=\"cover.xhtml\" media-type=\"application/xhtml+xml\"/><item id=\"chapter\" href=\"chapter.xhtml\" media-type=\"application/xhtml+xml\"/></manifest><spine><itemref idref=\"cover-page\"/><itemref idref=\"chapter\"/></spine></package>";
        let path = write_epub(
            &dir,
            "cover-page.epub",
            &[
                ("META-INF/container.xml", CONTAINER),
                ("OEBPS/content.opf", opf),
                (
                    "OEBPS/cover.xhtml",
                    "<html><body><p>cover page</p></body></html>",
                ),
                (
                    "OEBPS/chapter.xhtml",
                    "<html><body><p>chapter</p></body></html>",
                ),
            ],
        );

        let metadata = extract_metadata(&path).unwrap();
        assert_eq!(
            metadata.cover_data, None,
            "an XHTML cover page must not be stored as the cover image"
        );
    }
}

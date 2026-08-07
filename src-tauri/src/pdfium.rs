//! Process-wide PDFium binding.
//!
//! Both the Tauri app and the `lantern mcp` stdio subprocess share the
//! same executable layout, so the same path-resolution logic works in
//! both contexts. The dylib is loaded lazily on first call to `pdfium()`
//! and reused for the lifetime of the process.
//!
//! **PDFium is not thread-safe and this module is what makes it safe to
//! use anyway.** Chromium's own guidance is to parallelize across
//! processes, not threads: the library keeps mutable global state, so two
//! threads inside it at once corrupt each other even when they are working
//! on different documents. Lantern reaches PDFium from several places that
//! genuinely can run at the same time — grounding indexing and difficulty
//! analysis are both scheduled onto the blocking pool the moment a PDF
//! finishes importing, and OCR validation runs on its own thread — so
//! "surely nobody calls it concurrently" is not available to us.
//!
//! `pdfium-render`'s `thread_safe` feature does **not** provide the
//! locking its README describes. As of 0.9.1 the feature expands to
//! nothing but `unsafe impl Send for Pdfium` / `unsafe impl Sync for
//! Pdfium`; the mutex that used to back it was dropped in the 0.9.0
//! lifetime rework and the documentation was not updated. Enabling it
//! therefore *removes* the compiler's objection to sharing the binding
//! across threads without adding anything that makes the sharing sound.
//! Hence [`Serialized`] below.

use std::ops::Deref;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock};

use pdfium_render::prelude::*;

static PDFIUM: OnceLock<Result<Pdfium, String>> = OnceLock::new();

/// Held for the length of a whole document session, not one FFI call.
/// Per-call locking would not be enough: `PdfDocument` owns a live
/// `FPDF_DOCUMENT` handle and every page walk, text read, render and the
/// final drop all re-enter the library, so the exclusive window has to
/// cover the document's entire lifetime.
static IN_USE: Mutex<()> = Mutex::new(());

/// Exclusive access to the process-wide `Pdfium`. Derefs to it, so call
/// sites read the same as before; the difference is that the binding
/// cannot be reached without going through the lock, and `PdfDocument`
/// borrows from this guard, so the compiler refuses any document that
/// would outlive the exclusive window.
pub struct Serialized {
    pdfium: &'static Pdfium,
    // Declared last: fields drop in declaration order, so the lock is
    // released only after `pdfium` is out of the picture.
    _guard: MutexGuard<'static, ()>,
}

impl Deref for Serialized {
    type Target = Pdfium;

    fn deref(&self) -> &Pdfium {
        self.pdfium
    }
}

/// Wait for exclusive use of the process-wide `Pdfium`, or report why the
/// dylib could not be loaded. Callers use this for best-effort cover
/// rendering — on failure, fall back to no cover rather than failing the
/// import.
///
/// Blocks until any other document session finishes. Never call it while
/// already holding a [`Serialized`]: the mutex is not reentrant, so that
/// deadlocks the thread.
pub fn pdfium() -> Result<Serialized, &'static str> {
    let pdfium = binding()?;
    // A poisoned lock means some earlier session panicked mid-document.
    // PDFium's globals are no more suspect than they already were, and
    // refusing every PDF for the rest of the process is a worse outcome
    // than carrying on, so the poison is deliberately ignored.
    let guard = IN_USE.lock().unwrap_or_else(|poison| poison.into_inner());
    Ok(Serialized {
        pdfium,
        _guard: guard,
    })
}

/// Whether the dylib loaded, without queueing for the lock. For probes
/// that only want to know if PDF support exists at all — taking the lock
/// to answer that would make a long extraction elsewhere look like a
/// missing library.
pub fn availability() -> Result<(), &'static str> {
    binding().map(|_| ())
}

fn binding() -> Result<&'static Pdfium, &'static str> {
    let result = PDFIUM.get_or_init(|| {
        let path = locate_pdfium_lib().ok_or_else(|| {
            "could not locate pdfium dylib next to executable or in bundle".to_string()
        })?;
        let bindings = Pdfium::bind_to_library(&path)
            .map_err(|e| format!("Pdfium::bind_to_library({}): {e}", path.display()))?;
        Ok(Pdfium::new(bindings))
    });
    result.as_ref().map_err(|s| s.as_str())
}

fn locate_pdfium_lib() -> Option<PathBuf> {
    let lib_name = Pdfium::pdfium_platform_library_name();

    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            // 1. Alongside the executable. Windows installer, Linux, dev `cargo run`
            //    if the dylib was copied into target/.
            let candidate = exe_dir.join(&lib_name);
            if candidate.exists() {
                return Some(candidate);
            }
            // 2. macOS .app bundle: Contents/MacOS/lantern → Contents/Resources/<lib>
            let bundle_resources = exe_dir.join("..").join("Resources").join(&lib_name);
            if bundle_resources.exists() {
                return Some(bundle_resources);
            }
            // 3. macOS .app bundle alternate: Contents/Frameworks/
            let bundle_frameworks = exe_dir.join("..").join("Frameworks").join(&lib_name);
            if bundle_frameworks.exists() {
                return Some(bundle_frameworks);
            }
        }
    }

    // 4. Dev fallback: build.rs emits PDFIUM_DEV_LIB_PATH pointing at the
    //    binary it downloaded into src-tauri/binaries/<target>/. This is
    //    what cargo test picks up.
    if let Some(dev_path) = option_env!("PDFIUM_DEV_LIB_PATH") {
        let p = PathBuf::from(dev_path);
        if p.exists() {
            return Some(p);
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    /// The property the whole module exists for. Two threads inside PDFium at
    /// once is what took the process down after a PDF import — the grounding
    /// index and the difficulty preview both start reading the same file the
    /// moment the import lands.
    #[test]
    fn no_two_threads_hold_the_binding_at_once() {
        if availability().is_err() {
            return;
        }
        static INSIDE: AtomicUsize = AtomicUsize::new(0);
        static OVERLAPPED: AtomicBool = AtomicBool::new(false);

        let threads: Vec<_> = (0..4)
            .map(|_| {
                std::thread::spawn(|| {
                    for _ in 0..50 {
                        let session = pdfium().expect("the dylib already loaded");
                        if INSIDE.fetch_add(1, Ordering::SeqCst) != 0 {
                            OVERLAPPED.store(true, Ordering::SeqCst);
                        }
                        std::thread::yield_now();
                        INSIDE.fetch_sub(1, Ordering::SeqCst);
                        drop(session);
                    }
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        assert!(!OVERLAPPED.load(Ordering::SeqCst));
    }

    /// Probing for PDF support must not queue behind a long extraction, or a
    /// busy library reads as a missing one.
    #[test]
    fn availability_answers_while_a_session_is_open() {
        let _session = pdfium();
        let probed = std::thread::spawn(availability).join().unwrap();
        assert_eq!(probed.is_ok(), availability().is_ok());
    }
}

//! Normal exit waits for each reader webview's last progress write.
use std::{collections::HashSet, sync::Mutex, time::Duration};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

#[derive(Default)]
pub struct ReaderExit(pub Mutex<ExitState>);

#[derive(Default)]
pub struct ExitState {
    windows: HashSet<String>,
    pending: Option<(u64, HashSet<String>)>,
    next_request: u64,
    exit_code: i32,
    approved: bool,
}

impl ExitState {
    fn acknowledge(&mut self, label: &str, request: u64, saved: bool) -> bool {
        let Some((current, waiting)) = &mut self.pending else {
            return false;
        };
        if *current != request || !waiting.contains(label) {
            return false;
        }
        if !saved {
            self.pending = None;
            return false;
        }
        waiting.remove(label);
        if waiting.is_empty() {
            self.pending = None;
            self.approved = true;
            return true;
        }
        false
    }
}

#[cfg(target_os = "macos")]
pub fn has_reader(app: &AppHandle, label: &str) -> bool {
    app.state::<ReaderExit>()
        .0
        .lock()
        .unwrap()
        .windows
        .contains(label)
}

#[tauri::command]
pub fn reader_exit_register(window: WebviewWindow, state: tauri::State<'_, ReaderExit>) {
    let mut state = state.0.lock().unwrap();
    state.windows.insert(window.label().to_owned());
    // A new session, including one in an already registered window, cannot
    // be covered by acknowledgements from an older reader set.
    state.pending = None;
    state.approved = false;
}

#[tauri::command]
pub fn reader_exit_ack(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, ReaderExit>,
    request: u64,
    saved: bool,
) {
    let (exit, code) = {
        let mut state = state.0.lock().unwrap();
        (
            state.acknowledge(window.label(), request, saved),
            state.exit_code,
        )
    };
    if !saved {
        let _ = window.show();
        let _ = window.set_focus();
    }
    if exit {
        app.exit(code);
    }
}

#[tauri::command]
pub fn reader_close_saved(window: WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    if window.label() == "main" {
        return window.hide().map_err(|e| e.to_string());
    }
    window.destroy().map_err(|e| e.to_string())
}

pub fn destroyed(app: &AppHandle, label: &str) {
    let state_handle = app.state::<ReaderExit>();
    let mut state = state_handle.0.lock().unwrap();
    state.windows.remove(label);
    // Destruction is not a successful save. Cancel the attempt; a later quit
    // will use the remaining live windows instead of waiting on a ghost.
    state.pending = None;
    state.approved = false;
}

pub fn requested(app: &AppHandle, api: &tauri::ExitRequestApi, code: Option<i32>) {
    let (request, windows) = {
        let state_handle = app.state::<ReaderExit>();
        let mut state = state_handle.0.lock().unwrap();
        state
            .windows
            .retain(|label| app.get_webview_window(label).is_some());
        if state.approved || state.windows.is_empty() {
            return;
        }
        api.prevent_exit();
        if state.pending.is_some() {
            return;
        }
        state.exit_code = code.unwrap_or(0);
        state.next_request += 1;
        let request = state.next_request;
        let windows = state.windows.clone();
        state.pending = Some((request, windows.clone()));
        (request, windows)
    };
    for label in windows {
        if let Err(error) = app.emit_to(&label, "reader-exit-requested", request) {
            log::error!("request reader exit save: {error}");
            app.state::<ReaderExit>().0.lock().unwrap().pending = None;
            return;
        }
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(15)).await;
        let expired = {
            let state_handle = app.state::<ReaderExit>();
            let mut state = state_handle.0.lock().unwrap();
            if state.pending.as_ref().is_some_and(|(id, _)| *id == request) {
                state.pending = None;
                true
            } else {
                false
            }
        };
        if expired {
            log::error!("Reader did not acknowledge saving; normal exit cancelled");
            let _ = app.emit("reader-exit-cancelled", request);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    fn waiting() -> ExitState {
        ExitState {
            windows: HashSet::from(["main".into(), "reader-a".into()]),
            pending: Some((1, HashSet::from(["main".into(), "reader-a".into()]))),
            ..Default::default()
        }
    }
    #[test]
    fn requires_every_current_reader() {
        let mut state = waiting();
        assert!(!state.acknowledge("main", 0, true));
        assert!(!state.acknowledge("unknown", 1, true));
        assert!(!state.acknowledge("main", 1, true));
        assert!(!state.approved);
        assert!(state.acknowledge("reader-a", 1, true));
        assert!(state.approved);
    }
    #[test]
    fn failed_save_cancels_without_approving_or_accepting_late_ack() {
        let mut state = waiting();
        assert!(!state.acknowledge("main", 1, false));
        assert!(state.pending.is_none());
        assert!(!state.approved);
        assert!(!state.acknowledge("reader-a", 1, true));
        assert_eq!(state.windows.len(), 2);
    }
}

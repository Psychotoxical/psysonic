use tauri::{AppHandle, Manager};

use super::identity::same_playback_target;
use crate::engine::AudioEngine;

/// Take (consume) completed manual-stream bytes if they correspond to `url`.
pub fn take_stream_completed_for_url(state: &AudioEngine, url: &str) -> Option<Vec<u8>> {
    let mut guard = state.stream_completed_cache.lock().unwrap();
    if guard
        .as_ref()
        .is_some_and(|p| same_playback_target(&p.url, url))
    {
        return guard.take().map(|p| p.data);
    }
    None
}

/// Take (consume) on-disk spill for a completed large ranged stream.
pub fn take_stream_completed_spill_for_url(
    state: &AudioEngine,
    url: &str,
) -> Option<std::path::PathBuf> {
    take_stream_completed_spill_from_slot(&state.stream_completed_spill, url)
}

pub(crate) fn take_stream_completed_spill_from_slot(
    slot: &std::sync::Arc<std::sync::Mutex<Option<crate::state::StreamCompletedSpill>>>,
    url: &str,
) -> Option<std::path::PathBuf> {
    let mut guard = slot.lock().unwrap();
    if guard
        .as_ref()
        .is_some_and(|p| same_playback_target(&p.url, url))
    {
        return guard.take().map(|p| p.path);
    }
    None
}

pub(crate) fn stream_spill_file_paths(
    app: &AppHandle,
    track_id: &str,
) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("stream-spill");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok((
        dir.join(format!("{track_id}.complete")),
        dir.join(format!("{track_id}.complete.part")),
    ))
}

/// Atomically write completed stream bytes under `dir` (`{track_id}.complete.part` → rename).
pub(crate) fn write_stream_spill_bytes_in_dir(
    dir: &std::path::Path,
    track_id: &str,
    bytes: &[u8],
) -> Result<std::path::PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{track_id}.complete"));
    let part = dir.join(format!("{track_id}.complete.part"));
    std::fs::write(&part, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&part, &path).map_err(|e| e.to_string())?;
    Ok(path)
}

/// Atomically write completed stream bytes to app-data `stream-spill/` (sync; no await while holding `buf`).
pub(crate) fn write_stream_spill_file(
    app: &AppHandle,
    track_id: &str,
    bytes: &[u8],
) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("stream-spill");
    write_stream_spill_bytes_in_dir(&dir, track_id, bytes)
}

/// Remove leftover `stream-spill/*.complete*` from prior sessions (best-effort).
pub fn cleanup_orphan_stream_spill_dir(app: &AppHandle) {
    let Ok(dir) = app.path().app_data_dir().map(|d| d.join("stream-spill")) else {
        return;
    };
    if !dir.is_dir() {
        return;
    }
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let lossy = name.to_string_lossy();
        if lossy.ends_with(".complete") || lossy.ends_with(".complete.part") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

pub(crate) fn install_stream_completed_spill_if(
    slot: &std::sync::Arc<std::sync::Mutex<Option<crate::state::StreamCompletedSpill>>>,
    url: String,
    path: std::path::PathBuf,
    should_install: impl FnOnce() -> bool,
) -> bool {
    let mut guard = slot.lock().unwrap();
    if !should_install() {
        drop(guard);
        let _ = std::fs::remove_file(path);
        return false;
    }
    if let Some(old) = guard.take() {
        if old.path != path {
            let _ = std::fs::remove_file(&old.path);
        }
    }
    *guard = Some(crate::state::StreamCompletedSpill { url, path });
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn scratch_dir(label: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "psysonic-audio-spill-{label}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    #[test]
    fn write_stream_spill_bytes_in_dir_creates_complete_file() {
        let dir = scratch_dir("write");
        let path = write_stream_spill_bytes_in_dir(&dir, "track-1", b"hello").expect("write spill");
        assert!(path.exists());
        assert_eq!(std::fs::read(&path).unwrap(), b"hello");
        assert!(!dir.join("track-1.complete.part").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn install_stream_completed_spill_replaces_prior_file() {
        let dir = scratch_dir("install");
        let old_path = dir.join("old.complete");
        let new_path = dir.join("new.complete");
        std::fs::write(&old_path, b"old").unwrap();
        std::fs::write(&new_path, b"new").unwrap();
        let slot: Arc<Mutex<Option<crate::state::StreamCompletedSpill>>> =
            Arc::new(Mutex::new(None));
        assert!(install_stream_completed_spill_if(
            &slot,
            "http://example/a".into(),
            old_path.clone(),
            || true,
        ));
        assert!(install_stream_completed_spill_if(
            &slot,
            "http://example/b".into(),
            new_path.clone(),
            || true,
        ));
        assert!(!old_path.exists(), "previous spill file must be removed");
        assert!(new_path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn conditional_spill_install_rejects_and_removes_candidate() {
        let dir = scratch_dir("conditional-install");
        let path = dir.join("candidate.complete");
        std::fs::write(&path, b"candidate").unwrap();
        let slot: Arc<Mutex<Option<crate::state::StreamCompletedSpill>>> =
            Arc::new(Mutex::new(None));

        assert!(!install_stream_completed_spill_if(
            &slot,
            "http://example/a".into(),
            path.clone(),
            || false,
        ));
        assert!(slot.lock().unwrap().is_none());
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn take_stream_completed_spill_for_url_consumes_slot() {
        let dir = scratch_dir("take");
        let path = dir.join("t.complete");
        std::fs::write(&path, b"x").unwrap();
        let slot: Arc<Mutex<Option<crate::state::StreamCompletedSpill>>> =
            Arc::new(Mutex::new(None));
        let url = "https://server/stream?id=1";
        assert!(install_stream_completed_spill_if(
            &slot,
            url.into(),
            path.clone(),
            || true,
        ));
        let taken = take_stream_completed_spill_from_slot(&slot, url);
        assert_eq!(taken.as_deref(), Some(path.as_path()));
        assert!(take_stream_completed_spill_from_slot(&slot, url).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

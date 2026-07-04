//! Library analysis backfill — native coordinator (advanced analytics strategy).

mod worker;

use std::sync::Arc;

use tauri::{AppHandle, Manager};
use worker::{
    spawn_coordinator, setup_library_sync_idle_listener, LibraryAnalysisBackfillSession,
    LibraryAnalysisBackfillWorker,
};


pub fn init_library_analysis_backfill(app: &AppHandle) -> Result<(), String> {
    let worker = Arc::new(LibraryAnalysisBackfillWorker::new());
    app.manage(worker.clone());
    setup_library_sync_idle_listener(app);
    spawn_coordinator(app, worker);
    Ok(())
}

#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)] // Tauri command surface — args map 1:1 to the JS call (like cover configure + workers).
pub async fn library_analysis_backfill_configure(
    app: AppHandle,
    enabled: bool,
    server_index_key: String,
    library_server_id: String,
    server_url: String,
    username: String,
    password: String,
    workers: u32,
) -> Result<(), String> {
    let worker = app
        .try_state::<Arc<LibraryAnalysisBackfillWorker>>()
        .ok_or_else(|| "library analysis backfill worker not initialized".to_string())?;

    let session = if enabled
        && !server_index_key.is_empty()
        && !library_server_id.is_empty()
        && !server_url.is_empty()
    {
        Some(LibraryAnalysisBackfillSession {
            server_index_key,
            library_server_id,
            server_url,
            username,
            password,
            workers: workers.max(1),
        })
    } else {
        None
    };

    worker
        .set_session(enabled && session.is_some(), session)
        .await;
    Ok(())
}

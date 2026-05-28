//! Library analysis backfill — native coordinator (advanced analytics strategy).

mod worker;

use std::sync::Arc;

use serde::Deserialize;
use tauri::{AppHandle, Manager};
use worker::{
    spawn_coordinator, setup_library_sync_idle_listener, LibraryAnalysisBackfillSession,
    LibraryAnalysisBackfillWorker,
};


#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryAnalysisBackfillConfigureArgs {
    pub enabled: bool,
    pub server_index_key: String,
    pub library_server_id: String,
    pub server_url: String,
    pub username: String,
    pub password: String,
    pub workers: u32,
}

pub fn init_library_analysis_backfill(app: &AppHandle) -> Result<(), String> {
    let worker = Arc::new(LibraryAnalysisBackfillWorker::new());
    app.manage(worker.clone());
    setup_library_sync_idle_listener(app);
    spawn_coordinator(app, worker);
    Ok(())
}

#[tauri::command]
pub async fn library_analysis_backfill_configure(
    app: AppHandle,
    args: LibraryAnalysisBackfillConfigureArgs,
) -> Result<(), String> {
    let worker = app
        .try_state::<Arc<LibraryAnalysisBackfillWorker>>()
        .ok_or_else(|| "library analysis backfill worker not initialized".to_string())?;

    let session = if args.enabled
        && !args.server_index_key.is_empty()
        && !args.library_server_id.is_empty()
        && !args.server_url.is_empty()
    {
        Some(LibraryAnalysisBackfillSession {
            server_index_key: args.server_index_key,
            library_server_id: args.library_server_id,
            server_url: args.server_url,
            username: args.username,
            password: args.password,
            workers: args.workers.max(1),
        })
    } else {
        None
    };

    worker
        .set_session(args.enabled && session.is_some(), session)
        .await;
    Ok(())
}

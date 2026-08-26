use std::time::Duration;

use tauri::{AppHandle, State};

#[derive(Debug, Clone, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisMigrationBatchRequest {
    pub generation: u64,
    pub server_id: String,
    pub step: psysonic_analysis::analysis_cache::AnalysisMigrationStep,
    pub cursor_rowid: i64,
    pub upper_rowid: i64,
    pub limit: Option<u32>,
}

#[tauri::command]
#[specta::specta]
pub async fn library_migration_begin(
    app: AppHandle,
    runtime: State<'_, psysonic_library::LibraryRuntime>,
    analysis_cache: State<'_, psysonic_analysis::analysis_cache::AnalysisCache>,
    server_ids: Vec<String>,
) -> Result<u64, String> {
    let already_active = matches!(
        runtime.inspect_migration_generation()?,
        psysonic_library::runtime::MigrationGenerationSnapshotDto::Active { .. }
    );
    let generation = runtime.begin_migration_generation(server_ids).await?;
    let activation = async {
        psysonic_syncfs::activate_filesystem_migration_generation(generation).await?;
        crate::cover_cache::quiesce_for_migration(&app, Duration::from_secs(120)).await?;
        analysis_cache.drain_migration_writes(generation)?;
        psysonic_analysis::analysis_runtime::quiesce_analysis_for_migration(
            Duration::from_secs(120),
        )
        .await?;
        analysis_cache.drain_migration_writes(generation)?;
        Ok::<(), String>(())
    }
    .await;
    if let Err(error) = activation {
        if !already_active {
            crate::cover_cache::release_migration_hold(&app);
            let _ = psysonic_syncfs::deactivate_filesystem_migration_generation(generation);
            let _ = runtime.rollback_migration_generation_start(generation);
        }
        return Err(error);
    }
    Ok(generation)
}

#[tauri::command]
#[specta::specta]
pub fn library_migration_release(
    app: AppHandle,
    runtime: State<'_, psysonic_library::LibraryRuntime>,
    generation: u64,
) -> Result<(), String> {
    runtime.release_migration_generation(generation)?;
    crate::cover_cache::release_migration_hold(&app);
    psysonic_syncfs::deactivate_filesystem_migration_generation(generation)?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn library_migration_analysis_upper_rowid(
    runtime: State<'_, psysonic_library::LibraryRuntime>,
    analysis_cache: State<'_, psysonic_analysis::analysis_cache::AnalysisCache>,
    generation: u64,
    server_id: String,
    step: psysonic_analysis::analysis_cache::AnalysisMigrationStep,
) -> Result<i64, String> {
    let server_id = server_id.trim();
    runtime.ensure_migration_phase(
        generation,
        server_id,
        psysonic_library::runtime::MigrationPhase::Analysis,
    )?;
    analysis_cache.migration_upper_rowid(server_id, step)
}

#[tauri::command]
#[specta::specta]
pub fn library_migration_analysis_batch(
    runtime: State<'_, psysonic_library::LibraryRuntime>,
    analysis_cache: State<'_, psysonic_analysis::analysis_cache::AnalysisCache>,
    request: AnalysisMigrationBatchRequest,
) -> Result<psysonic_analysis::analysis_cache::AnalysisMigrationBatchDto, String> {
    let server_id = request.server_id.trim();
    runtime.ensure_migration_phase(
        request.generation,
        server_id,
        psysonic_library::runtime::MigrationPhase::Analysis,
    )?;
    psysonic_analysis::analysis_cache::AnalysisCache::scope_migration_write_generation_sync(
        request.generation,
        || {
            analysis_cache.migration_run_batch(
                server_id,
                request.step,
                request.cursor_rowid,
                request.upper_rowid,
                request.limit.unwrap_or(2_000),
            )
        },
    )
}

#[tauri::command]
#[specta::specta]
pub fn library_migration_analysis_finalize(
    runtime: State<'_, psysonic_library::LibraryRuntime>,
    analysis_cache: State<'_, psysonic_analysis::analysis_cache::AnalysisCache>,
    generation: u64,
    server_id: String,
) -> Result<psysonic_analysis::analysis_cache::AnalysisMigrationFinalizeDto, String> {
    let server_id = server_id.trim();
    runtime.ensure_migration_phase(
        generation,
        server_id,
        psysonic_library::runtime::MigrationPhase::Analysis,
    )?;
    psysonic_analysis::analysis_cache::AnalysisCache::scope_migration_write_generation_sync(
        generation,
        || analysis_cache.migration_finalize(server_id),
    )
}

#[tauri::command]
#[specta::specta]
pub fn library_migration_verify(
    runtime: State<'_, psysonic_library::LibraryRuntime>,
    analysis_cache: State<'_, psysonic_analysis::analysis_cache::AnalysisCache>,
    generation: u64,
    server_id: String,
) -> Result<(), String> {
    let server_id = server_id.trim();
    runtime.ensure_migration_phase(
        generation,
        server_id,
        psysonic_library::runtime::MigrationPhase::Cleanup,
    )?;
    psysonic_library::navidrome_native_migration::verify(&runtime.store, server_id)?;
    analysis_cache.migration_verify(server_id)
}

#[tauri::command]
#[specta::specta]
pub async fn library_migration_inventory(
    app: AppHandle,
    runtime: State<'_, psysonic_library::LibraryRuntime>,
    analysis_cache: State<'_, psysonic_analysis::analysis_cache::AnalysisCache>,
    server_id: String,
    server_index_key: String,
    custom_offline_dir: Option<String>,
    custom_hot_cache_dir: Option<String>,
) -> Result<(), String> {
    let server_id = server_id.trim();
    let server_index_key = server_index_key.trim();
    psysonic_library::navidrome_native_migration::verify(&runtime.store, server_id)?;
    analysis_cache.migration_verify(server_id)?;
    crate::cover_cache::verify_navidrome_cover_ids(&app, server_index_key).await?;
    psysonic_syncfs::cache::id_migration::verify_navidrome_filesystem_ids(
        &app,
        server_index_key,
        custom_offline_dir,
        custom_hot_cache_dir,
    )
    .await
}

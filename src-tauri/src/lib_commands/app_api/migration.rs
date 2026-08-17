use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use tauri::{AppHandle, Emitter, Manager};

mod analysis;
mod files;
mod library;
mod rewrite;

use analysis::run_analysis_import;
use files::{
    health_check, migration_paths, open_readonly, remove_db_with_sidecars, restore_backup,
    switch_file,
};
use library::run_library_import;
use rewrite::{count_rows_eq, inspect_tables, normalize_mappings};

#[derive(Clone, Copy)]
struct ScopedTable {
    table: &'static str,
    column: &'static str,
}

const LIBRARY_TABLES: &[ScopedTable] = &[
    ScopedTable {
        table: "track_extension",
        column: "server_id",
    },
    ScopedTable {
        table: "track_fact",
        column: "server_id",
    },
    ScopedTable {
        table: "track_artifact",
        column: "server_id",
    },
    ScopedTable {
        table: "track_canonical_link",
        column: "server_id",
    },
    ScopedTable {
        table: "track_id_history",
        column: "server_id",
    },
    ScopedTable {
        table: "play_session",
        column: "server_id",
    },
    ScopedTable {
        table: "track_offline",
        column: "server_id",
    },
    ScopedTable {
        table: "track_genre",
        column: "server_id",
    },
    ScopedTable {
        table: "artist_artwork_lookup",
        column: "server_id",
    },
    ScopedTable {
        table: "library_tag_state",
        column: "server_id",
    },
    ScopedTable {
        table: "library_tag_cursor",
        column: "server_id",
    },
    ScopedTable {
        table: "entity_user_rating",
        column: "server_id",
    },
    ScopedTable {
        table: "album_browse_projection",
        column: "server_id",
    },
    ScopedTable {
        table: "composer_album_projection",
        column: "server_id",
    },
    ScopedTable {
        table: "canonical_enrichment_link",
        column: "owner_server_id",
    },
    ScopedTable {
        table: "track",
        column: "server_id",
    },
    ScopedTable {
        table: "album",
        column: "server_id",
    },
    ScopedTable {
        table: "artist",
        column: "server_id",
    },
    ScopedTable {
        table: "sync_state",
        column: "server_id",
    },
];

const ANALYSIS_TABLES: &[ScopedTable] = &[
    ScopedTable {
        table: "analysis_track",
        column: "server_id",
    },
    ScopedTable {
        table: "waveform_cache",
        column: "server_id",
    },
    ScopedTable {
        table: "loudness_cache",
        column: "server_id",
    },
];

fn migration_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ServerIndexMapping {
    pub legacy_id: String,
    pub index_key: String,
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MigrationScopeInspect {
    pub total_legacy_rows: u64,
    pub skipped_unknown_server_rows: u64,
    pub tables: HashMap<String, u64>,
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MigrationInspectReport {
    pub needs_migration: bool,
    pub has_skipped_unknown_server_rows: bool,
    pub can_run: bool,
    pub warnings: Vec<String>,
    pub unmapped_empty_bucket: bool,
    pub library: MigrationScopeInspect,
    pub analysis: MigrationScopeInspect,
    pub mappings: Vec<ServerIndexMapping>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationProgressEvent {
    pub stage: String,
    pub table: String,
    pub done: u64,
    pub total: u64,
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MigrationRunScope {
    pub imported_rows: u64,
    pub source_rows: u64,
    pub skipped_unknown_server_rows: u64,
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MigrationRunResult {
    pub library: MigrationRunScope,
    pub analysis: MigrationRunScope,
    pub has_skipped_unknown_server_rows: bool,
    pub switched: bool,
    pub backup_removed: bool,
}

#[tauri::command]
#[specta::specta]
pub fn migration_inspect(
    app: AppHandle,
    mappings: Vec<ServerIndexMapping>,
) -> Result<MigrationInspectReport, String> {
    inspect_internal(&app, mappings)
}

#[tauri::command]
#[specta::specta]
pub async fn migration_run(
    app: AppHandle,
    mappings: Vec<ServerIndexMapping>,
) -> Result<MigrationRunResult, String> {
    let barrier = match app.try_state::<psysonic_library::LibraryRuntime>() {
        Some(runtime) => Some(runtime.cancel_and_drain_sync(None, None).await?),
        None => None,
    };
    tauri::async_runtime::spawn_blocking(move || {
        let _barrier = barrier;
        let _guard = migration_lock()
            .lock()
            .map_err(|_| "migration lock poisoned".to_string())?;
        run_internal(&app, mappings)
    })
    .await
    .map_err(|e| format!("migration worker failed: {e}"))?
}

fn inspect_internal(
    app: &AppHandle,
    mappings: Vec<ServerIndexMapping>,
) -> Result<MigrationInspectReport, String> {
    let normalized = normalize_mappings(mappings);
    let legacy_ids: Vec<String> = normalized.iter().map(|m| m.legacy_id.clone()).collect();
    let index_keys: Vec<String> = normalized.iter().map(|m| m.index_key.clone()).collect();
    let paths = migration_paths(app)?;

    let (library_tables, library_total, library_skipped_unknown_rows) = inspect_tables(
        &paths.library_active,
        LIBRARY_TABLES,
        &legacy_ids,
        &index_keys,
    )?;
    let (analysis_tables, mut analysis_total, analysis_skipped_unknown_rows) = inspect_tables(
        &paths.analysis_active,
        ANALYSIS_TABLES,
        &legacy_ids,
        &index_keys,
    )?;
    let mut analysis_tables = analysis_tables;
    let mut warnings = Vec::new();
    let mut unmapped_empty_bucket = false;
    let mut has_empty_bucket_rows = false;
    if paths.analysis_active.exists() {
        let conn = open_readonly(&paths.analysis_active)?;
        for table in ANALYSIS_TABLES {
            let empty_count = count_rows_eq(&conn, *table, "")?;
            if empty_count > 0 {
                has_empty_bucket_rows = true;
                if normalized.len() == 1 {
                    let entry = analysis_tables.entry(table.table.to_string()).or_insert(0);
                    *entry = entry.saturating_add(empty_count as u64);
                    analysis_total = analysis_total.saturating_add(empty_count as u64);
                }
            }
        }
        if normalized.len() > 1 && has_empty_bucket_rows {
            unmapped_empty_bucket = true;
            warnings.push("analysis empty server bucket kept for multi-server install".to_string());
        }
    }

    let needs_migration = library_total > 0 || analysis_total > 0;
    let can_run = !normalized.is_empty();
    if needs_migration && !can_run {
        warnings.push("no server mappings available".to_string());
    }
    let has_skipped_unknown_server_rows =
        library_skipped_unknown_rows > 0 || analysis_skipped_unknown_rows > 0;
    if has_skipped_unknown_server_rows {
        warnings.push("rows for removed servers were skipped".to_string());
    }

    Ok(MigrationInspectReport {
        needs_migration,
        has_skipped_unknown_server_rows,
        can_run,
        warnings,
        unmapped_empty_bucket,
        library: MigrationScopeInspect {
            total_legacy_rows: library_total,
            skipped_unknown_server_rows: library_skipped_unknown_rows,
            tables: library_tables,
        },
        analysis: MigrationScopeInspect {
            total_legacy_rows: analysis_total,
            skipped_unknown_server_rows: analysis_skipped_unknown_rows,
            tables: analysis_tables,
        },
        mappings: normalized,
    })
}

fn run_internal(
    app: &AppHandle,
    mappings: Vec<ServerIndexMapping>,
) -> Result<MigrationRunResult, String> {
    let inspect = inspect_internal(app, mappings)?;
    if !inspect.needs_migration {
        return Ok(MigrationRunResult {
            library: MigrationRunScope {
                imported_rows: 0,
                source_rows: 0,
                skipped_unknown_server_rows: inspect.library.skipped_unknown_server_rows,
            },
            analysis: MigrationRunScope {
                imported_rows: 0,
                source_rows: 0,
                skipped_unknown_server_rows: inspect.analysis.skipped_unknown_server_rows,
            },
            has_skipped_unknown_server_rows: inspect.has_skipped_unknown_server_rows,
            switched: false,
            backup_removed: false,
        });
    }
    if !inspect.can_run {
        return Err("migration requires at least one server mapping".to_string());
    }

    let paths = migration_paths(app)?;
    let mappings = inspect.mappings;
    let single_mapping = if mappings.len() == 1 {
        Some(mappings[0].index_key.clone())
    } else {
        None
    };

    emit_progress(app, "library", "prepare", 0, LIBRARY_TABLES.len() as u64)?;
    let (library_source_rows, library_imported_rows, library_skipped_unknown_rows) =
        run_library_import(app, &paths, &mappings)?;
    let (analysis_source_rows, analysis_imported_rows, analysis_skipped_unknown_rows) =
        run_analysis_import(app, &paths, &mappings, single_mapping.as_deref())?;

    let mut backup_removed = false;
    let mut library_backup: Option<PathBuf> = None;
    let mut analysis_backup: Option<PathBuf> = None;

    if paths.library_v2.exists() {
        if let Some(runtime) = app.try_state::<psysonic_library::LibraryRuntime>() {
            library_backup = runtime
                .store
                .swap_database_file(&paths.library_active, &paths.library_v2)?;
        } else {
            library_backup = Some(switch_file(&paths.library_active, &paths.library_v2)?);
        }
    }
    if paths.analysis_v2.exists() {
        let switch_result = if let Some(cache) =
            app.try_state::<psysonic_analysis::analysis_cache::AnalysisCache>()
        {
            cache.swap_database_file(&paths.analysis_active, &paths.analysis_v2)
        } else {
            switch_file(&paths.analysis_active, &paths.analysis_v2).map(Some)
        };
        match switch_result {
            Ok(backup) => analysis_backup = backup,
            Err(err) => {
                let mut rollback_errors = Vec::new();
                if let Some(ref backup) = library_backup {
                    if let Some(runtime) = app.try_state::<psysonic_library::LibraryRuntime>() {
                        if let Err(rollback) = runtime
                            .store
                            .restore_database_backup(backup, &paths.library_active)
                            .and_then(|_| runtime.store.verify_operational_schema())
                        {
                            rollback_errors.push(format!("library rollback failed: {rollback}"));
                        }
                    } else {
                        if let Err(rollback) = restore_backup(backup, &paths.library_active) {
                            rollback_errors.push(format!("library rollback failed: {rollback}"));
                        }
                    }
                }
                if let Some(cache) =
                    app.try_state::<psysonic_analysis::analysis_cache::AnalysisCache>()
                {
                    if let Err(rollback) = cache.verify_operational_schema() {
                        rollback_errors.push(format!("analysis rollback failed: {rollback}"));
                    }
                }
                if !rollback_errors.is_empty() {
                    return Err(format!(
                        "analysis switch failed: {err}; {}",
                        rollback_errors.join("; ")
                    ));
                }
                return Err(err);
            }
        }
    }
    let switched = library_backup.is_some() || analysis_backup.is_some();

    if let Err(err) = health_check(app, &paths.library_active, &paths.analysis_active) {
        if let Some(ref backup) = library_backup {
            if let Some(runtime) = app.try_state::<psysonic_library::LibraryRuntime>() {
                let _ = runtime
                    .store
                    .restore_database_backup(backup, &paths.library_active);
            } else {
                let _ = restore_backup(backup, &paths.library_active);
            }
        }
        if let Some(ref backup) = analysis_backup {
            if let Some(cache) = app.try_state::<psysonic_analysis::analysis_cache::AnalysisCache>()
            {
                let _ = cache.restore_database_backup(backup, &paths.analysis_active);
            } else {
                let _ = restore_backup(backup, &paths.analysis_active);
            }
        }
        return Err(err);
    }

    if let Some(backup) = library_backup {
        remove_db_with_sidecars(&backup)?;
        backup_removed = true;
    }
    if let Some(backup) = analysis_backup {
        remove_db_with_sidecars(&backup)?;
        backup_removed = true;
    }

    Ok(MigrationRunResult {
        library: MigrationRunScope {
            imported_rows: library_imported_rows,
            source_rows: library_source_rows,
            skipped_unknown_server_rows: library_skipped_unknown_rows,
        },
        analysis: MigrationRunScope {
            imported_rows: analysis_imported_rows,
            source_rows: analysis_source_rows,
            skipped_unknown_server_rows: analysis_skipped_unknown_rows,
        },
        has_skipped_unknown_server_rows: library_skipped_unknown_rows > 0
            || analysis_skipped_unknown_rows > 0,
        switched,
        backup_removed,
    })
}

fn emit_progress(
    app: &AppHandle,
    stage: &str,
    table: &str,
    done: u64,
    total: u64,
) -> Result<(), String> {
    app.emit(
        "migration:progress",
        MigrationProgressEvent {
            stage: stage.to_string(),
            table: table.to_string(),
            done,
            total,
        },
    )
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests;

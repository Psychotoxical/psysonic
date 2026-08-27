use std::fs;
use std::path::{Path, PathBuf};

use psysonic_core::database_pair_admission::database_pair_write_scope;
use rusqlite::{Connection, OpenFlags};
use tauri::{AppHandle, Manager};

mod recovery;
mod full_import_recovery;

pub(super) use recovery::cleanup_database_paths;
pub(crate) use full_import_recovery::FullImportRecoveryStatusDto;
use full_import_recovery::{
    commit_full_import_recovery, finalize_full_import_recovery, inspect_full_import_recovery,
    lock_full_import_recovery, prepare_full_import_recovery, recover_full_import_databases_with,
    FullImportRecoveryPaths,
};
use recovery::{
    combine_results, copy_database_artifact, finalize_import_backups_or_rollback_with,
    next_recovery_path, restore_database_pair_with,
};

pub(super) fn library_db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let dir = base.join("databases").join("library");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("library.sqlite"))
}

pub(super) fn analysis_db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let dir = base.join("databases").join("analysis");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("audio-analysis.sqlite"))
}

fn full_import_recovery_paths(app: &AppHandle) -> Result<FullImportRecoveryPaths, String> {
    let base = app.path().app_data_dir().map_err(|error| error.to_string())?;
    Ok(FullImportRecoveryPaths::new(&base))
}

pub(super) fn vacuum_copy(source: &Path, destination: &Path) -> Result<(), String> {
    let conn = Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|e| e.to_string())?;
    let escaped = destination.to_string_lossy().replace('\'', "''");
    let sql = format!("VACUUM INTO '{escaped}';");
    conn.execute_batch(&sql).map_err(|e| e.to_string())
}

fn validate_sqlite_file(path: &Path) -> Result<(), String> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| e.to_string())?;
    let integrity: String = conn
        .query_row("PRAGMA integrity_check;", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    if integrity != "ok" {
        return Err("backup file integrity check failed".to_string());
    }
    Ok(())
}

fn migration_head(path: &Path, database_name: &str) -> Result<i64, String> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("{database_name} database open failed: {e}"))?;
    conn.query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
        row.get::<_, Option<i64>>(0)
    })
    .map_err(|e| format!("{database_name} migration history unavailable: {e}"))?
    .ok_or_else(|| format!("{database_name} migration history is empty"))
}

pub(super) fn validate_import_database(
    path: &Path,
    database_name: &str,
    minimum_compatible_version: i64,
    current_version: i64,
) -> Result<(), String> {
    validate_sqlite_file(path)?;
    let head = migration_head(path, database_name)?;
    if head < minimum_compatible_version {
        return Err(format!(
            "{database_name} backup schema {head} is older than minimum compatible schema {minimum_compatible_version}"
        ));
    }
    if head > current_version {
        return Err(format!(
            "{database_name} backup schema {head} is newer than supported schema {current_version}"
        ));
    }
    Ok(())
}

pub(super) fn import_databases_from_sqlite(
    app: &AppHandle,
    import_library_tmp: &Path,
    import_analysis_tmp: &Path,
    durable_full_import_recovery: bool,
    migration_generation: u64,
) -> Result<(), String> {
    let active_path = library_db_path(app)?;
    let analysis_active_path = analysis_db_path(app)?;
    let Some(runtime) = app.try_state::<psysonic_library::LibraryRuntime>() else {
        return match cleanup_database_paths(&[import_library_tmp, import_analysis_tmp]) {
            Ok(()) => Err("library runtime unavailable".to_string()),
            Err(cleanup_error) => Err(format!(
                "library runtime unavailable; staged database cleanup failed: {cleanup_error}"
            )),
        };
    };
    let Some(cache) = app.try_state::<psysonic_analysis::analysis_cache::AnalysisCache>() else {
        return match cleanup_database_paths(&[import_library_tmp, import_analysis_tmp]) {
            Ok(()) => Err("analysis runtime unavailable".to_string()),
            Err(cleanup_error) => Err(format!(
                "analysis runtime unavailable; staged database cleanup failed: {cleanup_error}"
            )),
        };
    };

    let _full_import_guard = lock_full_import_recovery()?;
    let _pair_scope = database_pair_write_scope();
    if durable_full_import_recovery {
        prepare_full_import_recovery(
            &full_import_recovery_paths(app)?,
            &active_path,
            &analysis_active_path,
            migration_generation,
        )?;
    }

    let library_backup = runtime
        .store
        .swap_database_file(&active_path, import_library_tmp)?
        .ok_or_else(|| "import switch failed".to_string())?;
    let analysis_backup = match cache.swap_database_file(&analysis_active_path, import_analysis_tmp)
    {
        Ok(Some(backup)) => backup,
        Ok(None) => {
            let rollback = rollback_after_analysis_switch_failure(
                &runtime,
                &cache,
                &library_backup,
                &active_path,
            );
            return finish_failed_analysis_switch(
                "analysis import switch failed".to_string(),
                rollback,
                import_library_tmp,
                import_analysis_tmp,
            );
        }
        Err(err) => {
            let rollback = rollback_after_analysis_switch_failure(
                &runtime,
                &cache,
                &library_backup,
                &active_path,
            );
            return finish_failed_analysis_switch(
                err,
                rollback,
                import_library_tmp,
                import_analysis_tmp,
            );
        }
    };

    let reopened_health = verify_database_pair_within_pair_scope(&runtime, &cache);
    if let Err(err) = reopened_health {
        return match restore_database_pair_within_pair_scope(
            &runtime,
            &cache,
            &[library_backup.as_path()],
            &[analysis_backup.as_path()],
            &active_path,
            &analysis_active_path,
        ) {
            Ok(()) => Err(format!(
                "imported database health check failed: {err}; previous database pair restored and verified"
            )),
            Err(rollback_error) => Err(format!(
                "imported database health check failed: {err}; paired rollback failed: {rollback_error}"
            )),
        };
    }

    let library_bak_path = active_path.with_file_name("library.sqlite.import.bak");
    let analysis_bak_path = analysis_active_path.with_file_name("audio-analysis.sqlite.import.bak");
    finalize_import_backups_or_rollback_with(
        &library_backup,
        &analysis_backup,
        &library_bak_path,
        &analysis_bak_path,
        import_library_tmp,
        import_analysis_tmp,
        &active_path,
        &analysis_active_path,
        |_| Ok(()),
        |backup, active| runtime.store.restore_database_backup(backup, active),
        |backup, active| cache.restore_database_backup(backup, active),
        || verify_database_pair_within_pair_scope(&runtime, &cache),
    )
}

pub(super) fn inspect_full_import_recovery_for_app(
    app: &AppHandle,
) -> Result<Option<FullImportRecoveryStatusDto>, String> {
    let _guard = lock_full_import_recovery()?;
    inspect_full_import_recovery(&full_import_recovery_paths(app)?)
}

pub(super) fn recover_full_import_databases(
    app: &AppHandle,
) -> Result<(), String> {
    let _guard = lock_full_import_recovery()?;
    let _pair_scope = database_pair_write_scope();
    let active_library = library_db_path(app)?;
    let active_analysis = analysis_db_path(app)?;
    let runtime = app
        .try_state::<psysonic_library::LibraryRuntime>()
        .ok_or_else(|| "library runtime unavailable".to_string())?;
    let cache = app
        .try_state::<psysonic_analysis::analysis_cache::AnalysisCache>()
        .ok_or_else(|| "analysis runtime unavailable".to_string())?;
    recover_full_import_databases_with(
        &full_import_recovery_paths(app)?,
        &active_library,
        &active_analysis,
        |backup, active| runtime.store.restore_database_backup(backup, active),
        |backup, active| cache.restore_database_backup(backup, active),
        || verify_database_pair_within_pair_scope(&runtime, &cache),
    )
}

pub(super) fn finalize_full_import_recovery_for_app(app: &AppHandle) -> Result<(), String> {
    let _guard = lock_full_import_recovery()?;
    let active_library = library_db_path(app)?;
    let active_analysis = analysis_db_path(app)?;
    finalize_full_import_recovery(
        &full_import_recovery_paths(app)?,
        &[
            active_library.with_file_name("library.sqlite.import.bak").as_path(),
            active_analysis
                .with_file_name("audio-analysis.sqlite.import.bak")
                .as_path(),
        ],
    )
}

pub(super) fn commit_imported_databases(app: &AppHandle) -> Result<(), String> {
    let _guard = lock_full_import_recovery()?;
    let active_library = library_db_path(app)?;
    let active_analysis = analysis_db_path(app)?;
    commit_full_import_recovery(
        &full_import_recovery_paths(app)?,
        &[
            active_library.with_file_name("library.sqlite.import.bak").as_path(),
            active_analysis
                .with_file_name("audio-analysis.sqlite.import.bak")
                .as_path(),
        ],
    )
}

pub(super) fn restore_database_pair(
    runtime: &psysonic_library::LibraryRuntime,
    cache: &psysonic_analysis::analysis_cache::AnalysisCache,
    library_backups: &[&Path],
    analysis_backups: &[&Path],
    active_library: &Path,
    active_analysis: &Path,
) -> Result<(), String> {
    let _full_import_guard = lock_full_import_recovery()?;
    let _pair_scope = database_pair_write_scope();
    restore_database_pair_within_pair_scope(
        runtime,
        cache,
        library_backups,
        analysis_backups,
        active_library,
        active_analysis,
    )
}

fn restore_database_pair_within_pair_scope(
    runtime: &psysonic_library::LibraryRuntime,
    cache: &psysonic_analysis::analysis_cache::AnalysisCache,
    library_backups: &[&Path],
    analysis_backups: &[&Path],
    active_library: &Path,
    active_analysis: &Path,
) -> Result<(), String> {
    restore_database_pair_with(
        library_backups,
        analysis_backups,
        active_library,
        active_analysis,
        |backup, active| runtime.store.restore_database_backup(backup, active),
        |backup, active| cache.restore_database_backup(backup, active),
        || verify_database_pair_within_pair_scope(runtime, cache),
    )
}

fn verify_database_pair_within_pair_scope(
    runtime: &psysonic_library::LibraryRuntime,
    cache: &psysonic_analysis::analysis_cache::AnalysisCache,
) -> Result<(), String> {
    let library = runtime.store.verify_operational_schema();
    let analysis = cache.verify_operational_schema();
    combine_results(
        "database pair verification",
        &[("library", &library), ("analysis", &analysis)],
    )
}

fn rollback_after_analysis_switch_failure(
    runtime: &psysonic_library::LibraryRuntime,
    cache: &psysonic_analysis::analysis_cache::AnalysisCache,
    library_backup: &Path,
    active_library: &Path,
) -> Result<(), String> {
    let library_work = next_recovery_path(active_library, "analysis-switch-old-work");
    let library_restore = copy_database_artifact(&[library_backup], &library_work)
        .and_then(|_| runtime.store.restore_database_backup(&library_work, active_library));
    let library_verify = runtime.store.verify_operational_schema();
    let analysis_verify = cache.verify_operational_schema();
    let rollback = combine_results(
        "rollback after analysis switch failure",
        &[
            ("library restore", &library_restore),
            ("library verification", &library_verify),
            ("analysis verification", &analysis_verify),
        ],
    );
    match rollback {
        Ok(()) => cleanup_database_paths(&[library_backup, &library_work]).map_err(|error| {
            format!(
                "previous library database restored and both databases verified, but recovery cleanup failed: {error}"
            )
        }),
        Err(error) => Err(format!(
            "{error}; library backup retained at {}; recovery work retained at {}",
            library_backup.display(),
            library_work.display()
        )),
    }
}

fn finish_failed_analysis_switch(
    switch_error: String,
    rollback: Result<(), String>,
    import_library_tmp: &Path,
    import_analysis_tmp: &Path,
) -> Result<(), String> {
    match rollback {
        Ok(()) => match cleanup_database_paths(&[import_library_tmp, import_analysis_tmp]) {
            Ok(()) => Err(switch_error),
            Err(cleanup_error) => Err(format!(
                "{switch_error}; previous library database restored and both databases verified; staged database cleanup failed: {cleanup_error}"
            )),
        },
        Err(rollback_error) => Err(format!(
            "{switch_error}; rollback after analysis switch failed: {rollback_error}"
        )),
    }
}

pub(super) fn remove_db_with_sidecars(path: &Path) -> Result<(), String> {
    remove_if_exists(path)?;
    for suffix in ["-wal", "-shm"] {
        let sidecar = PathBuf::from(format!("{}{}", path.to_string_lossy(), suffix));
        remove_if_exists(&sidecar)?;
    }
    Ok(())
}

fn move_sidecar(from_base: &Path, to_base: &Path, suffix: &str) -> Result<(), String> {
    let from = PathBuf::from(format!("{}{}", from_base.display(), suffix));
    if !from.exists() {
        return Ok(());
    }
    let to = PathBuf::from(format!("{}{}", to_base.display(), suffix));
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::rename(from, to).map_err(|e| e.to_string())
}

pub(super) fn remove_if_exists(path: &Path) -> Result<(), String> {
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;

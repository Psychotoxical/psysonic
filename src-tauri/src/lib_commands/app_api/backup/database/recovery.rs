use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use super::{move_sidecar, remove_db_with_sidecars, vacuum_copy};

static RECOVERY_ATTEMPT: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum BackupFinalizationStage {
    Library,
    Analysis,
}

#[allow(clippy::too_many_arguments)]
pub(super) fn finalize_import_backups_or_rollback_with<
    BeforeStage,
    RestoreLibrary,
    RestoreAnalysis,
    Verify,
>(
    library_backup: &Path,
    analysis_backup: &Path,
    library_final: &Path,
    analysis_final: &Path,
    import_library_tmp: &Path,
    import_analysis_tmp: &Path,
    active_library: &Path,
    active_analysis: &Path,
    mut before_stage: BeforeStage,
    restore_library: RestoreLibrary,
    restore_analysis: RestoreAnalysis,
    verify_pair: Verify,
) -> Result<(), String>
where
    BeforeStage: FnMut(BackupFinalizationStage) -> Result<(), String>,
    RestoreLibrary: FnMut(&Path, &Path) -> Result<(), String>,
    RestoreAnalysis: FnMut(&Path, &Path) -> Result<(), String>,
    Verify: FnMut() -> Result<(), String>,
{
    let finalization = (|| {
        cleanup_database_paths(&[library_final, analysis_final])?;
        before_stage(BackupFinalizationStage::Library)?;
        move_database_artifact(library_backup, library_final)?;
        before_stage(BackupFinalizationStage::Analysis)?;
        move_database_artifact(analysis_backup, analysis_final)?;
        cleanup_database_paths(&[import_library_tmp, import_analysis_tmp])
    })();

    let Err(finalization_error) = finalization else {
        return Ok(());
    };

    let rollback = restore_database_pair_with(
        &[library_backup, library_final],
        &[analysis_backup, analysis_final],
        active_library,
        active_analysis,
        restore_library,
        restore_analysis,
        verify_pair,
    );
    match rollback {
        Ok(()) => {
            let staging_cleanup =
                cleanup_database_paths(&[import_library_tmp, import_analysis_tmp]);
            match staging_cleanup {
                Ok(()) => Err(format!(
                    "import rollback-backup finalization failed: {finalization_error}; previous database pair restored and verified"
                )),
                Err(cleanup_error) => Err(format!(
                    "import rollback-backup finalization failed: {finalization_error}; previous database pair restored and verified; staging cleanup failed: {cleanup_error}"
                )),
            }
        }
        Err(rollback_error) => Err(format!(
            "import rollback-backup finalization failed: {finalization_error}; paired rollback failed: {rollback_error}"
        )),
    }
}

fn move_database_artifact(from: &Path, to: &Path) -> Result<(), String> {
    if !from.exists() {
        return Err(format!("database backup is missing: {}", from.display()));
    }
    fs::rename(from, to).map_err(|error| {
        format!(
            "database backup rename {} -> {} failed: {error}",
            from.display(),
            to.display()
        )
    })?;
    move_sidecar(from, to, "-wal")?;
    move_sidecar(from, to, "-shm")
}

#[allow(clippy::too_many_arguments)]
pub(super) fn restore_database_pair_with<RestoreLibrary, RestoreAnalysis, Verify>(
    library_backups: &[&Path],
    analysis_backups: &[&Path],
    active_library: &Path,
    active_analysis: &Path,
    mut restore_library: RestoreLibrary,
    mut restore_analysis: RestoreAnalysis,
    mut verify_pair: Verify,
) -> Result<(), String>
where
    RestoreLibrary: FnMut(&Path, &Path) -> Result<(), String>,
    RestoreAnalysis: FnMut(&Path, &Path) -> Result<(), String>,
    Verify: FnMut() -> Result<(), String>,
{
    let attempt = RECOVERY_ATTEMPT.fetch_add(1, Ordering::Relaxed);
    let current_library = recovery_path(active_library, attempt, "current");
    let current_analysis = recovery_path(active_analysis, attempt, "current");
    let old_library_work = recovery_path(active_library, attempt, "old-work");
    let old_analysis_work = recovery_path(active_analysis, attempt, "old-work");
    let current_library_work = recovery_path(active_library, attempt, "current-work");
    let current_analysis_work = recovery_path(active_analysis, attempt, "current-work");

    let library_snapshot = snapshot_active_database(active_library, &current_library);
    let analysis_snapshot = snapshot_active_database(active_analysis, &current_analysis);
    if library_snapshot.is_err() || analysis_snapshot.is_err() {
        let verification = verify_pair();
        return Err(format!(
            "rollback preparation failed: {}; active pair verification: {}; old backups retained; recovery snapshots: {}, {}",
            combine_results(
                "active database snapshot",
                &[
                    ("library", &library_snapshot),
                    ("analysis", &analysis_snapshot),
                ],
            )
            .unwrap_err(),
            result_status(&verification),
            current_library.display(),
            current_analysis.display()
        ));
    }

    let library_restore = copy_database_artifact(library_backups, &old_library_work)
        .and_then(|_| restore_library(&old_library_work, active_library));
    let analysis_restore = copy_database_artifact(analysis_backups, &old_analysis_work)
        .and_then(|_| restore_analysis(&old_analysis_work, active_analysis));
    let restored_verification = verify_pair();

    if library_restore.is_ok()
        && analysis_restore.is_ok()
        && restored_verification.is_ok()
    {
        let mut cleanup_paths = library_backups.to_vec();
        cleanup_paths.extend_from_slice(analysis_backups);
        cleanup_paths.extend([
            current_library.as_path(),
            current_analysis.as_path(),
            old_library_work.as_path(),
            old_analysis_work.as_path(),
            current_library_work.as_path(),
            current_analysis_work.as_path(),
        ]);
        return cleanup_database_paths(&cleanup_paths).map_err(|cleanup_error| {
            format!(
                "previous database pair restored and verified, but recovery cleanup failed: {cleanup_error}"
            )
        });
    }

    let restore_error = combine_results(
        "previous database pair restore",
        &[
            ("library", &library_restore),
            ("analysis", &analysis_restore),
            ("verification", &restored_verification),
        ],
    )
    .unwrap_err();

    let library_compensation =
        copy_database_artifact(&[current_library.as_path()], &current_library_work)
            .and_then(|_| restore_library(&current_library_work, active_library));
    let analysis_compensation =
        copy_database_artifact(&[current_analysis.as_path()], &current_analysis_work)
            .and_then(|_| restore_analysis(&current_analysis_work, active_analysis));
    let compensation_verification = verify_pair();
    let compensation = combine_results(
        "imported database pair compensation",
        &[
            ("library", &library_compensation),
            ("analysis", &analysis_compensation),
            ("verification", &compensation_verification),
        ],
    );

    Err(format!(
        "{restore_error}; {}; recovery artifacts retained at {}, {}; old backup artifacts retained",
        match compensation {
            Ok(()) => "imported database pair restored and verified".to_string(),
            Err(error) => error,
        },
        current_library.display(),
        current_analysis.display()
    ))
}

fn snapshot_active_database(active: &Path, destination: &Path) -> Result<(), String> {
    remove_db_with_sidecars(destination)?;
    vacuum_copy(active, destination).map_err(|error| {
        format!(
            "active database snapshot {} -> {} failed: {error}",
            active.display(),
            destination.display()
        )
    })
}

pub(super) fn copy_database_artifact(
    candidates: &[&Path],
    destination: &Path,
) -> Result<(), String> {
    remove_db_with_sidecars(destination)?;
    let source = candidates
        .iter()
        .copied()
        .find(|candidate| candidate.exists())
        .ok_or_else(|| {
            format!(
                "database backup is missing from candidates: {}",
                candidates
                    .iter()
                    .map(|path| path.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })?;
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::copy(source, destination).map_err(|error| {
        format!(
            "database backup copy {} -> {} failed: {error}",
            source.display(),
            destination.display()
        )
    })?;
    for suffix in ["-wal", "-shm"] {
        let Some(sidecar_source) = candidates
            .iter()
            .map(|candidate| sidecar_path(candidate, suffix))
            .find(|candidate| candidate.exists())
        else {
            continue;
        };
        let sidecar_destination = sidecar_path(destination, suffix);
        fs::copy(&sidecar_source, &sidecar_destination).map_err(|error| {
            format!(
                "database sidecar copy {} -> {} failed: {error}",
                sidecar_source.display(),
                sidecar_destination.display()
            )
        })?;
    }
    Ok(())
}

pub(super) fn next_recovery_path(active: &Path, role: &str) -> PathBuf {
    let attempt = RECOVERY_ATTEMPT.fetch_add(1, Ordering::Relaxed);
    recovery_path(active, attempt, role)
}

fn recovery_path(active: &Path, attempt: u64, role: &str) -> PathBuf {
    let file_name = active
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("database.sqlite");
    active.with_file_name(format!(
        "{file_name}.import-recovery-{}-{attempt}-{role}",
        std::process::id()
    ))
}

fn sidecar_path(base: &Path, suffix: &str) -> PathBuf {
    PathBuf::from(format!("{}{}", base.display(), suffix))
}

pub(in crate::lib_commands::app_api::backup) fn cleanup_database_paths(
    paths: &[&Path],
) -> Result<(), String> {
    let mut errors = Vec::new();
    for path in paths {
        if let Err(error) = remove_db_with_sidecars(path) {
            errors.push(format!("{}: {error}", path.display()));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

pub(super) fn combine_results(
    operation: &str,
    results: &[(&str, &Result<(), String>)],
) -> Result<(), String> {
    let errors = results
        .iter()
        .filter_map(|(database, result)| {
            result
                .as_ref()
                .err()
                .map(|error| format!("{database}: {error}"))
        })
        .collect::<Vec<_>>();
    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!("{operation} failed: {}", errors.join("; ")))
    }
}

fn result_status(result: &Result<(), String>) -> String {
    match result {
        Ok(()) => "passed".to_string(),
        Err(error) => format!("failed: {error}"),
    }
}

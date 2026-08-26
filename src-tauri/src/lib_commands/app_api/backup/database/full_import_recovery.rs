use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use super::recovery::{cleanup_database_paths, combine_results, copy_database_artifact};
use super::{remove_db_with_sidecars, vacuum_copy};

static FULL_IMPORT_RECOVERY_LOCK: Mutex<()> = Mutex::new(());
const FULL_IMPORT_RECOVERY_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum FullImportRecoveryPhase {
    Prepared,
    DatabasesRestored,
    Committed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FullImportRecoveryStatusDto {
    pub phase: FullImportRecoveryPhase,
    pub migration_generation: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct FullImportRecoveryMarker {
    version: u32,
    phase: FullImportRecoveryPhase,
    migration_generation: u64,
}

#[derive(Clone, Debug)]
pub(super) struct FullImportRecoveryPaths {
    root: PathBuf,
    prepared_marker: PathBuf,
    restored_marker: PathBuf,
    committed_marker: PathBuf,
    library_snapshot: PathBuf,
    analysis_snapshot: PathBuf,
    library_work: PathBuf,
    analysis_work: PathBuf,
}

impl FullImportRecoveryPaths {
    pub(super) fn new(app_data_dir: &Path) -> Self {
        let root = app_data_dir
            .join("databases")
            .join("full-import-recovery");
        Self {
            prepared_marker: root.join("prepared.json"),
            restored_marker: root.join("databases-restored.json"),
            committed_marker: root.join("committed.json"),
            library_snapshot: root.join("library.sqlite"),
            analysis_snapshot: root.join("audio-analysis.sqlite"),
            library_work: root.join("library.restore.sqlite"),
            analysis_work: root.join("audio-analysis.restore.sqlite"),
            root,
        }
    }

    fn cleanup_paths(&self) -> [&Path; 4] {
        [
            self.library_snapshot.as_path(),
            self.analysis_snapshot.as_path(),
            self.library_work.as_path(),
            self.analysis_work.as_path(),
        ]
    }

    fn marker_path(&self, phase: FullImportRecoveryPhase) -> &Path {
        match phase {
            FullImportRecoveryPhase::Prepared => &self.prepared_marker,
            FullImportRecoveryPhase::DatabasesRestored => &self.restored_marker,
            FullImportRecoveryPhase::Committed => &self.committed_marker,
        }
    }

    fn marker_paths(&self) -> [&Path; 3] {
        [
            self.prepared_marker.as_path(),
            self.restored_marker.as_path(),
            self.committed_marker.as_path(),
        ]
    }
}

pub(super) fn lock_full_import_recovery() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    FULL_IMPORT_RECOVERY_LOCK
        .lock()
        .map_err(|_| "full import recovery lock poisoned".to_string())
}

pub(super) fn inspect_full_import_recovery(
    paths: &FullImportRecoveryPaths,
) -> Result<Option<FullImportRecoveryStatusDto>, String> {
    read_full_import_marker(paths).map(|marker| {
        marker.map(|marker| FullImportRecoveryStatusDto {
            phase: marker.phase,
            migration_generation: marker.migration_generation,
        })
    })
}

pub(super) fn prepare_full_import_recovery(
    paths: &FullImportRecoveryPaths,
    active_library: &Path,
    active_analysis: &Path,
    migration_generation: u64,
) -> Result<(), String> {
    if read_full_import_marker(paths)?.is_some() {
        return Err("an incomplete full backup import must be recovered before retrying".to_string());
    }
    fs::create_dir_all(&paths.root).map_err(|error| error.to_string())?;
    cleanup_database_paths(&paths.cleanup_paths())?;
    for marker in paths.marker_paths() {
        remove_if_exists_durable(&marker_tmp_path(marker))?;
    }

    let preparation = (|| {
        durable_database_snapshot(active_library, &paths.library_snapshot)?;
        durable_database_snapshot(active_analysis, &paths.analysis_snapshot)?;
        write_full_import_marker(
            paths,
            &FullImportRecoveryMarker {
                version: FULL_IMPORT_RECOVERY_VERSION,
                phase: FullImportRecoveryPhase::Prepared,
                migration_generation,
            },
        )
    })();
    if preparation.is_ok() {
        return Ok(());
    }

    let cleanup = cleanup_database_paths(&paths.cleanup_paths());
    match cleanup {
        Ok(()) => preparation,
        Err(cleanup_error) => Err(format!(
            "{}; incomplete recovery snapshot cleanup failed: {cleanup_error}",
            preparation.unwrap_err()
        )),
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn recover_full_import_databases_with<RestoreLibrary, RestoreAnalysis, Verify>(
    paths: &FullImportRecoveryPaths,
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
    let marker = read_full_import_marker(paths)?
        .ok_or_else(|| "full import recovery marker is missing".to_string())?;
    if marker.phase == FullImportRecoveryPhase::Committed {
        return Err("full import recovery is already committed".to_string());
    }
    if marker.phase == FullImportRecoveryPhase::DatabasesRestored && verify_pair().is_ok() {
        return Ok(());
    }

    let library_restore = copy_database_artifact(
        &[paths.library_snapshot.as_path()],
        &paths.library_work,
    )
    .and_then(|_| restore_library(&paths.library_work, active_library));
    let analysis_restore = copy_database_artifact(
        &[paths.analysis_snapshot.as_path()],
        &paths.analysis_work,
    )
    .and_then(|_| restore_analysis(&paths.analysis_work, active_analysis));
    let verification = verify_pair();
    combine_results(
        "durable full import database recovery",
        &[
            ("library", &library_restore),
            ("analysis", &analysis_restore),
            ("verification", &verification),
        ],
    )?;
    write_full_import_marker(
        paths,
        &FullImportRecoveryMarker {
            phase: FullImportRecoveryPhase::DatabasesRestored,
            ..marker
        },
    )
}

pub(super) fn commit_full_import_recovery(
    paths: &FullImportRecoveryPaths,
    extra_cleanup_paths: &[&Path],
) -> Result<(), String> {
    let Some(marker) = read_full_import_marker(paths)? else {
        return cleanup_database_paths(extra_cleanup_paths);
    };
    if marker.phase == FullImportRecoveryPhase::DatabasesRestored {
        return Err("cannot commit a full import after its databases were restored".to_string());
    }
    if marker.phase != FullImportRecoveryPhase::Committed {
        write_full_import_marker(
            paths,
            &FullImportRecoveryMarker {
                phase: FullImportRecoveryPhase::Committed,
                ..marker
            },
        )?;
    }
    finalize_full_import_recovery(paths, extra_cleanup_paths)
}

pub(super) fn finalize_full_import_recovery(
    paths: &FullImportRecoveryPaths,
    extra_cleanup_paths: &[&Path],
) -> Result<(), String> {
    let marker = read_full_import_marker(paths)?;
    if marker.is_none() {
        cleanup_database_paths(&paths.cleanup_paths())?;
        for marker in paths.marker_paths() {
            remove_if_exists_durable(&marker_tmp_path(marker))?;
        }
        return Ok(());
    }
    if marker
        .as_ref()
        .is_some_and(|marker| marker.phase == FullImportRecoveryPhase::Prepared)
    {
        return Err("full import databases must be restored or committed before cleanup".to_string());
    }

    let mut cleanup_paths = extra_cleanup_paths.to_vec();
    cleanup_paths.extend(paths.cleanup_paths());
    cleanup_database_paths(&cleanup_paths)?;
    let phase = marker.unwrap().phase;
    remove_if_exists_durable(&paths.prepared_marker)?;
    if phase == FullImportRecoveryPhase::Committed {
        remove_if_exists_durable(&paths.restored_marker)?;
    }
    remove_if_exists_durable(paths.marker_path(phase))?;
    for marker in paths.marker_paths() {
        remove_if_exists_durable(&marker_tmp_path(marker))?;
    }
    Ok(())
}

fn durable_database_snapshot(source: &Path, destination: &Path) -> Result<(), String> {
    let temporary = snapshot_tmp_path(destination);
    remove_db_with_sidecars(&temporary)?;
    remove_db_with_sidecars(destination)?;
    vacuum_copy(source, &temporary)?;
    sync_file(&temporary)?;
    durable_rename(&temporary, destination)
}

fn read_full_import_marker(
    paths: &FullImportRecoveryPaths,
) -> Result<Option<FullImportRecoveryMarker>, String> {
    for phase in [
        FullImportRecoveryPhase::Committed,
        FullImportRecoveryPhase::DatabasesRestored,
        FullImportRecoveryPhase::Prepared,
    ] {
        let path = paths.marker_path(phase);
        if !path.exists() {
            continue;
        }
        let raw = fs::read(path).map_err(|error| error.to_string())?;
        let marker: FullImportRecoveryMarker = serde_json::from_slice(&raw)
            .map_err(|error| format!("invalid full import recovery marker: {error}"))?;
        if marker.version != FULL_IMPORT_RECOVERY_VERSION {
            return Err(format!(
                "unsupported full import recovery marker version {}",
                marker.version
            ));
        }
        if marker.phase != phase {
            return Err(format!(
                "full import recovery marker phase mismatch: path={phase:?}, payload={:?}",
                marker.phase
            ));
        }
        return Ok(Some(marker));
    }
    Ok(None)
}

fn write_full_import_marker(
    paths: &FullImportRecoveryPaths,
    marker: &FullImportRecoveryMarker,
) -> Result<(), String> {
    fs::create_dir_all(&paths.root).map_err(|error| error.to_string())?;
    let destination = paths.marker_path(marker.phase);
    if destination.exists() {
        let current = read_full_import_marker(paths)?
            .ok_or_else(|| "full import recovery marker disappeared".to_string())?;
        if current == *marker {
            return Ok(());
        }
        return Err(format!(
            "full import recovery marker already exists with different contents: {}",
            destination.display()
        ));
    }
    let temporary = marker_tmp_path(destination);
    remove_if_exists_durable(&temporary)?;
    let bytes = serde_json::to_vec(marker).map_err(|error| error.to_string())?;
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|error| error.to_string())?;
    file.write_all(&bytes).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    drop(file);
    durable_rename(&temporary, destination)
}

fn snapshot_tmp_path(path: &Path) -> PathBuf {
    path.with_extension("sqlite.tmp")
}

fn marker_tmp_path(path: &Path) -> PathBuf {
    path.with_extension("json.tmp")
}

fn sync_file(path: &Path) -> Result<(), String> {
    fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .and_then(|file| file.sync_all())
        .map_err(|error| error.to_string())
}

#[cfg(not(windows))]
fn durable_rename(from: &Path, to: &Path) -> Result<(), String> {
    fs::rename(from, to).map_err(|error| error.to_string())?;
    sync_parent(to)
}

#[cfg(windows)]
fn durable_rename(from: &Path, to: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;

    const MOVEFILE_WRITE_THROUGH: u32 = 0x0000_0008;
    #[link(name = "kernel32")]
    extern "system" {
        #[link_name = "MoveFileExW"]
        fn move_file_ex_w(existing: *const u16, replacement: *const u16, flags: u32) -> i32;
    }

    let existing = from
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let replacement = to
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // SAFETY: both pointers reference live, NUL-terminated UTF-16 buffers for this call.
    let moved = unsafe {
        move_file_ex_w(
            existing.as_ptr(),
            replacement.as_ptr(),
            MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(std::io::Error::last_os_error().to_string())
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn sync_parent(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("path has no parent: {}", path.display()))?;
    fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| error.to_string())
}

#[cfg(not(unix))]
fn sync_parent(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn remove_if_exists_durable(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    fs::remove_file(path).map_err(|error| error.to_string())?;
    sync_parent(path)
}

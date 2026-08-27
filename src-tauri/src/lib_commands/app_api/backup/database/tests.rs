use std::cell::Cell;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::Duration;

use psysonic_core::database_pair_admission::{
    database_pair_read_scope, database_pair_write_scope,
};
use rusqlite::Connection;

use super::full_import_recovery::{
    commit_full_import_recovery, finalize_full_import_recovery,
    inspect_full_import_recovery, prepare_full_import_recovery,
    recover_full_import_databases_with, FullImportRecoveryPaths,
    FullImportRecoveryPhase,
};
use super::recovery::BackupFinalizationStage;
use super::{
    finalize_import_backups_or_rollback_with, remove_db_with_sidecars,
    restore_database_pair_with, validate_import_database,
};

static TEST_DB_COUNTER: AtomicU64 = AtomicU64::new(0);

struct TestDb {
    dir: PathBuf,
    path: PathBuf,
}

impl TestDb {
    fn with_migration_head(head: Option<i64>) -> Self {
        let nonce = TEST_DB_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "psysonic-backup-validation-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("candidate.sqlite");
        let conn = Connection::open(&path).unwrap();
        if let Some(head) = head {
            conn.execute_batch(
                "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, 0)",
                [head],
            )
            .unwrap();
        }
        drop(conn);
        Self { dir, path }
    }
}

impl Drop for TestDb {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

struct PairSandbox {
    dir: PathBuf,
}

impl PairSandbox {
    fn new(name: &str) -> Self {
        let nonce = TEST_DB_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "psysonic-backup-{name}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        Self { dir }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }
}

impl Drop for PairSandbox {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn write_marker(path: &Path, marker: &str) {
    let connection = Connection::open(path).unwrap();
    connection
        .execute_batch("CREATE TABLE marker (value TEXT NOT NULL);")
        .unwrap();
    connection
        .execute("INSERT INTO marker(value) VALUES (?1)", [marker])
        .unwrap();
}

fn read_marker(path: &Path) -> Result<String, String> {
    Connection::open(path)
        .map_err(|error| error.to_string())?
        .query_row("SELECT value FROM marker", [], |row| row.get(0))
        .map_err(|error| error.to_string())
}

fn restore_file(backup: &Path, active: &Path) -> Result<(), String> {
    remove_db_with_sidecars(active)?;
    fs::rename(backup, active).map_err(|error| error.to_string())
}

fn verify_matching_pair(library: &Path, analysis: &Path) -> Result<(), String> {
    let library_marker = read_marker(library)?;
    let analysis_marker = read_marker(analysis)?;
    if library_marker == analysis_marker {
        Ok(())
    } else {
        Err(format!(
            "mixed pair: library={library_marker}, analysis={analysis_marker}"
        ))
    }
}

fn replace_marker(path: &Path, marker: &str) {
    remove_db_with_sidecars(path).unwrap();
    write_marker(path, marker);
}

fn prepare_durable_pair_recovery(
    sandbox: &PairSandbox,
) -> (FullImportRecoveryPaths, PathBuf, PathBuf) {
    let active_library = sandbox.path("library.sqlite");
    let active_analysis = sandbox.path("analysis.sqlite");
    write_marker(&active_library, "old");
    write_marker(&active_analysis, "old");
    let paths = FullImportRecoveryPaths::new(&sandbox.dir);
    prepare_full_import_recovery(
        &paths,
        &active_library,
        &active_analysis,
        7,
    )
    .unwrap();
    (paths, active_library, active_analysis)
}

fn recover_durable_pair(
    paths: &FullImportRecoveryPaths,
    active_library: &Path,
    active_analysis: &Path,
) {
    recover_full_import_databases_with(
        paths,
        active_library,
        active_analysis,
        restore_file,
        restore_file,
        || verify_matching_pair(active_library, active_analysis),
    )
    .unwrap();
    assert_eq!(read_marker(active_library).unwrap(), "old");
    assert_eq!(read_marker(active_analysis).unwrap(), "old");
    assert_eq!(
        inspect_full_import_recovery(paths).unwrap().unwrap(),
        super::full_import_recovery::FullImportRecoveryStatusDto {
            phase: FullImportRecoveryPhase::DatabasesRestored,
            migration_generation: 7,
        },
    );
}

fn assert_reader_observes_complete_pair_transition(initial: u8, final_value: u8) {
    let library = Arc::new(AtomicU8::new(initial));
    let analysis = Arc::new(AtomicU8::new(initial));
    {
        let _reader = database_pair_read_scope();
        assert_eq!(
            (
                library.load(Ordering::SeqCst),
                analysis.load(Ordering::SeqCst),
            ),
            (initial, initial),
        );
    }

    let (library_switched_tx, library_switched_rx) = mpsc::channel();
    let (continue_tx, continue_rx) = mpsc::channel();
    let library_for_writer = Arc::clone(&library);
    let analysis_for_writer = Arc::clone(&analysis);
    let writer = thread::spawn(move || {
        let _writer = database_pair_write_scope();
        library_for_writer.store(final_value, Ordering::SeqCst);
        library_switched_tx.send(()).unwrap();
        continue_rx.recv().unwrap();
        analysis_for_writer.store(final_value, Ordering::SeqCst);
    });
    library_switched_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("writer should pause between database transitions");

    let (observed_tx, observed_rx) = mpsc::channel();
    let library_for_reader = Arc::clone(&library);
    let analysis_for_reader = Arc::clone(&analysis);
    let reader = thread::spawn(move || {
        let _reader = database_pair_read_scope();
        observed_tx
            .send((
                library_for_reader.load(Ordering::SeqCst),
                analysis_for_reader.load(Ordering::SeqCst),
            ))
            .unwrap();
    });

    assert!(
        observed_rx.try_recv().is_err(),
        "reader must not observe the transition midpoint"
    );
    continue_tx.send(()).unwrap();
    assert_eq!(
        observed_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("reader should resume after the pair transition"),
        (final_value, final_value),
    );
    writer.join().unwrap();
    reader.join().unwrap();
}

#[test]
fn import_validation_accepts_compatible_older_schema_for_open_pipeline() {
    let db = TestDb::with_migration_head(Some(12));
    validate_import_database(&db.path, "library", 1, 23).unwrap();
}

#[test]
fn import_validation_rejects_future_or_unversioned_database() {
    let future = TestDb::with_migration_head(Some(24));
    let err = validate_import_database(&future.path, "library", 1, 23).unwrap_err();
    assert!(err.contains("newer than supported"));

    let unversioned = TestDb::with_migration_head(None);
    let err = validate_import_database(&unversioned.path, "library", 1, 23).unwrap_err();
    assert!(err.contains("migration history unavailable"));
}

#[test]
fn reader_never_observes_mixed_pair_during_activation() {
    assert_reader_observes_complete_pair_transition(0, 1);
}

#[test]
fn reader_never_observes_mixed_pair_during_rollback_or_recovery() {
    assert_reader_observes_complete_pair_transition(1, 0);
}

#[test]
fn paired_restore_compensates_when_second_database_restore_fails() {
    let sandbox = PairSandbox::new("second-restore-failure");
    let active_library = sandbox.path("library.sqlite");
    let active_analysis = sandbox.path("analysis.sqlite");
    let old_library = sandbox.path("library.sqlite.import.bak");
    let old_analysis = sandbox.path("analysis.sqlite.import.bak");
    write_marker(&active_library, "imported");
    write_marker(&active_analysis, "imported");
    write_marker(&old_library, "old");
    write_marker(&old_analysis, "old");

    let analysis_restore_attempts = Cell::new(0);
    let error = restore_database_pair_with(
        &[old_library.as_path()],
        &[old_analysis.as_path()],
        &active_library,
        &active_analysis,
        restore_file,
        |backup, active| {
            let attempt = analysis_restore_attempts.get();
            analysis_restore_attempts.set(attempt + 1);
            if attempt == 0 {
                Err("injected second-database restore failure".to_string())
            } else {
                restore_file(backup, active)
            }
        },
        || verify_matching_pair(&active_library, &active_analysis),
    )
    .unwrap_err();

    assert!(error.contains("injected second-database restore failure"));
    assert!(error.contains("imported database pair restored and verified"));
    assert_eq!(read_marker(&active_library).unwrap(), "imported");
    assert_eq!(read_marker(&active_analysis).unwrap(), "imported");
    assert!(old_library.exists(), "old library backup must be retained");
    assert!(old_analysis.exists(), "old analysis backup must be retained");
    let retained_recovery_files = fs::read_dir(&sandbox.dir)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().contains("import-recovery"))
        .count();
    assert!(retained_recovery_files >= 2);
}

#[test]
fn finalization_failure_restores_and_verifies_previous_pair() {
    let sandbox = PairSandbox::new("finalization-failure");
    let active_library = sandbox.path("library.sqlite");
    let active_analysis = sandbox.path("analysis.sqlite");
    let library_backup = sandbox.path("library.sqlite.backup-pre-indexkey");
    let analysis_backup = sandbox.path("analysis.sqlite.backup-pre-indexkey");
    let library_final = sandbox.path("library.sqlite.import.bak");
    let analysis_final = sandbox.path("analysis.sqlite.import.bak");
    let import_library_tmp = sandbox.path("library-import.sqlite");
    let import_analysis_tmp = sandbox.path("analysis-import.sqlite");
    write_marker(&active_library, "imported");
    write_marker(&active_analysis, "imported");
    write_marker(&library_backup, "old");
    write_marker(&analysis_backup, "old");

    let error = finalize_import_backups_or_rollback_with(
        &library_backup,
        &analysis_backup,
        &library_final,
        &analysis_final,
        &import_library_tmp,
        &import_analysis_tmp,
        &active_library,
        &active_analysis,
        |stage| {
            if stage == BackupFinalizationStage::Analysis {
                Err("injected analysis backup finalization failure".to_string())
            } else {
                Ok(())
            }
        },
        restore_file,
        restore_file,
        || verify_matching_pair(&active_library, &active_analysis),
    )
    .unwrap_err();

    assert!(error.contains("injected analysis backup finalization failure"));
    assert!(error.contains("previous database pair restored and verified"));
    assert_eq!(read_marker(&active_library).unwrap(), "old");
    assert_eq!(read_marker(&active_analysis).unwrap(), "old");
    assert!(!library_backup.exists());
    assert!(!analysis_backup.exists());
    assert!(!library_final.exists());
    assert!(!analysis_final.exists());
    assert!(
        fs::read_dir(&sandbox.dir)
            .unwrap()
            .filter_map(Result::ok)
            .all(|entry| !entry
                .file_name()
                .to_string_lossy()
                .contains("import-recovery"))
    );
}

#[test]
fn durable_recovery_handles_crash_before_first_swap() {
    let sandbox = PairSandbox::new("crash-before-first-swap");
    let (paths, active_library, active_analysis) = prepare_durable_pair_recovery(&sandbox);

    recover_durable_pair(&paths, &active_library, &active_analysis);
}

#[test]
fn durable_recovery_handles_crash_between_database_swaps() {
    let sandbox = PairSandbox::new("crash-between-swaps");
    let (paths, active_library, active_analysis) = prepare_durable_pair_recovery(&sandbox);
    replace_marker(&active_library, "imported");

    recover_durable_pair(&paths, &active_library, &active_analysis);
}

#[test]
fn durable_recovery_handles_crash_after_both_database_swaps() {
    let sandbox = PairSandbox::new("crash-after-both-swaps");
    let (paths, active_library, active_analysis) = prepare_durable_pair_recovery(&sandbox);
    replace_marker(&active_library, "imported");
    replace_marker(&active_analysis, "imported");

    recover_durable_pair(&paths, &active_library, &active_analysis);
}

#[test]
fn durable_recovery_ignores_partial_random_backup_finalization() {
    let sandbox = PairSandbox::new("crash-during-random-backup-finalization");
    let (paths, active_library, active_analysis) = prepare_durable_pair_recovery(&sandbox);
    replace_marker(&active_library, "imported");
    replace_marker(&active_analysis, "imported");
    let random_library = sandbox.path("library.sqlite.backup-pre-indexkey");
    let final_library = sandbox.path("library.sqlite.import.bak");
    write_marker(&random_library, "old-random");
    fs::rename(&random_library, &final_library).unwrap();
    write_marker(
        &sandbox.path("audio-analysis.sqlite.backup-pre-indexkey"),
        "old-random",
    );

    recover_durable_pair(&paths, &active_library, &active_analysis);
}

#[test]
fn committed_marker_survives_cleanup_failure_without_rolling_back_import() {
    let sandbox = PairSandbox::new("commit-cleanup-failure");
    let (paths, active_library, active_analysis) = prepare_durable_pair_recovery(&sandbox);
    replace_marker(&active_library, "imported");
    replace_marker(&active_analysis, "imported");
    let cleanup_blocker = sandbox.path("library.sqlite.import.bak");
    fs::create_dir_all(&cleanup_blocker).unwrap();

    let error = commit_full_import_recovery(&paths, &[cleanup_blocker.as_path()]).unwrap_err();
    assert!(!error.is_empty());
    assert_eq!(
        inspect_full_import_recovery(&paths).unwrap().unwrap().phase,
        FullImportRecoveryPhase::Committed,
    );
    assert_eq!(read_marker(&active_library).unwrap(), "imported");
    assert_eq!(read_marker(&active_analysis).unwrap(), "imported");

    fs::remove_dir(&cleanup_blocker).unwrap();
    commit_full_import_recovery(&paths, &[cleanup_blocker.as_path()]).unwrap();
    assert!(inspect_full_import_recovery(&paths).unwrap().is_none());
    assert_eq!(read_marker(&active_library).unwrap(), "imported");
    assert_eq!(read_marker(&active_analysis).unwrap(), "imported");
}

#[test]
fn recovery_cleanup_is_idempotent_after_databases_are_restored() {
    let sandbox = PairSandbox::new("recovery-cleanup-idempotent");
    let (paths, active_library, active_analysis) = prepare_durable_pair_recovery(&sandbox);
    replace_marker(&active_library, "imported");
    replace_marker(&active_analysis, "imported");
    recover_durable_pair(&paths, &active_library, &active_analysis);

    finalize_full_import_recovery(&paths, &[]).unwrap();
    finalize_full_import_recovery(&paths, &[]).unwrap();
    assert!(inspect_full_import_recovery(&paths).unwrap().is_none());
}

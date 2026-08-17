use super::*;

#[test]
fn swap_database_file_and_restore_backup_roundtrip() {
    let active_path = unique_temp_file("swap-active");
    let destination_path = unique_temp_file("swap-dst");
    let backup_path = active_path.with_file_name(format!(
        "{}.backup-pre-indexkey",
        active_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("audio-analysis.sqlite")
    ));

    let cache = open_file_cache(&active_path);
    let old_key = key_on("server-a", "old");
    cache.touch_track_status(&old_key, "ready").unwrap();
    cache
        .upsert_waveform(&old_key, &waveform(4, false))
        .unwrap();

    {
        let dst = open_file_cache(&destination_path);
        let new_key = key_on("server-a", "new");
        dst.touch_track_status(&new_key, "ready").unwrap();
        dst.upsert_waveform(&new_key, &waveform(4, false)).unwrap();
        dst.checkpoint_wal("dst").unwrap();
    }

    let backup = cache
        .swap_database_file(&active_path, &destination_path)
        .unwrap()
        .expect("backup path must be returned");
    assert_eq!(backup, backup_path);
    assert!(
        cache
            .get_waveform(&key_on("server-a", "new"))
            .unwrap()
            .is_some(),
        "cache must reopen on swapped destination DB"
    );
    assert!(
        !destination_path.exists(),
        "destination DB must be moved into active path"
    );
    assert!(
        backup_path.exists(),
        "previous active DB must be moved to backup path"
    );

    cache
        .restore_database_backup(&backup_path, &active_path)
        .unwrap();
    assert!(
        cache
            .get_waveform(&key_on("server-a", "old"))
            .unwrap()
            .is_some(),
        "restore must bring old DB back"
    );
    assert!(
        cache
            .get_waveform(&key_on("server-a", "new"))
            .unwrap()
            .is_none(),
        "restored DB must not contain swapped-in rows"
    );

    let _ = remove_db_with_sidecars(&active_path);
    let _ = remove_db_with_sidecars(&backup_path);
}

#[test]
fn swap_database_file_returns_none_when_destination_missing() {
    let active_path = unique_temp_file("swap-none-active");
    let missing_destination = unique_temp_file("swap-none-dst");
    let cache = open_file_cache(&active_path);
    let backup = cache
        .swap_database_file(&active_path, &missing_destination)
        .unwrap();
    assert!(backup.is_none());
    let _ = remove_db_with_sidecars(&active_path);
}

#[test]
fn swap_database_file_restores_active_database_for_every_failure_stage() {
    for stage in [
        SwapDatabaseStage::BackupActive,
        SwapDatabaseStage::ActivateDestination,
        SwapDatabaseStage::Open,
        SwapDatabaseStage::Configure,
        SwapDatabaseStage::Migrate,
    ] {
        let active_path = unique_temp_file("swap-fault-active");
        let destination_path = unique_temp_file("swap-fault-destination");
        let cache = open_file_cache(&active_path);
        let old_key = key_on("server-a", "old");
        cache.touch_track_status(&old_key, "ready").unwrap();
        cache
            .upsert_waveform(&old_key, &waveform(4, false))
            .unwrap();
        {
            let destination = open_file_cache(&destination_path);
            let new_key = key_on("server-a", "new");
            destination.touch_track_status(&new_key, "ready").unwrap();
            destination
                .upsert_waveform(&new_key, &waveform(4, false))
                .unwrap();
            destination.checkpoint_wal("fault-destination").unwrap();
        }

        let error = cache
            .swap_database_file_with(&active_path, &destination_path, |current| {
                if current == stage {
                    Err(format!("injected {stage:?} failure"))
                } else {
                    Ok(())
                }
            })
            .unwrap_err();
        assert!(error.contains("injected"));
        assert!(
            cache.get_waveform(&old_key).unwrap().is_some(),
            "live connection was not restored after {stage:?}"
        );
        assert!(
            cache
                .get_waveform(&key_on("server-a", "new"))
                .unwrap()
                .is_none(),
            "failed destination stayed live after {stage:?}"
        );
        let reopened = open_file_cache(&active_path);
        assert!(
            reopened.get_waveform(&old_key).unwrap().is_some(),
            "active file was not restored after {stage:?}"
        );

        let _ = remove_db_with_sidecars(&active_path);
        let _ = remove_db_with_sidecars(&destination_path);
    }
}

#[test]
fn swap_database_file_rejects_current_head_v1_shape_and_restores_active() {
    let active_path = unique_temp_file("swap-invalid-active");
    let destination_path = unique_temp_file("swap-invalid-destination");
    let cache = open_file_cache(&active_path);
    let old_key = key_on("server-a", "old");
    cache.touch_track_status(&old_key, "ready").unwrap();
    cache
        .upsert_waveform(&old_key, &waveform(4, false))
        .unwrap();
    {
        let destination = Connection::open(&destination_path).unwrap();
        destination.execute_batch(MIGRATION_001_BASELINE).unwrap();
        destination
            .execute_batch(
                "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
                 INSERT INTO schema_migrations(version, applied_at) VALUES (2, 0);",
            )
            .unwrap();
    }

    let error = cache
        .swap_database_file(&active_path, &destination_path)
        .unwrap_err();
    assert!(error.contains("column analysis_track.server_id"));
    assert!(cache.get_waveform(&old_key).unwrap().is_some());
    open_file_cache(&active_path)
        .verify_operational_schema()
        .unwrap();

    let _ = remove_db_with_sidecars(&active_path);
    let _ = remove_db_with_sidecars(&destination_path);
}

#[test]
fn migrate_db_helpers_move_and_cleanup_sidecars() {
    let from = unique_temp_file("migrate-from");
    let to = unique_temp_file("migrate-to");
    std::fs::write(&from, b"sqlite-bytes").unwrap();
    std::fs::write(sqlite_sidecar(&from, "-wal"), b"wal").unwrap();
    std::fs::write(sqlite_sidecar(&from, "-shm"), b"shm").unwrap();

    migrate_db_file(&from, &to).unwrap();
    assert!(to.exists());
    assert!(!from.exists());

    migrate_db_sidecar(&from, &to, "-wal").unwrap();
    migrate_db_sidecar(&from, &to, "-shm").unwrap();
    assert!(sqlite_sidecar(&to, "-wal").exists());
    assert!(sqlite_sidecar(&to, "-shm").exists());

    let moved_to = unique_temp_file("migrate-moved");
    std::fs::write(&moved_to, b"sqlite-bytes-2").unwrap();
    std::fs::write(sqlite_sidecar(&moved_to, "-wal"), b"wal2").unwrap();
    move_sidecar(&moved_to, &to, "-wal").unwrap();
    assert!(!sqlite_sidecar(&moved_to, "-wal").exists());
    assert!(sqlite_sidecar(&to, "-wal").exists());

    cleanup_legacy_db_if_present(&to, &to).unwrap();
    cleanup_legacy_db_if_present(&to, &moved_to).unwrap();
    assert!(!to.exists());
    assert!(!sqlite_sidecar(&to, "-wal").exists());
    assert!(!sqlite_sidecar(&to, "-shm").exists());
}

#[test]
fn checkpoint_wal_smoke_test() {
    let cache = AnalysisCache::open_in_memory();
    cache.checkpoint_wal("test").unwrap();
}

#[test]
fn sidecar_helpers_are_noop_when_source_is_missing() {
    let from = unique_temp_file("sidecar-missing-from");
    let to = unique_temp_file("sidecar-missing-to");
    std::fs::write(&to, b"db").unwrap();

    migrate_db_sidecar(&from, &to, "-wal").unwrap();
    migrate_db_sidecar(&from, &to, "-shm").unwrap();
    move_sidecar(&from, &to, "-wal").unwrap();
    move_sidecar(&from, &to, "-shm").unwrap();
    remove_db_with_sidecars(&from).unwrap();

    assert!(to.exists(), "destination DB stays intact");
    let _ = remove_db_with_sidecars(&to);
}

#[test]
fn restore_database_backup_keeps_active_when_backup_missing() {
    let active_path = unique_temp_file("restore-active");
    let backup_path = unique_temp_file("restore-missing-backup");
    let cache = open_file_cache(&active_path);
    let k = key_on("server-a", "active-track");
    cache.touch_track_status(&k, "ready").unwrap();
    cache.upsert_waveform(&k, &waveform(4, false)).unwrap();

    cache
        .restore_database_backup(&backup_path, &active_path)
        .unwrap();
    assert!(cache.get_waveform(&k).unwrap().is_none());

    let _ = remove_db_with_sidecars(&active_path);
}

#[test]
fn init_opens_app_scoped_database_path() {
    let app = tauri::test::mock_app();
    let handle = app.handle().clone();
    let cache = AnalysisCache::init(&handle).expect("analysis cache init with mock app");
    cache.checkpoint_wal("init-test").unwrap();
}

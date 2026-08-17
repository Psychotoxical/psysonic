use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use rusqlite::Connection;

use super::validate_import_database;

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

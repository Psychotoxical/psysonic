use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_DATABASE_COUNTER: AtomicU64 = AtomicU64::new(0);

pub(super) struct TestDatabase {
    pub(super) dir: PathBuf,
    pub(super) path: PathBuf,
}

impl TestDatabase {
    pub(super) fn new(label: &str) -> Self {
        let nonce = TEST_DATABASE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "psysonic-library-{label}-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("create test database directory");
        let path = dir.join("library.sqlite");
        Self { dir, path }
    }
}

impl Drop for TestDatabase {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

mod connections;
mod migration_runner;
mod migration_schema;
mod reconciles;
mod schema;

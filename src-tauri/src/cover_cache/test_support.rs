use std::path::PathBuf;

/// Build a unique tmpdir so parallel cover-cache tests don't trip on each other.
pub(super) fn fresh_tmpdir(label: &str) -> PathBuf {
    let mut path = std::env::temp_dir();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    path.push(format!("psysonic-cover-{label}-{nanos}"));
    std::fs::create_dir_all(&path).unwrap();
    path
}

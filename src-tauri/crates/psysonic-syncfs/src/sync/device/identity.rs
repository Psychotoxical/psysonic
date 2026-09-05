use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const DEVICE_ID_FILE: &str = ".psysonic-device-id";

fn device_id_path(root: &Path) -> PathBuf {
    root.join(DEVICE_ID_FILE)
}

fn valid_device_id(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn read_device_identity_marker(root: &Path) -> Result<Option<String>, String> {
    let path = device_id_path(root);
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("DEVICE_SYNC_DEVICE_ID_INVALID".to_string());
    }
    let value = std::fs::read_to_string(path)
        .map_err(|error| error.to_string())?
        .trim()
        .to_string();
    if !valid_device_id(&value) {
        return Err("DEVICE_SYNC_DEVICE_ID_INVALID".to_string());
    }
    Ok(Some(value.to_ascii_lowercase()))
}

fn new_device_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let sequence = COUNTER.fetch_add(1, Ordering::Relaxed);
    let seed = format!(
        "{:?}:{}:{sequence}",
        std::time::SystemTime::now(),
        std::process::id()
    );
    format!("{:x}", md5::compute(seed.as_bytes()))
}

fn create_device_identity_marker(root: &Path) -> Result<String, String> {
    let path = device_id_path(root);
    let device_id = new_device_id();
    let mut file = match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            return read_device_identity_marker(root)?
                .ok_or_else(|| "DEVICE_SYNC_DEVICE_ID_INVALID".to_string());
        }
        Err(error) => return Err(error.to_string()),
    };
    if let Err(error) = file
        .write_all(device_id.as_bytes())
        .and_then(|()| file.sync_all())
    {
        drop(file);
        let _ = std::fs::remove_file(&path);
        return Err(error.to_string());
    }
    super::manifest::sync_device_directory(Some(root))?;
    Ok(device_id)
}

pub(crate) fn ensure_device_identity(root: &Path) -> Result<String, String> {
    super::ensure_mounted_target(root)?;
    match read_device_identity_marker(root)? {
        Some(device_id) => Ok(device_id),
        None => create_device_identity_marker(root),
    }
}

pub(crate) fn validate_device_identity(root: &Path, expected: &str) -> Result<(), String> {
    super::ensure_mounted_target(root)?;
    validate_device_identity_marker(root, expected)
}

fn validate_device_identity_marker(root: &Path, expected: &str) -> Result<(), String> {
    let actual = read_device_identity_marker(root)?
        .ok_or_else(|| "DEVICE_SYNC_DEVICE_CHANGED".to_string())?;
    if !valid_device_id(expected) || !actual.eq_ignore_ascii_case(expected) {
        return Err("DEVICE_SYNC_DEVICE_CHANGED".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marker_identity_rejects_a_replacement_root() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let first_id = create_device_identity_marker(first.path()).unwrap();
        let second_id = create_device_identity_marker(second.path()).unwrap();

        assert_ne!(first_id, second_id);
        assert_eq!(
            validate_device_identity_marker(second.path(), &first_id),
            Err("DEVICE_SYNC_DEVICE_CHANGED".to_string())
        );
    }

    #[cfg(unix)]
    #[test]
    fn marker_identity_rejects_a_symlink() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        symlink(outside.path(), device_id_path(root.path())).unwrap();

        assert_eq!(
            read_device_identity_marker(root.path()),
            Err("DEVICE_SYNC_DEVICE_ID_INVALID".to_string())
        );
    }
}

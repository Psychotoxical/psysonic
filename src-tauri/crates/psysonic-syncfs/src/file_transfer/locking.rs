use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock, Weak};
use std::time::Duration;

use fs4::{FileExt, TryLockError};

use super::{reborrow_cancellation, DownloadCancellation};

const LOCK_RETRY_INTERVAL: Duration = Duration::from_millis(50);
const LOCK_FILE_SUFFIX: &str = ".psysonic-download.lock";
const LOCK_DIRECTORY: &str = ".psysonic-download-locks";
const LOCK_SHARD_HEX_CHARS: usize = 2;

fn destination_locks() -> &'static tokio::sync::Mutex<HashMap<PathBuf, Weak<tokio::sync::Mutex<()>>>>
{
    static LOCKS: OnceLock<tokio::sync::Mutex<HashMap<PathBuf, Weak<tokio::sync::Mutex<()>>>>> =
        OnceLock::new();
    LOCKS.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()))
}

fn normalized_destination_key(path: &Path) -> PathBuf {
    path.parent()
        .and_then(|parent| parent.canonicalize().ok())
        .and_then(|parent| path.file_name().map(|name| parent.join(name)))
        .unwrap_or_else(|| path.to_path_buf())
}

fn append_to_file_name(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}

pub fn sibling_part_path(destination: &Path, identity: &str) -> PathBuf {
    let digest = format!("{:x}", md5::compute(identity.as_bytes()));
    append_to_file_name(destination, &format!(".{digest}.part"))
}

pub(super) fn destination_lock_path(destination: &Path) -> PathBuf {
    let normalized = normalized_destination_key(destination);
    let digest = format!(
        "{:x}",
        md5::compute(normalized.to_string_lossy().as_bytes())
    );
    let tier_root = destination.ancestors().find(|ancestor| {
        ancestor
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| {
                matches!(name, "cache" | "library" | "favorites" | "psysonic-offline")
            })
    });
    let lock_root = tier_root
        .and_then(Path::parent)
        .unwrap_or_else(|| destination.parent().unwrap_or_else(|| Path::new(".")))
        .join(LOCK_DIRECTORY);
    // Lock files must not be unlinked while another process may have the old
    // inode open. Sharding bounds persistent entries to 256 per media root.
    lock_root.join(format!(
        "{}{LOCK_FILE_SUFFIX}",
        &digest[..LOCK_SHARD_HEX_CHARS]
    ))
}

pub(super) fn is_destination_lock_file(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(LOCK_FILE_SUFFIX))
}

pub(super) fn destination_from_part_path(part_path: &Path) -> Option<PathBuf> {
    let file_name = part_path.file_name()?.to_str()?;
    let without_part = file_name.strip_suffix(".part")?;
    let (destination_name, digest) = without_part.rsplit_once('.')?;
    if digest.len() != 32 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    Some(part_path.with_file_name(destination_name))
}

pub struct DownloadDestinationGuard {
    _memory_guard: tokio::sync::OwnedMutexGuard<()>,
    _lock_file: Arc<std::fs::File>,
}

async fn open_lock_file(path: PathBuf) -> Result<std::fs::File, String> {
    tokio::task::spawn_blocking(move || {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(path)
    })
    .await
    .map_err(|error| format!("download lock task failed: {error}"))?
    .map_err(|error| format!("could not open download lock: {error}"))
}

async fn try_lock_file(file: Arc<std::fs::File>) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || match FileExt::try_lock(&*file) {
        Ok(()) => Ok(true),
        Err(TryLockError::WouldBlock) => Ok(false),
        Err(TryLockError::Error(error)) => Err(error),
    })
    .await
    .map_err(|error| format!("download lock task failed: {error}"))?
    .map_err(|error| format!("could not lock download destination: {error}"))
}

pub async fn acquire_download_destination_lock(
    destination: &Path,
    mut cancellation: Option<&mut DownloadCancellation>,
) -> Result<DownloadDestinationGuard, String> {
    let key = normalized_destination_key(destination);
    let lock = {
        let mut locks = destination_locks().lock().await;
        locks.retain(|_, lock| lock.strong_count() > 0);
        match locks.get(&key).and_then(Weak::upgrade) {
            Some(lock) => lock,
            None => {
                let lock = Arc::new(tokio::sync::Mutex::new(()));
                locks.insert(key, Arc::downgrade(&lock));
                lock
            }
        }
    };

    let memory_guard = if let Some(cancel) = reborrow_cancellation(&mut cancellation) {
        tokio::select! {
            guard = lock.lock_owned() => guard,
            _ = cancel.cancelled() => return Err("CANCELLED".to_string()),
        }
    } else {
        lock.lock_owned().await
    };

    let open = open_lock_file(destination_lock_path(destination));
    tokio::pin!(open);
    let lock_file = Arc::new(
        if let Some(cancel) = reborrow_cancellation(&mut cancellation) {
            tokio::select! {
                file = &mut open => file?,
                _ = cancel.cancelled() => return Err("CANCELLED".to_string()),
            }
        } else {
            open.await?
        },
    );
    loop {
        let attempt = try_lock_file(Arc::clone(&lock_file));
        tokio::pin!(attempt);
        let acquired = if let Some(cancel) = reborrow_cancellation(&mut cancellation) {
            tokio::select! {
                result = &mut attempt => result?,
                _ = cancel.cancelled() => return Err("CANCELLED".to_string()),
            }
        } else {
            attempt.await?
        };
        if acquired {
            return Ok(DownloadDestinationGuard {
                _memory_guard: memory_guard,
                _lock_file: lock_file,
            });
        }
        if let Some(cancel) = reborrow_cancellation(&mut cancellation) {
            tokio::select! {
                _ = tokio::time::sleep(LOCK_RETRY_INTERVAL) => {},
                _ = cancel.cancelled() => return Err("CANCELLED".to_string()),
            }
        } else {
            tokio::time::sleep(LOCK_RETRY_INTERVAL).await;
        }
    }
}

pub(super) async fn destination_is_locked(destination: &Path) -> bool {
    let path = destination_lock_path(destination);
    if !path.is_file() {
        return false;
    }
    let Ok(file) = open_lock_file(path).await else {
        return true;
    };
    let file = Arc::new(file);
    match try_lock_file(Arc::clone(&file)).await {
        Ok(true) => {
            let _ = tokio::task::spawn_blocking(move || FileExt::unlock(&*file)).await;
            false
        }
        Ok(false) | Err(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[test]
    fn sibling_part_paths_are_siblings_and_collision_resistant() {
        let destination = Path::new("/tmp/album/track.flac");
        let first = sibling_part_path(destination, "a/b");
        let second = sibling_part_path(destination, "a:b");

        assert_eq!(first.parent(), destination.parent());
        assert_eq!(second.parent(), destination.parent());
        assert_ne!(first, second);
        assert!(destination_from_part_path(&first).is_some_and(|path| path == destination));
    }

    #[test]
    fn destination_lock_files_use_a_bounded_shard_set() {
        let dir = tempfile::tempdir().unwrap();
        let paths: std::collections::HashSet<_> = (0..2048)
            .map(|index| destination_lock_path(&dir.path().join(format!("track-{index}.flac"))))
            .collect();

        assert!(paths.len() > 1);
        assert!(paths.len() <= 256);
        assert!(paths.iter().all(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.len() == LOCK_SHARD_HEX_CHARS + LOCK_FILE_SUFFIX.len())
        }));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn destination_guard_holds_an_os_file_lock() {
        let dir = tempfile::tempdir().unwrap();
        let destination = dir.path().join("track.flac");
        let _guard = acquire_download_destination_lock(&destination, None)
            .await
            .unwrap();
        let contender = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(destination_lock_path(&destination))
            .unwrap();

        assert!(matches!(
            FileExt::try_lock(&contender),
            Err(TryLockError::WouldBlock)
        ));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn cancellation_wakes_destination_lock_waiter() {
        let dir = tempfile::tempdir().unwrap();
        let destination = dir.path().join("track.flac");
        let _guard = acquire_download_destination_lock(&destination, None)
            .await
            .unwrap();
        let flag = Arc::new(AtomicBool::new(false));
        let (sender, receiver) = tokio::sync::watch::channel(false);
        let mut cancellation = DownloadCancellation::new(Arc::clone(&flag), receiver);
        let waiting = acquire_download_destination_lock(&destination, Some(&mut cancellation));
        tokio::pin!(waiting);

        tokio::time::sleep(Duration::from_millis(25)).await;
        flag.store(true, Ordering::Relaxed);
        sender.send_replace(true);

        let result = tokio::time::timeout(Duration::from_secs(1), waiting)
            .await
            .unwrap();
        assert!(matches!(result, Err(ref error) if error == "CANCELLED"));
    }

    #[test]
    fn cross_process_lock_probe() {
        let Some(path) = std::env::var_os("PSYSONIC_TEST_LOCK_PATH") else {
            return;
        };
        let contender = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
            .unwrap();
        assert!(matches!(
            FileExt::try_lock(&contender),
            Err(TryLockError::WouldBlock)
        ));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn destination_guard_blocks_another_process() {
        let dir = tempfile::tempdir().unwrap();
        let destination = dir.path().join("track.flac");
        let _guard = acquire_download_destination_lock(&destination, None)
            .await
            .unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("file_transfer::locking::tests::cross_process_lock_probe")
            .arg("--nocapture")
            .env(
                "PSYSONIC_TEST_LOCK_PATH",
                destination_lock_path(&destination),
            )
            .status()
            .unwrap();

        assert!(status.success());
    }
}

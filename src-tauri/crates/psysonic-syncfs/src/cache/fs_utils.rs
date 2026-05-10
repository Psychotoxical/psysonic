use std::path::Path;

/// Recursively sums the size of all files under `root`.
/// Missing roots, unreadable directories, and unreadable files are silently skipped.
pub fn dir_size_recursive(root: &Path) -> u64 {
    if !root.exists() {
        return 0;
    }
    let mut total: u64 = 0;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let rd = match std::fs::read_dir(&dir) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for entry in rd.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if let Ok(meta) = std::fs::metadata(&path) {
                total += meta.len();
            }
        }
    }
    total
}

/// Walks upward from `start_dir`, removing each empty directory using `remove_dir`
/// (never `remove_dir_all`). Stops as soon as a non-empty directory is hit, the
/// boundary is reached, or removal fails.
///
/// `boundary` is never removed and is treated as a hard stop. If `start_dir` is
/// not under `boundary`, the function is a no-op.
pub fn prune_empty_dirs_up_to(start_dir: &Path, boundary: &Path) {
    let mut current = Some(start_dir.to_path_buf());
    while let Some(dir) = current {
        if dir == boundary || !dir.starts_with(boundary) {
            break;
        }
        match std::fs::read_dir(&dir) {
            Ok(mut entries) => {
                if entries.next().is_some() {
                    break;
                }
                if std::fs::remove_dir(&dir).is_err() {
                    break;
                }
                current = dir.parent().map(|p| p.to_path_buf());
            }
            Err(_) => break,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dir_size_recursive_returns_zero_for_missing_root() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("does-not-exist");
        assert_eq!(dir_size_recursive(&missing), 0);
    }

    #[test]
    fn dir_size_recursive_returns_zero_for_empty_dir() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(dir_size_recursive(dir.path()), 0);
    }

    #[test]
    fn dir_size_recursive_sums_files_across_subdirs() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.bin"), b"hello").unwrap();
        let sub = dir.path().join("nested");
        std::fs::create_dir(&sub).unwrap();
        std::fs::write(sub.join("b.bin"), b"world!!").unwrap();
        assert_eq!(dir_size_recursive(dir.path()), 5 + 7);
    }

    #[test]
    fn prune_empty_dirs_up_to_is_noop_when_start_equals_boundary() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();
        prune_empty_dirs_up_to(path, path);
        assert!(path.exists(), "boundary dir must never be removed");
    }

    #[test]
    fn prune_empty_dirs_up_to_stops_at_non_empty_parent() {
        let root = tempfile::tempdir().unwrap();
        let parent = root.path().join("parent");
        let child = parent.join("child");
        std::fs::create_dir_all(&child).unwrap();
        std::fs::write(parent.join("keepme.txt"), b"x").unwrap();
        prune_empty_dirs_up_to(&child, root.path());
        assert!(!child.exists(), "empty leaf should be pruned");
        assert!(parent.exists(), "non-empty parent must stay");
    }
}

use std::path::{Path, PathBuf};

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

/// All regular files under `root` (recursive). Missing or unreadable roots yield an empty list.
pub fn collect_regular_files_under(root: &Path) -> Vec<std::path::PathBuf> {
    if !root.is_dir() {
        return Vec::new();
    }
    let mut files = Vec::new();
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
            } else if path.is_file() {
                files.push(path);
            }
        }
    }
    files
}

fn normalize_path_for_prefix(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

/// Returns the `{…}/cache`, `{…}/library`, or `{…}/favorites` ancestor of a media file path.
pub fn local_tier_boundary_from_path(path: &Path) -> Option<PathBuf> {
    let mut current = path.parent()?;
    loop {
        match current.file_name().and_then(|s| s.to_str()) {
            Some("cache") | Some("library") | Some("favorites") => {
                return Some(current.to_path_buf());
            }
            _ => current = current.parent()?,
        }
    }
}

/// Walks upward from `start_dir`, removing each empty directory using `remove_dir`
/// (never `remove_dir_all`). Stops as soon as a non-empty directory is hit, the
/// boundary is reached, or removal fails.
///
/// `boundary` is never removed and is treated as a hard stop. If `start_dir` is
/// not under `boundary`, the function is a no-op.
pub fn prune_empty_dirs_up_to(start_dir: &Path, boundary: &Path) {
    let boundary_norm = normalize_path_for_prefix(boundary);
    let mut current = Some(start_dir.to_path_buf());
    while let Some(dir) = current {
        let dir_norm = normalize_path_for_prefix(&dir);
        if dir_norm == boundary_norm || !dir_norm.starts_with(&boundary_norm) {
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

/// Post-order sweep: removes empty child directories under `root` (never `root` itself).
pub fn prune_empty_subdirs_under(root: &Path) {
    if !root.is_dir() {
        return;
    }
    let children: Vec<PathBuf> = std::fs::read_dir(root)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    for child in children {
        prune_empty_subdirs_under(&child);
        let is_empty = std::fs::read_dir(&child)
            .map(|mut rd| rd.next().is_none())
            .unwrap_or(false);
        if is_empty {
            let _ = std::fs::remove_dir(&child);
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
    fn collect_regular_files_under_lists_nested_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.mp3"), b"x").unwrap();
        let sub = dir.path().join("Artist/Album");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join("b.flac"), b"yy").unwrap();
        let files = collect_regular_files_under(dir.path());
        assert_eq!(files.len(), 2);
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

    #[test]
    fn local_tier_boundary_from_path_finds_cache_root() {
        let root = tempfile::tempdir().unwrap();
        let track = root
            .path()
            .join("vol/media/cache/my.server/Artist/Album/track.flac");
        std::fs::create_dir_all(track.parent().unwrap()).unwrap();
        let boundary = local_tier_boundary_from_path(&track).unwrap();
        assert_eq!(boundary, root.path().join("vol/media/cache"));
    }

    #[test]
    fn prune_empty_subdirs_under_removes_nested_empty_tree() {
        let root = tempfile::tempdir().unwrap();
        let cache = root.path().join("cache").join("srv").join("Artist").join("Album");
        std::fs::create_dir_all(&cache).unwrap();
        prune_empty_subdirs_under(&root.path().join("cache"));
        assert!(!cache.exists());
        assert!(root.path().join("cache").exists(), "tier root preserved");
    }
}

use std::path::Path;

const COVER_CACHE_LAYOUT_STAMP: &str = psysonic_core::cover_cache_layout::LAYOUT_STAMP;

/// Drop legacy profile-uuid directories when switching to host index keys (no migration).
pub(super) fn reset_cover_cache_for_index_key_layout(root: &Path) -> Result<(), String> {
    let stamp = root.join(".storage-layout");
    if stamp.is_file() {
        if let Ok(s) = std::fs::read_to_string(&stamp) {
            if s.trim() == COVER_CACHE_LAYOUT_STAMP {
                return Ok(());
            }
        }
    }
    if root.exists() {
        for entry in std::fs::read_dir(root)
            .map_err(|e| e.to_string())?
            .flatten()
        {
            let path = entry.path();
            if path.file_name().and_then(|n| n.to_str()) == Some(".storage-layout") {
                continue;
            }
            if path.is_dir() {
                let _ = std::fs::remove_dir_all(&path);
            } else {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    std::fs::write(&stamp, COVER_CACHE_LAYOUT_STAMP).map_err(|e| e.to_string())?;
    Ok(())
}

/// Delete only external-provider artifacts under a server's cover dir — the
/// `{tier}-{provider}.webp` tiers and `.miss-{provider}` markers — leaving the
/// canonical Navidrome `{tier}.webp` and `.fetch-failed` untouched. Returns the
/// number of files removed.
pub(super) fn purge_external_files(server_dir: &Path) -> usize {
    fn is_external(name: &str) -> bool {
        (name.ends_with(".webp") && name.contains('-')) || name.starts_with(".miss-")
    }
    fn walk(dir: &Path, count: &mut usize) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, count);
            } else if path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(is_external)
                && std::fs::remove_file(&path).is_ok()
            {
                *count += 1;
            }
        }
    }
    let mut count = 0;
    walk(server_dir, &mut count);
    count
}

/// FS-only worker for `cover_cache_rename_server_bucket`.
pub(super) fn rename_bucket_inner(root: &Path, old_key: &str, new_key: &str) -> Result<(), String> {
    if old_key.is_empty() || new_key.is_empty() {
        return Err("cover_cache_rename_server_bucket: empty key".into());
    }
    if !is_safe_index_key(old_key) || !is_safe_index_key(new_key) {
        return Err("cover_cache_rename_server_bucket: key contains path separator".into());
    }
    if old_key == new_key {
        return Ok(());
    }

    let old_dir = root.join(old_key);
    let new_dir = root.join(new_key);

    if !old_dir.is_dir() {
        return Ok(());
    }

    if !new_dir.exists() {
        std::fs::rename(&old_dir, &new_dir).map_err(|e| e.to_string())?;
    } else {
        merge_cover_bucket(&old_dir, &new_dir)?;
        let _ = std::fs::remove_dir_all(&old_dir);
    }
    Ok(())
}

fn is_safe_index_key(key: &str) -> bool {
    // Real index keys are `host[:port][/sub/path]` shape — forward slashes
    // are legitimate path components (Navidrome behind a reverse-proxy
    // subpath, etc.). Everything below is defense-in-depth at the FS boundary.
    if key.is_empty() {
        return false;
    }
    if key.starts_with('/') || key.starts_with('\\') {
        return false;
    }
    let bytes = key.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        return false;
    }
    if key.contains('\\') {
        return false;
    }
    for segment in key.split('/') {
        if segment == ".." {
            return false;
        }
    }
    true
}

fn merge_cover_bucket(old_dir: &Path, new_dir: &Path) -> Result<(), String> {
    let entries = std::fs::read_dir(old_dir).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let from = entry.path();
        let to = new_dir.join(entry.file_name());
        if to.exists() {
            // Prefer existing in destination — newer bucket wins.
            continue;
        }
        if from.is_dir() {
            std::fs::create_dir_all(&to).map_err(|e| e.to_string())?;
            merge_cover_bucket(&from, &to)?;
        } else {
            std::fs::rename(&from, &to).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{is_safe_index_key, merge_cover_bucket, purge_external_files, rename_bucket_inner};
    use crate::cover_cache::test_support::fresh_tmpdir;
    use std::fs;

    #[test]
    fn safe_index_key_accepts_real_keys() {
        assert!(is_safe_index_key("music.example.com"));
        assert!(is_safe_index_key("192.168.0.10:4533"));
        assert!(is_safe_index_key("music.example.com/navidrome"));
        assert!(is_safe_index_key("[fe80::1]:4533"));
    }

    #[test]
    fn safe_index_key_rejects_path_traversal_and_backslashes() {
        assert!(!is_safe_index_key("../etc"));
        assert!(!is_safe_index_key("a/../b"));
        assert!(!is_safe_index_key("a\\b"));
        assert!(!is_safe_index_key("..\\evil"));
    }

    #[test]
    fn safe_index_key_rejects_absolute_paths_and_drive_letters() {
        assert!(!is_safe_index_key("/etc/passwd"));
        assert!(!is_safe_index_key("/"));
        assert!(!is_safe_index_key("\\windows"));
        assert!(!is_safe_index_key("C:"));
        assert!(!is_safe_index_key("C:/Windows"));
        assert!(!is_safe_index_key("c:foo"));
        assert!(!is_safe_index_key(""));
    }

    #[test]
    fn merge_bucket_moves_unique_files() {
        let root = fresh_tmpdir("merge-unique");
        let old = root.join("old");
        let new = root.join("new");
        fs::create_dir_all(old.join("al-1")).unwrap();
        fs::write(old.join("al-1").join("128.webp"), b"old-bytes").unwrap();
        fs::create_dir_all(&new).unwrap();

        merge_cover_bucket(&old, &new).unwrap();

        assert!(new.join("al-1").join("128.webp").exists());
        assert_eq!(
            fs::read(new.join("al-1").join("128.webp")).unwrap(),
            b"old-bytes"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn merge_bucket_prefers_existing_on_collision() {
        let root = fresh_tmpdir("merge-collision");
        let old = root.join("old");
        let new = root.join("new");
        fs::create_dir_all(old.join("al-1")).unwrap();
        fs::create_dir_all(new.join("al-1")).unwrap();
        fs::write(old.join("al-1").join("128.webp"), b"OLD").unwrap();
        fs::write(new.join("al-1").join("128.webp"), b"NEW").unwrap();

        merge_cover_bucket(&old, &new).unwrap();

        assert_eq!(fs::read(new.join("al-1").join("128.webp")).unwrap(), b"NEW");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rename_bucket_inner_rejects_empty_keys() {
        let root = fresh_tmpdir("rename-empty");
        assert!(rename_bucket_inner(&root, "", "new").is_err());
        assert!(rename_bucket_inner(&root, "old", "").is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rename_bucket_inner_rejects_unsafe_keys() {
        let root = fresh_tmpdir("rename-unsafe");
        assert!(rename_bucket_inner(&root, "../escape", "new").is_err());
        assert!(rename_bucket_inner(&root, "old", "/abs/path").is_err());
        assert!(rename_bucket_inner(&root, "old", "C:/Windows").is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rename_bucket_inner_noop_when_old_missing() {
        let root = fresh_tmpdir("rename-missing");
        rename_bucket_inner(&root, "old", "new").unwrap();
        assert!(!root.join("new").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rename_bucket_inner_noop_when_keys_equal() {
        let root = fresh_tmpdir("rename-equal");
        fs::create_dir_all(root.join("same").join("al-1")).unwrap();
        fs::write(root.join("same").join("al-1").join("128.webp"), b"x").unwrap();
        rename_bucket_inner(&root, "same", "same").unwrap();
        assert!(root.join("same").join("al-1").join("128.webp").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rename_bucket_inner_simple_rename_when_new_missing() {
        let root = fresh_tmpdir("rename-simple");
        fs::create_dir_all(root.join("old").join("al-1")).unwrap();
        fs::write(root.join("old").join("al-1").join("128.webp"), b"payload").unwrap();
        rename_bucket_inner(&root, "old", "new").unwrap();
        assert!(!root.join("old").exists());
        assert_eq!(
            fs::read(root.join("new").join("al-1").join("128.webp")).unwrap(),
            b"payload",
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rename_bucket_inner_merges_when_new_exists() {
        let root = fresh_tmpdir("rename-merge");
        fs::create_dir_all(root.join("old").join("al-1")).unwrap();
        fs::create_dir_all(root.join("new").join("al-2")).unwrap();
        fs::write(root.join("old").join("al-1").join("128.webp"), b"from-old").unwrap();
        fs::write(root.join("new").join("al-2").join("128.webp"), b"from-new").unwrap();
        fs::create_dir_all(root.join("old").join("al-2")).unwrap();
        fs::write(
            root.join("old").join("al-2").join("128.webp"),
            b"overwrite-attempt",
        )
        .unwrap();

        rename_bucket_inner(&root, "old", "new").unwrap();

        assert!(!root.join("old").exists());
        assert_eq!(
            fs::read(root.join("new").join("al-1").join("128.webp")).unwrap(),
            b"from-old",
        );
        assert_eq!(
            fs::read(root.join("new").join("al-2").join("128.webp")).unwrap(),
            b"from-new",
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn purge_external_removes_only_external_artifacts() {
        let root = fresh_tmpdir("purge-external");
        let entity = root.join("artist").join("ar-1");
        fs::create_dir_all(&entity).unwrap();
        fs::write(entity.join("2000.webp"), b"n").unwrap();
        fs::write(entity.join("512.webp"), b"n").unwrap();
        fs::write(entity.join(".fetch-failed"), b"1").unwrap();
        fs::write(entity.join("2000-fanart.webp"), b"f").unwrap();
        fs::write(entity.join("512-fanart.webp"), b"f").unwrap();
        fs::write(entity.join("2000-banner.webp"), b"b").unwrap();
        fs::write(entity.join(".miss-fanart"), b"1").unwrap();
        fs::write(entity.join(".miss-banner"), b"1").unwrap();

        assert_eq!(purge_external_files(&root), 5);

        assert!(entity.join("2000.webp").exists());
        assert!(entity.join("512.webp").exists());
        assert!(entity.join(".fetch-failed").exists());
        assert!(!entity.join("2000-fanart.webp").exists());
        assert!(!entity.join("512-fanart.webp").exists());
        assert!(!entity.join("2000-banner.webp").exists());
        assert!(!entity.join(".miss-fanart").exists());
        assert!(!entity.join(".miss-banner").exists());
        let _ = fs::remove_dir_all(&root);
    }
}

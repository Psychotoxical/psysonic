use super::*;

#[tokio::test]
async fn list_device_dir_files_lists_nested_regular_files() {
    let root = tempfile::tempdir().unwrap();
    let track = root.path().join("Artist").join("Album").join("track.flac");
    write_file(&track, b"audio");

    let files = list_device_dir_files_impl(root.path().to_string_lossy().to_string())
        .await
        .unwrap();

    assert_eq!(files, vec![track.to_string_lossy().to_string()]);
}

#[cfg(unix)]
#[tokio::test]
async fn list_device_dir_files_does_not_follow_directory_symlinks() {
    use std::os::unix::fs::symlink;

    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let outside_track = outside.path().join("private.flac");
    write_file(&outside_track, b"private");
    symlink(outside.path(), root.path().join("escaped")).unwrap();

    let files = list_device_dir_files_impl(root.path().to_string_lossy().to_string())
        .await
        .unwrap();

    assert!(files.is_empty());
}

#[tokio::test]
async fn prune_removes_one_empty_parent_when_levels_is_one() {
    let dir = tempfile::tempdir().unwrap();
    let leaf_dir = dir.path().join("a");
    std::fs::create_dir(&leaf_dir).unwrap();
    let file = leaf_dir.join("track.mp3");
    write_file(&file, b"x");
    std::fs::remove_file(&file).unwrap();
    prune_empty_parents(&file, 1).await;
    assert!(
        !leaf_dir.exists(),
        "level 1 prune must remove the empty parent"
    );
}

#[tokio::test]
async fn prune_walks_up_multiple_levels() {
    let dir = tempfile::tempdir().unwrap();
    let nested = dir.path().join("a").join("b").join("c");
    std::fs::create_dir_all(&nested).unwrap();
    let file = nested.join("track.mp3");
    write_file(&file, b"x");
    std::fs::remove_file(&file).unwrap();
    prune_empty_parents(&file, 3).await;
    assert!(!dir.path().join("a").join("b").join("c").exists());
    assert!(!dir.path().join("a").join("b").exists());
    assert!(!dir.path().join("a").exists());
    assert!(dir.path().exists(), "tempdir root must survive");
}

#[tokio::test]
async fn prune_stops_at_non_empty_parent() {
    let dir = tempfile::tempdir().unwrap();
    let parent = dir.path().join("artist");
    let inner = parent.join("album");
    std::fs::create_dir_all(&inner).unwrap();
    let target = inner.join("track.mp3");
    let sibling = parent.join("notes.txt");
    write_file(&target, b"x");
    write_file(&sibling, b"y");
    std::fs::remove_file(&target).unwrap();
    prune_empty_parents(&target, 5).await;
    assert!(!inner.exists(), "empty leaf is pruned");
    assert!(parent.exists(), "non-empty parent must stay");
    assert!(sibling.exists(), "sibling file must stay");
}

#[tokio::test]
async fn prune_with_zero_levels_is_noop() {
    let dir = tempfile::tempdir().unwrap();
    let leaf = dir.path().join("a");
    std::fs::create_dir(&leaf).unwrap();
    let file = leaf.join("track.mp3");
    write_file(&file, b"x");
    std::fs::remove_file(&file).unwrap();
    prune_empty_parents(&file, 0).await;
    assert!(leaf.exists(), "levels=0 must not remove anything");
}

#[tokio::test]
async fn delete_device_files_returns_count_of_existing_paths_removed() {
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("a.mp3");
    let b = dir.path().join("b.mp3");
    write_file(&a, b"a");
    write_file(&b, b"b");
    let missing = dir.path().join("missing.mp3").to_string_lossy().to_string();
    let result = delete_device_files_impl(
        dir.path().to_string_lossy().to_string(),
        vec![
            a.to_string_lossy().to_string(),
            b.to_string_lossy().to_string(),
            missing,
        ],
    )
    .await
    .unwrap();
    assert_eq!(result, 2, "missing paths are silently skipped");
    assert!(!a.exists());
    assert!(!b.exists());
}

#[tokio::test]
async fn delete_device_files_prunes_two_levels_of_empty_parents() {
    let dir = tempfile::tempdir().unwrap();
    let nested = dir.path().join("artist").join("album");
    std::fs::create_dir_all(&nested).unwrap();
    let track = nested.join("01 - track.mp3");
    write_file(&track, b"audio");
    let _ = delete_device_files_impl(
        dir.path().to_string_lossy().to_string(),
        vec![track.to_string_lossy().to_string()],
    )
    .await
    .unwrap();
    assert!(!track.exists());
    assert!(!nested.exists(), "level 1 (album) pruned");
    assert!(
        !dir.path().join("artist").exists(),
        "level 2 (artist) pruned",
    );
}

#[tokio::test]
async fn delete_device_files_returns_zero_for_empty_input() {
    let dir = tempfile::tempdir().unwrap();
    let result = delete_device_files_impl(dir.path().to_string_lossy().to_string(), vec![])
        .await
        .unwrap();
    assert_eq!(result, 0);
}

#[tokio::test]
async fn rollback_device_files_removes_only_the_fresh_paths() {
    let dir = tempfile::tempdir().unwrap();
    let fresh = dir.path().join("Artist/Album/fresh.flac");
    let existing = dir.path().join("Artist/Album/existing.flac");
    write_file(&fresh, b"fresh");
    write_file(&existing, b"existing");

    rollback_device_files(dir.path(), vec![fresh.clone()])
        .await
        .unwrap();

    assert!(!fresh.exists());
    assert!(existing.exists());
}

#[tokio::test]
async fn delete_device_files_rejects_paths_outside_the_selected_root() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let target = outside.path().join("host-file.txt");
    write_file(&target, b"keep");

    let result = delete_device_files_impl(
        root.path().to_string_lossy().to_string(),
        vec![target.to_string_lossy().to_string()],
    )
    .await;

    assert_eq!(result, Err("DEVICE_SYNC_PATH_ESCAPES_ROOT".to_string()));
    assert!(target.exists());
}

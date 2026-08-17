use super::super::rename::{
    planned_path_stays_within, rename_pairs_within_root, resolve_within_root,
};

// The paths `rename_device_files` receives are rendered from a template in
// `psysonic-sync.json`, a file that lives on the device rather than under our
// control. These tests ensure that file cannot reach past the selected root.

#[test]
fn a_plain_relative_path_resolves_under_the_root() {
    let root = std::path::Path::new("/media/device");
    let resolved = resolve_within_root(root, "Artist/Album/01 Song.mp3")
        .expect("an ordinary track path must be accepted");
    assert!(resolved.starts_with(root));
}

#[test]
fn a_parent_component_is_rejected_anywhere_in_the_path() {
    let root = std::path::Path::new("/media/device");
    for rel in [
        "../escape.mp3",
        "Artist/../../escape.mp3",
        "Artist/Album/../../../escape.mp3",
        "..",
    ] {
        assert!(
            resolve_within_root(root, rel).is_none(),
            "{rel} walks out of the device root"
        );
    }
}

#[test]
// Demonstrating the very thing `clippy::join_absolute_paths` warns about.
// Worth noting that the lint could never have caught the original defect:
// it only fires on literals, and production joins a variable.
#[allow(clippy::join_absolute_paths)]
fn an_absolute_path_is_rejected_rather_than_replacing_the_root() {
    // The reason this matters: `join` does not sandbox. Given an absolute
    // path it drops the base and hands back the absolute path unchanged, so
    // without this check the root is not merely escaped — it is ignored.
    let root = std::path::Path::new("/media/device");
    assert_eq!(
        root.join("/etc/passwd"),
        std::path::Path::new("/etc/passwd")
    );
    assert!(resolve_within_root(root, "/etc/passwd").is_none());
}

#[cfg(target_os = "windows")]
#[test]
#[allow(clippy::join_absolute_paths)]
fn a_windows_prefix_or_unc_path_is_rejected() {
    let root = std::path::Path::new(r"E:\Device");
    assert_eq!(
        root.join(r"C:\Windows\System32\x.txt"),
        std::path::Path::new(r"C:\Windows\System32\x.txt")
    );
    for rel in [
        r"C:\Windows\System32\x.txt",
        r"\\server\share\y.txt",
        r"\Windows\x.txt",
    ] {
        assert!(
            resolve_within_root(root, rel).is_none(),
            "{rel} leaves the device root"
        );
    }
}

#[test]
fn an_empty_path_is_rejected() {
    let root = std::path::Path::new("/media/device");
    assert!(resolve_within_root(root, "").is_none());
    assert!(resolve_within_root(root, "   ").is_none());
}

#[test]
fn a_current_dir_component_is_harmless() {
    let root = std::path::Path::new("/media/device");
    assert!(resolve_within_root(root, "./Artist/Album/01 Song.mp3").is_some());
}

#[test]
fn rename_reports_an_escaping_pair_instead_of_moving_anything() {
    let device = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();

    let victim = outside.path().join("victim.txt");
    std::fs::write(&victim, b"private").unwrap();

    // The shape a hostile template produces: a source that climbs out of the
    // device root, with the destination staying inside it.
    let escaping = format!(
        "..{sep}{}{sep}victim.txt",
        outside.path().file_name().unwrap().to_string_lossy(),
        sep = std::path::MAIN_SEPARATOR,
    );
    let results = rename_pairs_within_root(
        device.path(),
        vec![(escaping, "Artist/Album/01 Song.mp3".to_string())],
    );

    assert_eq!(results.len(), 1);
    assert!(!results[0].ok, "an escaping pair must not be renamed");
    assert_eq!(
        results[0].error.as_deref(),
        Some("path escapes the device root")
    );
    assert!(
        victim.exists(),
        "the file outside the root must be untouched"
    );
}

#[test]
fn a_planned_target_is_judged_by_its_nearest_existing_ancestor() {
    // The target does not exist yet — its parent is about to be created —
    // so containment has to be decided from the closest ancestor that does.
    let device = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();

    let inside = device
        .path()
        .join("Artist")
        .join("Album")
        .join("01 Song.mp3");
    assert!(planned_path_stays_within(device.path(), &inside).unwrap());

    let elsewhere = outside.path().join("Album").join("01 Song.mp3");
    assert!(!planned_path_stays_within(device.path(), &elsewhere).unwrap());
}

/// Creates a directory symlink on either platform. On Windows this needs
/// Developer Mode or admin rights; where they are missing the caller skips
/// rather than fails, so the test stays meaningful on the platforms that can
/// run it instead of being switched off everywhere.
fn try_symlink_dir(target: &std::path::Path, link: &std::path::Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link)
    }
    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_dir(target, link)
    }
}

#[test]
fn a_target_behind_a_directory_symlink_is_refused_before_anything_is_created() {
    // The syntax check cannot see a link: `Artist/Album/01 Song.mp3` reads as
    // a perfectly ordinary relative path while resolving outside the root.
    //
    // The source has to exist, or the "source not found" branch answers first
    // and the containment check is never reached — which is exactly how an
    // earlier version of this test passed without exercising anything.
    let device = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let source = device.path().join("Old").join("track.mp3");
    std::fs::create_dir_all(source.parent().unwrap()).unwrap();
    std::fs::write(&source, b"audio").unwrap();

    if try_symlink_dir(outside.path(), &device.path().join("Artist")).is_err() {
        eprintln!("skipped: this machine cannot create directory symlinks");
        return;
    }

    let results = rename_pairs_within_root(
        device.path(),
        vec![(
            "Old/track.mp3".to_string(),
            "Artist/Album/01 Song.mp3".to_string(),
        )],
    );

    assert!(!results[0].ok, "a target behind a symlink must be refused");
    assert_eq!(
        results[0].error.as_deref(),
        Some("path escapes the device root"),
        "and refused for that reason, not because something else failed first"
    );
    assert!(
        !outside.path().join("Album").exists(),
        "nothing may be created outside the root, not even a directory"
    );
    assert!(source.exists(), "the source must still be where it was");
}

#[test]
fn rename_still_moves_an_ordinary_file() {
    // The counterpart: the guard must not break the migration it protects.
    let device = tempfile::tempdir().unwrap();
    let old_rel = format!(
        "Old{sep}Album{sep}track.mp3",
        sep = std::path::MAIN_SEPARATOR
    );
    let source = device.path().join(&old_rel);
    std::fs::create_dir_all(source.parent().unwrap()).unwrap();
    std::fs::write(&source, b"audio").unwrap();

    let new_rel = format!(
        "Artist{sep}Album{sep}01 Song.mp3",
        sep = std::path::MAIN_SEPARATOR
    );
    let results = rename_pairs_within_root(device.path(), vec![(old_rel, new_rel.clone())]);

    assert!(results[0].ok, "error was {:?}", results[0].error);
    assert!(device.path().join(&new_rel).exists());
    assert!(!source.exists());
}

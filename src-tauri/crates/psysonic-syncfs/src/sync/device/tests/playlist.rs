use super::*;

#[test]
fn playlist_replacement_never_leaves_partial_contents() {
    let device = tempfile::tempdir().unwrap();
    let first = track(|track| track.title = "First".to_string());
    let second = track(|track| track.title = "Second".to_string());

    write_playlist_m3u8_within_root(device.path(), "Road Trip", None, &[first]).unwrap();
    write_playlist_m3u8_within_root(device.path(), "Road Trip", None, &[second]).unwrap();

    let directory = playlist_directory_name("Road Trip", None);

    let playlist = std::fs::read_to_string(
        device
            .path()
            .join("Playlists")
            .join(&directory)
            .join(format!("{directory}.m3u8")),
    )
    .unwrap();
    assert_eq!(
        playlist,
        "#EXTM3U\n#EXTINF:180,Artist - Second\n01 - Artist - Second.flac\n"
    );
}

#[cfg(unix)]
#[test]
fn playlist_write_rejects_a_symlink_escape() {
    use std::os::unix::fs::symlink;

    let device = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    symlink(outside.path(), device.path().join("Playlists")).unwrap();

    let result = write_playlist_m3u8_within_root(
        device.path(),
        "Escaped",
        Some("playlist-1"),
        &[track(|_| {})],
    );

    assert_eq!(result, Err("DEVICE_SYNC_PATH_ESCAPES_ROOT".to_string()));
    assert!(!outside.path().join("Escaped/Escaped.m3u8").exists());
}

#[test]
fn playlist_ids_disambiguate_identical_display_names() {
    let device = tempfile::tempdir().unwrap();
    let first_id = "playlist-1";
    let second_id = "playlist-2";

    write_playlist_m3u8_within_root(
        device.path(),
        "Road/Trip",
        Some(first_id),
        &[track(|track| track.title = "First".to_string())],
    )
    .unwrap();
    write_playlist_m3u8_within_root(
        device.path(),
        "Road:Trip",
        Some(second_id),
        &[track(|track| track.title = "Second".to_string())],
    )
    .unwrap();

    let first = playlist_directory_name("Road/Trip", Some(first_id));
    let second = playlist_directory_name("Road:Trip", Some(second_id));
    assert_ne!(first, second);
    assert!(device
        .path()
        .join("Playlists")
        .join(&first)
        .join(format!("{first}.m3u8"))
        .exists());
    assert!(device
        .path()
        .join("Playlists")
        .join(&second)
        .join(format!("{second}.m3u8"))
        .exists());
}

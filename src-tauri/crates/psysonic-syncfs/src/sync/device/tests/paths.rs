use super::*;

#[test]
fn sanitize_replaces_each_invalid_char_with_underscore() {
    assert_eq!(
        sanitize_path_component("a/b\\c:d*e?f\"g<h>i|j"),
        "a_b_c_d_e_f_g_h_i_j"
    );
}

#[test]
fn sanitize_collapses_does_not_merge_acdc_with_ac_slash_dc() {
    // Important: AC/DC must NOT collapse to ACDC (which equals plain "ACDC").
    // It becomes AC_DC so the two artists stay distinguishable on disk.
    assert_eq!(sanitize_path_component("AC/DC"), "AC_DC");
    assert_ne!(
        sanitize_path_component("AC/DC"),
        sanitize_path_component("ACDC")
    );
}

#[test]
fn sanitize_replaces_control_characters() {
    assert_eq!(sanitize_path_component("a\nb\tc\0d"), "a_b_c_d");
}

#[test]
fn sanitize_trims_leading_and_trailing_dots_and_spaces() {
    assert_eq!(sanitize_path_component("  ..hello..  "), "hello");
    assert_eq!(sanitize_path_component(".."), "");
    assert_eq!(sanitize_path_component("   "), "");
}

#[test]
fn sanitize_keeps_inner_dots_and_spaces() {
    assert_eq!(
        sanitize_path_component("Pink Floyd - The Wall"),
        "Pink Floyd - The Wall"
    );
    assert_eq!(sanitize_path_component("01.intro"), "01.intro");
}

#[test]
fn sanitize_preserves_unicode() {
    assert_eq!(
        sanitize_path_component("Sigur Rós — Ágætis byrjun"),
        "Sigur Rós — Ágætis byrjun"
    );
    assert_eq!(sanitize_path_component("坂本龍一"), "坂本龍一");
}

#[test]
fn sanitize_or_uses_fallback_for_empty_input() {
    assert_eq!(sanitize_or("", "Unknown Artist"), "Unknown Artist");
}

#[test]
fn sanitize_or_uses_fallback_when_sanitize_collapses_to_empty() {
    assert_eq!(sanitize_or("...", "Unknown Album"), "Unknown Album");
    assert_eq!(sanitize_or("   ", "Unknown Album"), "Unknown Album");
}

#[test]
fn sanitize_or_returns_sanitized_when_non_empty() {
    assert_eq!(sanitize_or("Pink Floyd", "fallback"), "Pink Floyd");
    assert_eq!(sanitize_or("AC/DC", "fallback"), "AC_DC");
}

#[test]
fn album_path_uses_album_artist_album_tracknum_title() {
    let track = track(|track| {
        track.album_artist = "Pink Floyd".into();
        track.album = "The Wall".into();
        track.title = "Comfortably Numb".into();
        track.track_number = Some(7);
    });
    assert_eq!(
        norm(build_track_path(&track)),
        "Pink Floyd/The Wall/07 - Comfortably Numb"
    );
}

#[test]
fn album_path_pads_track_number_to_two_digits() {
    let track = track(|track| {
        track.track_number = Some(3);
    });
    assert!(norm(build_track_path(&track)).contains("/03 - "));
}

#[test]
fn album_path_uses_zero_zero_when_track_number_missing() {
    let track = track(|track| {
        track.track_number = None;
    });
    assert!(norm(build_track_path(&track)).contains("/00 - "));
}

#[test]
fn album_path_falls_back_when_album_artist_missing() {
    let track = track(|track| {
        track.album_artist = "".into();
    });
    assert!(norm(build_track_path(&track)).starts_with("Unknown Artist/"));
}

#[test]
fn album_path_falls_back_when_album_missing() {
    let track = track(|track| {
        track.album = "".into();
    });
    assert!(norm(build_track_path(&track)).contains("/Unknown Album/"));
}

#[test]
fn album_path_falls_back_when_title_missing() {
    let track = track(|track| {
        track.title = "".into();
    });
    assert!(norm(build_track_path(&track)).ends_with(" - Unknown Title"));
}

#[test]
fn album_path_sanitizes_each_component_independently() {
    let track = track(|track| {
        track.album_artist = "AC/DC".into();
        track.album = "Back: in/Black".into();
        track.title = "T.N.T.*".into();
        track.track_number = Some(2);
    });
    assert_eq!(
        norm(build_track_path(&track)),
        "AC_DC/Back_ in_Black/02 - T.N.T._"
    );
}

#[test]
fn playlist_path_uses_track_artist_not_album_artist() {
    // Track artist in the playlist filename is useful on a mixed playlist.
    let track = track(|track| {
        track.artist = "Roger Waters".into();
        track.album_artist = "Pink Floyd".into();
        track.title = "The Tide Is Turning".into();
        track.playlist_name = Some("Mix".into());
        track.playlist_index = Some(5);
    });
    assert_eq!(
        norm(build_track_path(&track)),
        "Playlists/Mix/05 - Roger Waters - The Tide Is Turning"
    );
}

#[test]
fn playlist_path_pads_index_to_two_digits() {
    let track = track(|track| {
        track.playlist_name = Some("P".into());
        track.playlist_index = Some(7);
    });
    assert!(norm(build_track_path(&track)).contains("/07 - "));
}

#[test]
fn playlist_path_falls_back_when_playlist_name_missing_string() {
    let track = track(|track| {
        track.playlist_name = Some("".into());
        track.playlist_index = Some(1);
    });
    assert!(norm(build_track_path(&track)).starts_with("Playlists/Unnamed Playlist/"));
}

#[test]
fn playlist_path_falls_back_when_track_artist_missing() {
    let track = track(|track| {
        track.artist = "".into();
        track.playlist_name = Some("Mix".into());
        track.playlist_index = Some(1);
    });
    assert!(norm(build_track_path(&track)).contains(" - Unknown Artist - "));
}

#[test]
fn playlist_path_requires_both_name_and_index() {
    // playlist_name without playlist_index falls through to the album tree.
    let t = track(|t| {
        t.playlist_name = Some("Mix".into());
        t.playlist_index = None;
    });
    let path = norm(build_track_path(&t));
    assert!(!path.starts_with("Playlists/"), "got {path}");

    // playlist_index without playlist_name also falls through to the album tree.
    let t2 = track(|t| {
        t.playlist_name = None;
        t.playlist_index = Some(1);
    });
    let path2 = norm(build_track_path(&t2));
    assert!(!path2.starts_with("Playlists/"), "got {path2}");
}

#[test]
#[cfg(target_os = "windows")]
fn windows_path_uses_backslash_separator() {
    let track = track(|_| {});
    assert!(!build_track_path(&track).contains('/'));
}

#[test]
#[cfg(not(target_os = "windows"))]
fn unix_path_uses_forward_slash_separator() {
    let track = track(|_| {});
    assert!(!build_track_path(&track).contains('\\'));
    assert!(build_track_path(&track).contains('/'));
}

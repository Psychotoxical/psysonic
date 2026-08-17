use super::super::*;
use serde_json::json;

#[test]
fn merge_album_open_subsonic_track_raw_copies_album_flags() {
    let album = json!({ "compilation": true, "releaseTypes": ["Compilation"] });
    let mut song = json!({ "id": "tr_1", "title": "A" });
    merge_album_open_subsonic_track_raw(&album, &mut song);
    assert_eq!(song.get("compilation"), Some(&json!(true)));
    assert_eq!(song.get("releaseTypes"), Some(&json!(["Compilation"])));
}

#[test]
fn merge_album_open_subsonic_track_raw_maps_album_participants_to_album_fields() {
    let album = json!({
        "artists": [{ "id": "ar1", "name": "Ice Nine Kills" }, { "id": "ar2", "name": "Shavo" }],
        "displayArtist": "Ice Nine Kills feat. Shavo",
    });
    let mut song = json!({ "id": "tr_1", "title": "A Work of Art" });
    merge_album_open_subsonic_track_raw(&album, &mut song);
    assert_eq!(
        song.get("albumArtists"),
        Some(&json!([{ "id": "ar1", "name": "Ice Nine Kills" }, { "id": "ar2", "name": "Shavo" }]))
    );
    assert_eq!(
        song.get("displayAlbumArtist"),
        Some(&json!("Ice Nine Kills feat. Shavo"))
    );
    assert_eq!(song.get("artists"), None);
    assert_eq!(song.get("displayArtist"), None);
}

#[test]
fn merge_album_open_subsonic_track_raw_keeps_track_own_album_artists() {
    let album = json!({ "artists": [{ "id": "ar1", "name": "Album Artist" }] });
    let mut song = json!({
        "id": "tr_1",
        "albumArtists": [{ "id": "ar9", "name": "Track's Own" }],
    });
    merge_album_open_subsonic_track_raw(&album, &mut song);
    assert_eq!(
        song.get("albumArtists"),
        Some(&json!([{ "id": "ar9", "name": "Track's Own" }]))
    );
}

#[test]
fn merge_album_open_subsonic_track_raw_fills_null_and_empty_song_participants() {
    let album = json!({
        "artists": [{ "id": "ar1", "name": "Album Artist" }],
        "displayArtist": "Album Artist",
    });
    for empty in [json!(null), json!([])] {
        let mut song = json!({ "id": "tr_1", "albumArtists": empty, "displayAlbumArtist": "" });
        merge_album_open_subsonic_track_raw(&album, &mut song);
        assert_eq!(
            song.get("albumArtists"),
            Some(&json!([{ "id": "ar1", "name": "Album Artist" }]))
        );
        assert_eq!(song.get("displayAlbumArtist"), Some(&json!("Album Artist")));
    }
}

#[test]
fn merge_album_open_subsonic_track_raw_ignores_empty_album_participants() {
    let album = json!({ "artists": [], "displayArtist": "   " });
    let mut song = json!({ "id": "tr_1" });
    merge_album_open_subsonic_track_raw(&album, &mut song);
    assert_eq!(song.get("albumArtists"), None);
    assert_eq!(song.get("displayAlbumArtist"), None);
}

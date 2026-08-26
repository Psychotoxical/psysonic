//! Path-aware canonicalization for persisted Navidrome JSON payloads.

use serde_json::{Map, Value};

use crate::navidrome_id_codec::{canonical_artwork_id, canonical_id};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NavidromePayloadKind {
    Artist,
    Album,
    Track,
}

pub fn canonical_payload(
    raw_json: Option<&str>,
    kind: NavidromePayloadKind,
) -> Result<Option<String>, String> {
    let Some(raw_json) = raw_json else {
        return Ok(None);
    };
    if raw_json.trim().is_empty() {
        return Ok(Some(raw_json.to_string()));
    }

    let mut value: Value = serde_json::from_str(raw_json)
        .map_err(|error| format!("invalid {kind:?} raw_json: {error}"))?;
    if !value.is_object() {
        return Err(format!("{kind:?} raw_json must be a JSON object"));
    }
    let original = value.clone();
    match kind {
        NavidromePayloadKind::Artist => rewrite_artist(&mut value),
        NavidromePayloadKind::Album => rewrite_album(&mut value),
        NavidromePayloadKind::Track => rewrite_track(&mut value),
    }
    reject_unknown_transformable_values(&value, "$", None)?;

    if value == original {
        Ok(Some(raw_json.to_string()))
    } else {
        serde_json::to_string(&value)
            .map(Some)
            .map_err(|error| format!("failed to serialize {kind:?} raw_json: {error}"))
    }
}

/// Prefer the canonical survivor payload while filling only missing values
/// from the legacy payload. Both inputs are canonicalized and validated before
/// they participate in the merge.
pub fn merge_canonical_payloads(
    destination: Option<&str>,
    source: Option<&str>,
    kind: NavidromePayloadKind,
) -> Result<Option<String>, String> {
    let destination = canonical_payload(destination, kind)?;
    let source = canonical_payload(source, kind)?;
    match (destination, source) {
        (None, None) => Ok(None),
        (Some(value), None) | (None, Some(value)) => Ok(Some(value)),
        (Some(destination), Some(source)) => {
            if destination.trim().is_empty() {
                return Ok(Some(source));
            }
            if source.trim().is_empty() {
                return Ok(Some(destination));
            }
            let mut destination_value: Value = serde_json::from_str(&destination)
                .map_err(|error| format!("invalid canonical {kind:?} destination: {error}"))?;
            let source_value: Value = serde_json::from_str(&source)
                .map_err(|error| format!("invalid canonical {kind:?} source: {error}"))?;
            fill_missing_json(&mut destination_value, &source_value);
            serde_json::to_string(&destination_value)
                .map(Some)
                .map_err(|error| format!("failed to serialize merged {kind:?} raw_json: {error}"))
        }
    }
}

fn fill_missing_json(destination: &mut Value, source: &Value) {
    match (destination, source) {
        (Value::Object(destination), Value::Object(source)) => {
            for (key, source_value) in source {
                match destination.get_mut(key) {
                    Some(destination_value) => fill_missing_json(destination_value, source_value),
                    None => {
                        destination.insert(key.clone(), source_value.clone());
                    }
                }
            }
        }
        (destination @ Value::Null, source) => *destination = source.clone(),
        (Value::String(destination), Value::String(source))
            if destination.is_empty() && !source.is_empty() =>
        {
            *destination = source.clone();
        }
        (Value::Array(destination), Value::Array(source))
            if destination.is_empty() && !source.is_empty() =>
        {
            *destination = source.clone();
        }
        _ => {}
    }
}

fn rewrite_artist(value: &mut Value) {
    let Some(object) = value.as_object_mut() else {
        return;
    };
    rewrite_entity_field(object, "id");
    rewrite_artwork_fields(object);
}

fn rewrite_album(value: &mut Value) {
    let Some(object) = value.as_object_mut() else {
        return;
    };
    rewrite_entity_field(object, "id");
    rewrite_entity_field(object, "artistId");
    rewrite_entity_field(object, "albumArtistId");
    rewrite_artist_array(object, "artists");
    rewrite_artist_array(object, "albumArtists");
    rewrite_artwork_fields(object);

    if let Some(disc_titles) = object.get_mut("discTitles").and_then(Value::as_array_mut) {
        for disc_title in disc_titles {
            if let Some(disc) = disc_title.as_object_mut() {
                rewrite_artwork_fields(disc);
            }
        }
    }
    if let Some(songs) = object.get_mut("song").and_then(Value::as_array_mut) {
        for song in songs {
            rewrite_track(song);
        }
    }
}

fn rewrite_track(value: &mut Value) {
    let Some(object) = value.as_object_mut() else {
        return;
    };
    for key in [
        "id",
        "parent",
        "albumId",
        "artistId",
        "albumArtistId",
        "libraryId",
        "library_id",
        "musicFolderId",
    ] {
        rewrite_entity_field(object, key);
    }
    rewrite_artist_array(object, "artists");
    rewrite_artist_array(object, "albumArtists");
    rewrite_artwork_fields(object);

    if let Some(contributors) = object.get_mut("contributors").and_then(Value::as_array_mut) {
        for contributor in contributors {
            let Some(contributor) = contributor.as_object_mut() else {
                continue;
            };
            rewrite_entity_field(contributor, "artistId");
            if let Some(artist) = contributor.get_mut("artist").and_then(Value::as_object_mut) {
                rewrite_entity_field(artist, "id");
            }
        }
    }

    if let Some(participants) = object.get_mut("participants").and_then(Value::as_object_mut) {
        for entries in participants.values_mut().filter_map(Value::as_array_mut) {
            for entry in entries {
                let Some(entry) = entry.as_object_mut() else {
                    continue;
                };
                rewrite_entity_field(entry, "id");
                rewrite_entity_field(entry, "artistId");
                if let Some(artist) = entry.get_mut("artist").and_then(Value::as_object_mut) {
                    rewrite_entity_field(artist, "id");
                }
            }
        }
    }
}

fn rewrite_artist_array(object: &mut Map<String, Value>, key: &str) {
    let Some(artists) = object.get_mut(key).and_then(Value::as_array_mut) else {
        return;
    };
    for artist in artists {
        if let Some(artist) = artist.as_object_mut() {
            rewrite_entity_field(artist, "id");
        }
    }
}

fn rewrite_artwork_fields(object: &mut Map<String, Value>) {
    for key in ["coverArt", "coverArtId"] {
        let Some(Value::String(value)) = object.get_mut(key) else {
            continue;
        };
        *value = canonical_artwork_id(value);
    }
}

fn rewrite_entity_field(object: &mut Map<String, Value>, key: &str) {
    let Some(Value::String(value)) = object.get_mut(key) else {
        return;
    };
    *value = canonical_id(value);
}

fn reject_unknown_transformable_values(
    value: &Value,
    path: &str,
    key: Option<&str>,
) -> Result<(), String> {
    match value {
        Value::Object(object) => {
            for (child_key, child) in object {
                let child_path = format!("{path}.{child_key}");
                reject_unknown_transformable_values(child, &child_path, Some(child_key))?;
            }
        }
        Value::Array(items) => {
            for (index, child) in items.iter().enumerate() {
                let child_path = format!("{path}[{index}]");
                reject_unknown_transformable_values(child, &child_path, key)?;
            }
        }
        Value::String(text) => {
            if !is_identity_looking_key(key) || is_explicitly_excluded(path, key) {
                return Ok(());
            }
            if canonical_id(text) != *text || canonical_artwork_id(text) != *text {
                return Err(format!(
                    "unclassified transformable Navidrome ID at {path}"
                ));
            }
        }
        _ => {}
    }
    Ok(())
}

fn is_identity_looking_key(key: Option<&str>) -> bool {
    let key = key.unwrap_or_default().to_ascii_lowercase();
    key == "id"
        || key == "parent"
        || key.ends_with("id")
        || key.ends_with("ids")
        || key.contains("coverart")
}

fn is_explicitly_excluded(path: &str, key: Option<&str>) -> bool {
    let key = key.unwrap_or_default().to_ascii_lowercase();
    key.contains("musicbrainz")
        || key.starts_with("mbz")
        || key.contains("checksum")
        || key.contains("hash")
        || matches!(
            key.as_str(),
            "isrc"
                | "path"
                | "serverpath"
                | "sourceid"
                | "externalid"
                | "canonicalid"
                | "profileid"
                | "serverid"
        )
        || (key == "id" && path.contains(".genres["))
}

#[cfg(test)]
mod tests {
    use super::*;

    const LEGACY_TRACK: &str = "e3b7fc2ae9447bbec37a13bf916e3cf6";
    const CANONICAL_TRACK: &str = "6VHl3uR4kss6sUPKA8Cwnk";
    const LEGACY_ALBUM: &str = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
    const CANONICAL_ALBUM: &str = "7rke2SAWaicSeSYzkhww6R";
    const LEGACY_ARTIST: &str = "00112233445566778899aabbccddeeff";

    #[test]
    fn rewrites_track_typed_paths_and_preserves_exclusions() {
        let raw = serde_json::json!({
            "id": LEGACY_TRACK,
            "parent": LEGACY_ALBUM,
            "albumId": LEGACY_ALBUM,
            "artistId": LEGACY_ARTIST,
            "albumArtistId": LEGACY_ARTIST,
            "libraryId": LEGACY_ALBUM,
            "coverArt": format!("tr-{LEGACY_TRACK}"),
            "artists": [{ "id": LEGACY_ARTIST, "name": "Artist" }],
            "albumArtists": [{ "id": LEGACY_ARTIST, "name": "Album artist" }],
            "contributors": [
                { "artistId": LEGACY_ARTIST, "role": "composer" },
                { "artist": { "id": LEGACY_ARTIST }, "role": "producer" }
            ],
            "participants": {
                "artist": [{ "id": LEGACY_ARTIST, "name": "Artist" }],
                "composer": [{ "artist": { "id": LEGACY_ARTIST }, "name": "Composer" }]
            },
            "genres": [{ "id": LEGACY_ARTIST, "name": "Rock" }],
            "mbzRecordingId": LEGACY_ALBUM,
            "path": LEGACY_ALBUM,
            "contentHash": LEGACY_ALBUM
        })
        .to_string();

        let rewritten = canonical_payload(Some(&raw), NavidromePayloadKind::Track)
            .unwrap()
            .unwrap();
        let value: Value = serde_json::from_str(&rewritten).unwrap();
        assert_eq!(value["id"], CANONICAL_TRACK);
        assert_eq!(value["albumId"], CANONICAL_ALBUM);
        assert_eq!(value["coverArt"], format!("tr-{CANONICAL_TRACK}"));
        assert_eq!(value["mbzRecordingId"], LEGACY_ALBUM);
        assert_eq!(value["genres"][0]["id"], LEGACY_ARTIST);
        assert_eq!(value["path"], LEGACY_ALBUM);
    }

    #[test]
    fn rewrites_album_nested_tracks_and_disc_artwork() {
        let raw = serde_json::json!({
            "id": LEGACY_ALBUM,
            "artistId": LEGACY_ARTIST,
            "coverArt": format!("al-{LEGACY_ALBUM}"),
            "discTitles": [{ "disc": 1, "coverArt": format!("dc-{LEGACY_ALBUM}:1") }],
            "song": [{ "id": LEGACY_TRACK, "albumId": LEGACY_ALBUM }]
        })
        .to_string();
        let rewritten = canonical_payload(Some(&raw), NavidromePayloadKind::Album)
            .unwrap()
            .unwrap();
        let value: Value = serde_json::from_str(&rewritten).unwrap();
        assert_eq!(value["id"], CANONICAL_ALBUM);
        assert_eq!(
            value["discTitles"][0]["coverArt"],
            format!("dc-{CANONICAL_ALBUM}:1")
        );
        assert_eq!(value["song"][0]["id"], CANONICAL_TRACK);
    }

    #[test]
    fn blocks_unknown_transformable_paths_and_malformed_payloads() {
        let unknown = serde_json::json!({ "futureOwner": { "id": LEGACY_TRACK } }).to_string();
        assert!(canonical_payload(Some(&unknown), NavidromePayloadKind::Track)
            .unwrap_err()
            .contains("futureOwner.id"));
        assert!(canonical_payload(Some("{"), NavidromePayloadKind::Track).is_err());
        assert!(canonical_payload(Some("[]"), NavidromePayloadKind::Track).is_err());
    }

    #[test]
    fn preserves_legacy_shaped_values_in_ordinary_text_fields() {
        let raw = serde_json::json!({
            "id": CANONICAL_TRACK,
            "title": LEGACY_TRACK,
            "name": LEGACY_ALBUM,
            "comment": LEGACY_ARTIST
        })
        .to_string();

        assert_eq!(
            canonical_payload(Some(&raw), NavidromePayloadKind::Track).unwrap(),
            Some(raw)
        );
    }

    #[test]
    fn preserves_null_empty_and_unchanged_payloads() {
        assert_eq!(
            canonical_payload(None, NavidromePayloadKind::Artist).unwrap(),
            None
        );
        assert_eq!(
            canonical_payload(Some(""), NavidromePayloadKind::Artist).unwrap(),
            Some(String::new())
        );
        assert_eq!(
            canonical_payload(Some("{}"), NavidromePayloadKind::Artist).unwrap(),
            Some("{}".to_string())
        );
    }

    #[test]
    fn survivor_payload_keeps_current_values_and_fills_missing_fields() {
        let destination = serde_json::json!({
            "id": CANONICAL_TRACK,
            "title": "Current",
            "artistId": null,
            "artists": []
        })
        .to_string();
        let source = serde_json::json!({
            "id": LEGACY_TRACK,
            "title": "Legacy",
            "artistId": LEGACY_ARTIST,
            "artists": [{ "id": LEGACY_ARTIST, "name": "Artist" }],
            "suffix": "flac"
        })
        .to_string();

        let merged = merge_canonical_payloads(
            Some(&destination),
            Some(&source),
            NavidromePayloadKind::Track,
        )
        .unwrap()
        .unwrap();
        let value: Value = serde_json::from_str(&merged).unwrap();
        assert_eq!(value["title"], "Current");
        assert_eq!(value["artistId"], canonical_id(LEGACY_ARTIST));
        assert_eq!(value["artists"][0]["id"], canonical_id(LEGACY_ARTIST));
        assert_eq!(value["suffix"], "flac");
    }
}

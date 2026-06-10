//! Atomic genre resolution for multi-value tags (OpenSubsonic `genres[]` first,
//! Navidrome-default string split as fallback).

use std::collections::HashSet;

use rusqlite::{params, Transaction};
use serde_json::Value;

const GENRE_SEPARATORS: [&str; 3] = [";", "/", ","];

/// Fallback split when the server sent no `genres[]` array (legacy Subsonic).
pub fn split_genre_tags(raw: &str) -> Vec<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    let mut parts = vec![trimmed.to_string()];
    for sep in GENRE_SEPARATORS {
        let mut next = Vec::new();
        for part in parts {
            for sub in part.split(sep) {
                next.push(sub.to_string());
            }
        }
        parts = next;
    }
    dedupe_genres(parts)
}

fn dedupe_genres(genres: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for g in genres {
        let t = g.trim();
        if t.is_empty() {
            continue;
        }
        let key = t.to_ascii_lowercase();
        if seen.insert(key) {
            out.push(t.to_string());
        }
    }
    out
}

fn parse_genres_array_value(value: &Value) -> Option<Vec<String>> {
    let arr = value.as_array()?;
    if arr.is_empty() {
        return None;
    }
    let mut out = Vec::new();
    for item in arr {
        if let Some(name) = item.get("name").and_then(|v| v.as_str()) {
            let t = name.trim();
            if !t.is_empty() {
                out.push(t.to_string());
            }
        } else if let Some(s) = item.as_str() {
            let t = s.trim();
            if !t.is_empty() {
                out.push(t.to_string());
            }
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(dedupe_genres(out))
    }
}

fn parse_genres_json_str(genres_json: &str) -> Option<Vec<String>> {
    let trimmed = genres_json.trim();
    if trimmed.is_empty() {
        return None;
    }
    let value: Value = serde_json::from_str(trimmed).ok()?;
    parse_genres_array_value(&value)
}

/// Source-priority resolver (§2.0): `genres[]` from parsed payload, else split `genre`.
pub fn genres_for_track_value(raw_json: &Value, genre: Option<&str>) -> Vec<String> {
    if let Some(genres) = raw_json.get("genres").and_then(parse_genres_array_value) {
        return genres;
    }
    genre
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(split_genre_tags)
        .unwrap_or_default()
}

/// Backfill path: `genres_json` from `json_extract(raw_json, '$.genres')`.
pub fn genres_for_track_extracted(genres_json: Option<&str>, genre: Option<&str>) -> Vec<String> {
    if let Some(json) = genres_json {
        if let Some(genres) = parse_genres_json_str(json) {
            return genres;
        }
    }
    genre
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(split_genre_tags)
        .unwrap_or_default()
}

pub fn genres_for_track_raw_json(raw_json: &str, genre: Option<&str>) -> Vec<String> {
    if let Ok(value) = serde_json::from_str::<Value>(raw_json) {
        return genres_for_track_value(&value, genre);
    }
    genre
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(split_genre_tags)
        .unwrap_or_default()
}

pub fn replace_track_genre_rows(
    tx: &Transaction<'_>,
    server_id: &str,
    track_id: &str,
    album_id: Option<&str>,
    library_id: Option<&str>,
    genres: &[String],
) -> rusqlite::Result<()> {
    tx.execute(
        "DELETE FROM track_genre WHERE server_id = ?1 AND track_id = ?2",
        params![server_id, track_id],
    )?;
    if genres.is_empty() {
        return Ok(());
    }
    let mut insert = tx.prepare_cached(
        "INSERT OR IGNORE INTO track_genre (server_id, track_id, genre, album_id, library_id) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
    )?;
    for genre in genres {
        insert.execute(params![server_id, track_id, genre, album_id, library_id])?;
    }
    Ok(())
}

pub fn delete_track_genre_for_track(
    conn: &rusqlite::Connection,
    server_id: &str,
    track_id: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM track_genre WHERE server_id = ?1 AND track_id = ?2",
        params![server_id, track_id],
    )?;
    Ok(())
}

pub fn delete_track_genre_for_server_tracks(
    conn: &rusqlite::Connection,
    server_id: &str,
    track_ids: &[String],
) -> rusqlite::Result<()> {
    if track_ids.is_empty() {
        return Ok(());
    }
    for id in track_ids {
        delete_track_genre_for_track(conn, server_id, id)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn split_separators_and_dedupe() {
        assert_eq!(
            split_genre_tags("Rock/Jazz"),
            vec!["Rock".to_string(), "Jazz".to_string()]
        );
        assert_eq!(
            split_genre_tags("Rock; Jazz, Electronic"),
            vec![
                "Rock".to_string(),
                "Jazz".to_string(),
                "Electronic".to_string()
            ]
        );
        assert_eq!(split_genre_tags("Rock/rock/ROCK"), vec!["Rock".to_string()]);
        assert!(split_genre_tags("").is_empty());
    }

    #[test]
    fn array_wins_over_genre_string() {
        let raw = json!({
            "genres": [{"name": "A"}, {"name": "B"}],
            "genre": "A/B/C"
        });
        assert_eq!(
            genres_for_track_value(&raw, Some("A/B/C")),
            vec!["A".to_string(), "B".to_string()]
        );
    }

    #[test]
    fn bare_string_array_and_empty_array_fallback() {
        let bare = json!({ "genres": ["A", "B"] });
        assert_eq!(
            genres_for_track_value(&bare, None),
            vec!["A".to_string(), "B".to_string()]
        );
        let empty = json!({ "genres": [], "genre": "A/B" });
        assert_eq!(
            genres_for_track_value(&empty, Some("A/B")),
            vec!["A".to_string(), "B".to_string()]
        );
    }

    #[test]
    fn extracted_json_matches_value_path() {
        let genres_json = r#"[{"name":"Jazz"},{"name":"Rock"}]"#;
        assert_eq!(
            genres_for_track_extracted(Some(genres_json), Some("Noise/Metal")),
            vec!["Jazz".to_string(), "Rock".to_string()]
        );
    }
}

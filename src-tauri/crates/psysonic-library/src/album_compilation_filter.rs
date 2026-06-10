//! OpenSubsonic compilation flag in entity `raw_json` (Navidrome: `compilation`,
//! `isCompilation`, or `releaseTypes` containing `Compilation`), plus the same
//! "Various Artists" heuristics the web UI uses when structured flags are absent.

/// SQL predicate on any row with a `raw_json` column (album or track).
pub fn compilation_raw_json_sql(table_alias: &str) -> String {
    let a = table_alias;
    // `NULL IN (...)` is unknown in SQL — wrap each probe in EXISTS so non-comp rows stay false.
    format!(
        "(EXISTS ( \
           SELECT 1 WHERE json_extract({a}.raw_json, '$.compilation') IN (1, '1', 'true', 'TRUE') \
         ) OR EXISTS ( \
           SELECT 1 WHERE json_extract({a}.raw_json, '$.isCompilation') IN (1, '1', 'true', 'TRUE') \
         ) OR EXISTS ( \
           SELECT 1 FROM json_each(COALESCE(json_extract({a}.raw_json, '$.releaseTypes'), '[]')) AS rt \
           WHERE lower(rt.value) = 'compilation' \
         ))"
    )
}

fn various_artists_like_sql(column: &str) -> String {
    format!(
        "lower(trim(coalesce({column}, ''))) LIKE '%various artists%'",
        column = column
    )
}

/// Full compilation predicate for browse filters — JSON flags plus VA artist labels.
pub fn compilation_predicate_sql(
    table_alias: &str,
    artist_column: Option<&str>,
    album_artist_column: Option<&str>,
) -> String {
    let mut parts = vec![compilation_raw_json_sql(table_alias)];
    parts.push(format!(
        "lower(trim(coalesce(json_extract({a}.raw_json, '$.displayArtist'), ''))) LIKE '%various artists%'",
        a = table_alias
    ));
    if let Some(col) = artist_column {
        parts.push(various_artists_like_sql(col));
    }
    if let Some(col) = album_artist_column {
        parts.push(various_artists_like_sql(col));
    }
    format!("({})", parts.join(" OR "))
}

pub fn various_artists_label(s: &str) -> bool {
    s.trim().to_ascii_lowercase().contains("various artists")
}

/// SQL mirror of [`pick_album_group_artist`] for track-grouped browse subqueries
/// (`la`). Used where `ORDER BY` / `COALESCE(a.artist, …)` must stay in SQL;
/// keep both implementations in sync.
pub fn sql_track_group_display_artist(alias: &str) -> String {
    format!(
        "CASE WHEN trim(coalesce({a}.album_artist, '')) != '' \
         THEN trim({a}.album_artist) \
         ELSE NULLIF(trim(coalesce({a}.artist, '')), '') END",
        a = alias
    )
}

/// Row-mapper form of the album-artist display rule — mirror of
/// [`sql_track_group_display_artist`]. Prefer a non-empty album-artist tag;
/// fall back to track artist only when album artist is absent (solo albums without TALB).
pub fn pick_album_group_artist(
    track_artist: Option<String>,
    album_artist: Option<String>,
) -> Option<String> {
    let aa = album_artist.as_deref().unwrap_or("").trim();
    if !aa.is_empty() {
        return Some(aa.to_string());
    }
    track_artist.filter(|s| !s.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sql_mentions_json_paths() {
        let sql = compilation_raw_json_sql("t");
        assert!(sql.contains("$.compilation"));
        assert!(sql.contains("$.releaseTypes"));
    }

    #[test]
    fn predicate_includes_artist_columns() {
        let sql = compilation_predicate_sql("t", Some("t.artist"), Some("t.album_artist"));
        assert!(sql.contains("t.artist"));
        assert!(sql.contains("t.album_artist"));
        assert!(sql.contains("$.displayArtist"));
    }

    #[test]
    fn pick_album_group_artist_prefers_nonempty_album_artist() {
        assert_eq!(
            pick_album_group_artist(Some("Alice".into()), Some("Various Artists".into())),
            Some("Various Artists".to_string())
        );
        assert_eq!(
            pick_album_group_artist(Some("Groove Armada".into()), Some("Underworld".into())),
            Some("Underworld".to_string())
        );
        assert_eq!(
            pick_album_group_artist(Some("Alice".into()), Some("Bob".into())),
            Some("Bob".to_string())
        );
    }

    #[test]
    fn pick_album_group_artist_falls_back_to_track_artist() {
        assert_eq!(
            pick_album_group_artist(Some("Alice".into()), None),
            Some("Alice".to_string())
        );
        assert_eq!(
            pick_album_group_artist(Some("Alice".into()), Some("".into())),
            Some("Alice".to_string())
        );
        assert_eq!(pick_album_group_artist(None, None), None);
    }

    #[test]
    fn sql_track_group_display_artist_matches_pick_album_group_artist() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE la (artist TEXT, album_artist TEXT)",
            [],
        )
        .unwrap();
        let sql = format!("SELECT {} FROM la", sql_track_group_display_artist("la"));

        let cases: [(&str, &str); 7] = [
            ("Groove Armada", "Underworld"),
            ("Alice", ""),
            ("", "Various Artists"),
            ("Alice", "Bob"),
            ("  ", "Bob"),
            ("Alice", "   "),
            ("", ""),
        ];

        for (track, album) in cases {
            conn.execute("DELETE FROM la", []).unwrap();
            conn.execute(
                "INSERT INTO la (artist, album_artist) VALUES (?1, ?2)",
                rusqlite::params![track, album],
            )
            .unwrap();
            let sql_out: Option<String> = conn.query_row(&sql, [], |r| r.get(0)).ok();
            let rust_out = pick_album_group_artist(
                (!track.is_empty()).then(|| track.to_string()),
                (!album.is_empty()).then(|| album.to_string()),
            );
            assert_eq!(
                sql_out, rust_out,
                "track={track:?} album={album:?}"
            );
        }
    }
}

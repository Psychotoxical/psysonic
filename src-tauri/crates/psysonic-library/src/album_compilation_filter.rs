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

/// SQL mirror of [`pick_album_group_artist`] over arbitrary column *expressions*
/// rather than a table alias — the album browse groups by album and therefore has
/// to feed aggregates (`MAX(t.artist)`, `MAX(t.album_artist)`), while the
/// multi-library dedup path feeds projected columns (`artist`, `album_artist`).
/// Single source of the rule; keep in sync with [`pick_album_group_artist`].
pub fn sql_display_artist_from(track_artist: &str, album_artist: &str) -> String {
    format!(
        "CASE WHEN trim(coalesce({aa}, '')) != '' \
         THEN trim({aa}) \
         ELSE NULLIF(trim(coalesce({ta}, '')), '') END",
        aa = album_artist,
        ta = track_artist,
    )
}

/// SQL mirror of [`pick_album_group_artist`] for track-grouped browse subqueries
/// (`la`). Used where `ORDER BY` / `COALESCE(a.artist, …)` must stay in SQL;
/// keep both implementations in sync.
pub fn sql_track_group_display_artist(alias: &str) -> String {
    sql_display_artist_from(
        &format!("{alias}.artist"),
        &format!("{alias}.album_artist"),
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

    /// Same parity, but for the **aggregate** form the grouped album browse sorts on.
    ///
    /// `map_album_from_tracks` builds a row's display artist as
    /// `pick_album_group_artist(MAX(artist), MAX(album_artist))`, so the sort key
    /// must be `sql_display_artist_from("MAX(t.artist)", "MAX(t.album_artist)")` over
    /// the same aggregates — anything else sorts the album under a name the row does
    /// not show (#1217). The multi-row groups here are the point: a single row cannot
    /// tell an aggregate apart from a bare column.
    #[test]
    fn sql_display_artist_from_aggregates_matches_pick_album_group_artist() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute("CREATE TABLE t (artist TEXT, album_artist TEXT)", [])
            .unwrap();
        let sql = format!(
            "SELECT {} FROM t",
            sql_display_artist_from("MAX(t.artist)", "MAX(t.album_artist)"),
        );

        // Each case is one album's worth of tracks — album_artist deliberately sparse.
        let groups: [&[(&str, Option<&str>)]; 5] = [
            // Featured guest on one track only; the album artist is what shows.
            &[("Alpha", Some("Alpha")), ("Alpha feat. Zulu", None)],
            // Album artist on the *second* track — MAX still has to find it.
            &[("Alpha feat. Zulu", None), ("Alpha", Some("Alpha"))],
            // No album artist anywhere: falls back to the track credit.
            &[("Alpha", None), ("Alpha feat. Zulu", None)],
            // Blank strings must not count as an album artist.
            &[("Alice", Some("   ")), ("Alice feat. Bob", Some(""))],
            // Compilation: every track carries the same album artist.
            &[("Alice", Some("Various Artists")), ("Bob", Some("Various Artists"))],
        ];

        for rows in groups {
            conn.execute("DELETE FROM t", []).unwrap();
            for (artist, album_artist) in rows {
                conn.execute(
                    "INSERT INTO t (artist, album_artist) VALUES (?1, ?2)",
                    rusqlite::params![artist, album_artist],
                )
                .unwrap();
            }
            let sql_out: Option<String> = conn.query_row(&sql, [], |r| r.get(0)).unwrap();

            // The Rust side of the same decision, over the same aggregates.
            let max_artist = rows.iter().map(|(a, _)| *a).max().map(str::to_string);
            let max_album_artist = rows
                .iter()
                .filter_map(|(_, aa)| *aa)
                .max()
                .map(str::to_string);
            let rust_out = pick_album_group_artist(max_artist, max_album_artist);

            assert_eq!(sql_out, rust_out, "rows={rows:?}");
        }
    }
}

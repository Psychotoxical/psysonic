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

pub(crate) fn various_artists_like_sql(column: &str) -> String {
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

/// True when a credit is the "Various Artists" compilation label. Word-boundary
/// matched to stay identical to the frontend `isVariousArtistsLabel`
/// (`/\bvarious artists\b/i`): both gate the same album-artist unlink on the same
/// album, so a substring match here against a word-boundary match there would let one
/// side unlink while the other relinks to a guest performer. (The album-inclusion
/// `LIKE '%various artists%'` in `various_artists_like_sql` stays a substring match —
/// that is a different decision.)
pub fn various_artists_label(s: &str) -> bool {
    const NEEDLE: &str = "various artists";
    let hay = s.trim().to_ascii_lowercase();
    let bytes = hay.as_bytes();
    let is_word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    let mut from = 0;
    while let Some(rel) = hay[from..].find(NEEDLE) {
        let start = from + rel;
        let end = start + NEEDLE.len();
        let before_boundary = start == 0 || !is_word(bytes[start - 1]);
        let after_boundary = end >= bytes.len() || !is_word(bytes[end]);
        if before_boundary && after_boundary {
            return true;
        }
        from = start + 1;
    }
    false
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

/// Id-side mirror of [`pick_album_group_artist`]: pick the *artist id* the album
/// header should link to. When the album carries a named album-artist — so the
/// displayed credit comes from `album_artist` — the link must point at that
/// album-artist entity (`raw_json.albumArtistId`), not a representative track's
/// `artist_id`. On a "Various Artists" compilation the album-artist id differs
/// from every track performer's id; without this the hero reads "Various Artists"
/// but opens one of the guest performers. Falls back to the track artist id when
/// the album has no named album-artist, or when the server supplied no
/// album-artist id (keeps the credit and link consistent rather than mislabelling).
/// Keep the branch condition in sync with [`pick_album_group_artist`].
pub fn pick_album_group_artist_id(
    track_artist_id: Option<String>,
    album_artist: Option<&str>,
    album_artist_id: Option<String>,
) -> Option<String> {
    let named = album_artist.map(str::trim).filter(|s| !s.is_empty());
    if named.is_some() {
        if let Some(id) = album_artist_id.filter(|s| !s.trim().is_empty()) {
            return Some(id);
        }
    }
    // A "Various Artists" credit with no album-artist id must stay unlinked: the
    // track performer is definitely *not* the album artist here, so linking to it
    // would open a single guest under a Various Artists label. Everywhere else the
    // performer id keeps credit and link on the same entity.
    if named.is_some_and(various_artists_label) {
        return None;
    }
    track_artist_id.filter(|s| !s.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn various_artists_label_is_word_boundary_matched() {
        assert!(various_artists_label("Various Artists"));
        assert!(various_artists_label("  various artists  "));
        assert!(various_artists_label("VA / Various Artists"));
        assert!(various_artists_label("Various Artists!"));
        // Word-boundary, mirroring the frontend regex: an alnum-adjacent occurrence
        // is not the label. These are exactly the strings a substring match would
        // have disagreed with the frontend on.
        assert!(!various_artists_label("various artistsX"));
        assert!(!various_artists_label("Xvarious artists"));
        assert!(!various_artists_label("Metallica"));
        assert!(!various_artists_label(""));
    }

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
    fn pick_album_group_artist_id_mirrors_name_side() {
        // Named album-artist with an id → link to that album-artist entity, even
        // though the representative track performer differs (the VA / collaboration
        // case: display credit and link stay on the same entity).
        assert_eq!(
            pick_album_group_artist_id(
                Some("track-performer".into()),
                Some("Various Artists"),
                Some("va-id".into()),
            ),
            Some("va-id".to_string())
        );
        // Named "Various Artists" but the server gave no album-artist id → leave the
        // link empty. The track performer is provably not the album artist here, so
        // linking to it would open one guest under a Various Artists credit.
        assert_eq!(
            pick_album_group_artist_id(Some("track-performer".into()), Some("Various Artists"), None),
            None
        );
        // Any other named album-artist without an id keeps the track id, so credit
        // and link stay on the same entity rather than going blank.
        assert_eq!(
            pick_album_group_artist_id(Some("track-performer".into()), Some("Alice"), None),
            Some("track-performer".to_string())
        );
        // Blank album-artist must not count as named → fall back to the track id,
        // ignoring any stray album-artist id.
        assert_eq!(
            pick_album_group_artist_id(Some("solo".into()), Some("   "), Some("ignored".into())),
            Some("solo".to_string())
        );
        assert_eq!(
            pick_album_group_artist_id(Some("solo".into()), None, None),
            Some("solo".to_string())
        );
        // Nothing usable anywhere.
        assert_eq!(pick_album_group_artist_id(None, Some("Various Artists"), Some("  ".into())), None);
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

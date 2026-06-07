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

/// Track-grouped album rows: prefer album artist when it marks a VA compilation.
pub fn pick_album_group_artist(
    track_artist: Option<String>,
    album_artist: Option<String>,
) -> Option<String> {
    let aa = album_artist.as_deref().unwrap_or("").trim();
    if various_artists_label(aa) {
        return Some(aa.to_string());
    }
    track_artist
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
    fn pick_album_group_artist_prefers_va_album_artist() {
        assert_eq!(
            pick_album_group_artist(Some("Alice".into()), Some("Various Artists".into())),
            Some("Various Artists".to_string())
        );
        assert_eq!(
            pick_album_group_artist(Some("Alice".into()), Some("Bob".into())),
            Some("Alice".to_string())
        );
    }
}

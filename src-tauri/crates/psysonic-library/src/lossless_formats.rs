//! Shared lossless container allowlist — keep in sync with
//! `src/utils/library/losslessFormats.ts` and `LOSSLESS_SUFFIXES` in
//! `src/api/navidromeBrowse.ts`.

/// File extensions for containers that are *only* lossless (no lossy variant).
pub const LOSSLESS_SUFFIXES: &[&str] = &[
    "flac", "wav", "wave", "aiff", "aif", "dsf", "dff", "ape", "wv", "shn", "tta",
];

/// `LOWER(alias.suffix) IN ('flac', …)` for SQL WHERE clauses.
pub fn track_is_lossless_sql(table_alias: &str) -> String {
    let list = LOSSLESS_SUFFIXES
        .iter()
        .map(|s| format!("'{s}'"))
        .collect::<Vec<_>>()
        .join(", ");
    format!("LOWER({table_alias}.suffix) IN ({list})")
}

/// Album has at least one indexed lossless track (same allowlist as browse).
pub fn album_has_lossless_track_sql(album_table_alias: &str) -> String {
    format!(
        "EXISTS (SELECT 1 FROM track lt \
         WHERE lt.server_id = {album_table_alias}.server_id \
           AND lt.album_id = {album_table_alias}.id \
           AND lt.deleted = 0 \
           AND {})",
        track_is_lossless_sql("lt")
    )
}

/// Artist has at least one indexed lossless track credited to `artist_id`.
pub fn artist_has_lossless_track_sql(artist_table_alias: &str) -> String {
    format!(
        "EXISTS (SELECT 1 FROM track lt \
         WHERE lt.server_id = {artist_table_alias}.server_id \
           AND lt.artist_id = {artist_table_alias}.id \
           AND lt.deleted = 0 \
           AND {})",
        track_is_lossless_sql("lt")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn track_is_lossless_sql_lists_all_suffixes() {
        let sql = track_is_lossless_sql("t");
        assert!(sql.contains("'flac'"));
        assert!(sql.contains("'tta'"));
        assert!(sql.starts_with("LOWER(t.suffix) IN ("));
    }
}

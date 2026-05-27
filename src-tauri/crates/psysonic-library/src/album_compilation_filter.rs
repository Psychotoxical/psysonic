//! OpenSubsonic compilation flag on album `raw_json` (Navidrome: `compilation`,
//! `isCompilation`, or `releaseTypes` containing `Compilation`).

/// SQL predicate: album row is a compilation (parameter-free).
pub fn album_is_compilation_sql(album_table_alias: &str) -> String {
    let a = album_table_alias;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sql_mentions_json_paths() {
        let sql = album_is_compilation_sql("a");
        assert!(sql.contains("$.compilation"));
        assert!(sql.contains("$.releaseTypes"));
    }
}

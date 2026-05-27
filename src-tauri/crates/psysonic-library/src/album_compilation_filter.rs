//! OpenSubsonic compilation flag in entity `raw_json` (Navidrome: `compilation`,
//! `isCompilation`, or `releaseTypes` containing `Compilation`).

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sql_mentions_json_paths() {
        let sql = compilation_raw_json_sql("t");
        assert!(sql.contains("$.compilation"));
        assert!(sql.contains("$.releaseTypes"));
    }
}

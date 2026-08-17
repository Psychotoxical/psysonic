use rusqlite::{params, params_from_iter};

use super::TrackRepository;

impl TrackRepository<'_> {
    /// Live tracks with no `library_id` hot column (multi-library scope gap).
    pub fn count_untagged_tracks(&self, server_id: &str) -> Result<u64, String> {
        self.store
            .with_read_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM track \
                 WHERE server_id = ?1 AND deleted = 0 \
                   AND (library_id IS NULL OR library_id = '')",
                    params![server_id],
                    |row| row.get::<_, i64>(0),
                )
            })
            .map(|n| n.max(0) as u64)
            .map_err(|e| e.to_string())
    }

    /// Tag empty `library_id` rows by album membership. Only fills rows
    /// where `library_id` is NULL/empty so prior tags are never clobbered.
    pub fn tag_library_by_album_ids(
        &self,
        server_id: &str,
        library_id: &str,
        album_ids: &[String],
    ) -> Result<u64, String> {
        if album_ids.is_empty() {
            return Ok(0);
        }
        const CHUNK: usize = 400;
        let mut total = 0u64;
        self.store
            .with_conn_mut("track.tag_library_by_album_ids", |conn| {
                let tx = conn.transaction()?;
                for chunk in album_ids.chunks(CHUNK) {
                    let placeholders = (0..chunk.len()).map(|_| "?").collect::<Vec<_>>().join(", ");
                    let changed_album_sql = format!(
                        "SELECT DISTINCT album_id FROM track \
                         WHERE server_id = ? AND deleted = 0 \
                           AND album_id IN ({placeholders}) \
                           AND (library_id IS NULL OR library_id = '')"
                    );
                    let mut changed_params: Vec<rusqlite::types::Value> =
                        vec![rusqlite::types::Value::Text(server_id.to_string())];
                    changed_params.extend(chunk.iter().cloned().map(Into::into));
                    let changed_album_ids = {
                        let mut statement = tx.prepare(&changed_album_sql)?;
                        let rows = statement
                            .query_map(params_from_iter(changed_params.iter()), |row| row.get(0))?
                            .collect::<rusqlite::Result<Vec<String>>>()?;
                        rows
                    };
                    if changed_album_ids.is_empty() {
                        continue;
                    }
                    let changed_placeholders = (0..changed_album_ids.len())
                        .map(|_| "?")
                        .collect::<Vec<_>>()
                        .join(", ");
                    let sql = format!(
                        "UPDATE track SET library_id = ?1 \
                     WHERE server_id = ?2 AND deleted = 0 \
                       AND album_id IN ({changed_placeholders}) \
                       AND (library_id IS NULL OR library_id = '')"
                    );
                    let mut params: Vec<rusqlite::types::Value> = vec![
                        rusqlite::types::Value::Text(library_id.to_string()),
                        rusqlite::types::Value::Text(server_id.to_string()),
                    ];
                    params.extend(changed_album_ids.iter().cloned().map(Into::into));
                    let n = tx.execute(&sql, params_from_iter(params.iter()))?;
                    total += n as u64;
                    tx.execute(
                        &format!(
                            "UPDATE track_genre SET library_id = ?1 \
                         WHERE server_id = ?2 AND track_id IN ( \
                            SELECT id FROM track WHERE server_id = ?2 \
                              AND album_id IN ({changed_placeholders}) AND library_id = ?1 \
                         ) AND COALESCE(library_id, '') != ?1"
                        ),
                        params_from_iter(params.iter()),
                    )?;
                    crate::identity::refresh_library_ids_for_albums(
                        &tx,
                        server_id,
                        &changed_album_ids,
                    )?;
                    crate::browse_projection::refresh_library_tagged_albums(
                        &tx,
                        server_id,
                        library_id,
                        &changed_album_ids,
                    )?;
                }
                tx.commit()?;
                Ok(total)
            })
    }
}

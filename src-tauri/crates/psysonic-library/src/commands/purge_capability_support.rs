use rusqlite::params;

use crate::dto::PurgeReportDto;
use crate::repos::SyncStateRepository;
use crate::runtime::LibraryRuntime;
use crate::store::LibraryStore;
use crate::sync::capability::CapabilityFlags;
use crate::sync::tombstone::should_auto_reconcile_scope;

pub(super) fn purge_server_data(
    runtime: &LibraryRuntime,
    server_id: &str,
    include_offline: bool,
) -> Result<PurgeReportDto, String> {
    let mut report = PurgeReportDto::default();
    runtime
        .store
        .with_conn_mut("cmd.purge_server", |conn| {
            let tx = conn.transaction()?;
            let track_count: i64 = tx.query_row(
                "SELECT COUNT(*) FROM track WHERE server_id = ?1",
                params![server_id],
                |r| r.get(0),
            )?;
            let album_count: i64 = tx.query_row(
                "SELECT COUNT(*) FROM album WHERE server_id = ?1",
                params![server_id],
                |r| r.get(0),
            )?;
            let artist_count: i64 = tx.query_row(
                "SELECT COUNT(*) FROM artist WHERE server_id = ?1",
                params![server_id],
                |r| r.get(0),
            )?;
            let offline_count: i64 = tx.query_row(
                "SELECT COUNT(*) FROM track_offline WHERE server_id = ?1",
                params![server_id],
                |r| r.get(0),
            )?;
            let offline_bytes: Option<i64> = tx
                .query_row(
                    "SELECT SUM(file_size_bytes) FROM track_offline WHERE server_id = ?1",
                    params![server_id],
                    |r| r.get(0),
                )
                .ok();

            // Tear down child rows first (no cascade configured) so
            // the FK constraints on track stay happy.
            tx.execute(
                "DELETE FROM track_extension WHERE server_id = ?1",
                params![server_id],
            )?;
            tx.execute(
                "DELETE FROM track_fact WHERE server_id = ?1",
                params![server_id],
            )?;
            tx.execute(
                "DELETE FROM track_artifact WHERE server_id = ?1",
                params![server_id],
            )?;
            tx.execute(
                "DELETE FROM track_canonical_link WHERE server_id = ?1",
                params![server_id],
            )?;
            tx.execute(
                "DELETE FROM track_id_history WHERE server_id = ?1",
                params![server_id],
            )?;
            tx.execute(
                "DELETE FROM play_session WHERE server_id = ?1",
                params![server_id],
            )?;
            tx.execute(
                "DELETE FROM track_genre WHERE server_id = ?1",
                params![server_id],
            )?;
            tx.execute(
                "DELETE FROM canonical_enrichment_link WHERE owner_server_id = ?1",
                params![server_id],
            )?;
            tx.execute(
                "DELETE FROM album_browse_projection WHERE server_id = ?1",
                params![server_id],
            )?;
            tx.execute(
                "DELETE FROM composer_album_projection WHERE server_id = ?1",
                params![server_id],
            )?;
            tx.execute(
                "DELETE FROM artist_artwork_lookup WHERE server_id = ?1",
                params![server_id],
            )?;
            tx.execute(
                "DELETE FROM entity_user_rating WHERE server_id = ?1",
                params![server_id],
            )?;
            tx.execute(
                "DELETE FROM library_tag_state WHERE server_id = ?1",
                params![server_id],
            )?;
            tx.execute(
                "DELETE FROM library_tag_cursor WHERE server_id = ?1",
                params![server_id],
            )?;
            tx.execute(
                "DELETE FROM cluster.track_cluster_key WHERE server_id = ?1",
                params![server_id],
            )?;
            tx.execute(
                "DELETE FROM cluster.cluster_meta WHERE key = ?1",
                params![format!("dirty_server:{server_id}")],
            )?;
            tx.execute(
                "DELETE FROM identity_invalidation WHERE server_id = ?1",
                params![server_id],
            )?;
            tx.execute("DELETE FROM track WHERE server_id = ?1", params![server_id])?;
            tx.execute("DELETE FROM album WHERE server_id = ?1", params![server_id])?;
            tx.execute(
                "DELETE FROM artist WHERE server_id = ?1",
                params![server_id],
            )?;
            tx.execute(
                "DELETE FROM sync_state WHERE server_id = ?1",
                params![server_id],
            )?;
            if include_offline {
                tx.execute(
                    "DELETE FROM track_offline WHERE server_id = ?1",
                    params![server_id],
                )?;
            }
            tx.commit()?;

            report.tracks_deleted = track_count.max(0) as u32;
            report.albums_deleted = album_count.max(0) as u32;
            report.artists_deleted = artist_count.max(0) as u32;
            report.offline_rows_deleted = if include_offline {
                offline_count.max(0) as u32
            } else {
                0
            };
            report.bytes_freed = if include_offline {
                offline_bytes.unwrap_or(0).max(0)
            } else {
                0
            };
            Ok(())
        })
        .map_err(|e| e.to_string())?;

    Ok(report)
}

pub(super) fn load_capability_flags(
    runtime: &LibraryRuntime,
    server_id: &str,
    library_scope: &str,
) -> Result<CapabilityFlags, String> {
    let bits = SyncStateRepository::new(&runtime.store)
        .get_capability_flags(server_id, library_scope)?
        .unwrap_or(0);
    Ok(CapabilityFlags::new(bits))
}

pub(super) fn compute_tombstone_budget(
    store: &LibraryStore,
    server_id: &str,
    library_scope: &str,
) -> u32 {
    let sync_state = SyncStateRepository::new(store);
    let local = sync_state
        .get_local_track_count(server_id, library_scope)
        .ok()
        .flatten()
        .unwrap_or(0)
        .max(0) as u32;
    let server = sync_state
        .get_server_track_count(server_id, library_scope)
        .ok()
        .flatten()
        .unwrap_or(0)
        .max(0) as u32;
    if should_auto_reconcile_scope(
        library_scope,
        local,
        server,
        crate::sync::scheduler::DEFAULT_TOMBSTONE_THRESHOLD_PCT,
    ) {
        crate::sync::budget::RequestBudget::DELTA_MISMATCH_CAP
    } else {
        0
    }
}

#[cfg(test)]
mod tests;

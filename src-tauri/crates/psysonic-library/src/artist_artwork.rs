//! External artist artwork lookup table accessors (fanart.tv etc.) —
//! image-scraper design-review §12. Render NEVER reads this; only the
//! on-demand cover ensure path + the `mbid_ambiguous` 24h negative cache use
//! it. `server_id` is the serverIndexKey (§27), not the auth-profile UUID.

use rusqlite::OptionalExtension;

use crate::store::LibraryStore;

/// One `artist_artwork_lookup` row. The `(server_id, artist_id, surface_kind)`
/// primary key is implied by the lookup; this carries the resolution state.
#[derive(Debug, Clone)]
pub struct ArtistArtworkRow {
    pub mbid: Option<String>,
    pub mbid_source: Option<String>,
    pub status: String,
    pub provider: Option<String>,
    pub updated_at: i64,
}

/// Fetch the cached lookup row for `(server_id, artist_id, surface_kind)`, if any.
pub fn get_artist_artwork(
    store: &LibraryStore,
    server_id: &str,
    artist_id: &str,
    surface_kind: &str,
) -> Result<Option<ArtistArtworkRow>, String> {
    store.with_read_conn(|conn| {
        conn.query_row(
            "SELECT mbid, mbid_source, status, provider, updated_at
             FROM artist_artwork_lookup
             WHERE server_id = ?1 AND artist_id = ?2 AND surface_kind = ?3",
            rusqlite::params![server_id, artist_id, surface_kind],
            |row| {
                Ok(ArtistArtworkRow {
                    mbid: row.get(0)?,
                    mbid_source: row.get(1)?,
                    status: row.get(2)?,
                    provider: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            },
        )
        .optional()
    })
}

/// Insert or replace the lookup row for `(server_id, artist_id, surface_kind)`.
#[allow(clippy::too_many_arguments)]
pub fn upsert_artist_artwork(
    store: &LibraryStore,
    server_id: &str,
    artist_id: &str,
    surface_kind: &str,
    mbid: Option<&str>,
    mbid_source: Option<&str>,
    status: &str,
    provider: Option<&str>,
    updated_at: i64,
) -> Result<(), String> {
    store.with_conn_mut("artist_artwork.upsert", |conn| {
        conn.execute(
            "INSERT INTO artist_artwork_lookup
                 (server_id, artist_id, surface_kind, mbid, mbid_source, status, provider, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(server_id, artist_id, surface_kind) DO UPDATE SET
                 mbid        = excluded.mbid,
                 mbid_source = excluded.mbid_source,
                 status      = excluded.status,
                 provider    = excluded.provider,
                 updated_at  = excluded.updated_at",
            rusqlite::params![
                server_id,
                artist_id,
                surface_kind,
                mbid,
                mbid_source,
                status,
                provider,
                updated_at
            ],
        )?;
        Ok(())
    })
}

/// Delete all lookup rows for a server — part of clear-cover-cache-per-server
/// (§12 / Appendix B.4).
pub fn clear_artist_artwork_for_server(
    store: &LibraryStore,
    server_id: &str,
) -> Result<usize, String> {
    store.with_conn_mut("artist_artwork.clear_server", |conn| {
        conn.execute(
            "DELETE FROM artist_artwork_lookup WHERE server_id = ?1",
            rusqlite::params![server_id],
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::LibraryStore;

    #[test]
    fn upsert_then_get_roundtrips_and_replaces() {
        let store = LibraryStore::open_in_memory();
        let sk = "fanart";

        assert!(get_artist_artwork(&store, "srv", "ar-1", sk).unwrap().is_none());

        upsert_artist_artwork(
            &store, "srv", "ar-1", sk, None, None, "no_mbid", None, 1000,
        )
        .unwrap();
        let row = get_artist_artwork(&store, "srv", "ar-1", sk).unwrap().unwrap();
        assert_eq!(row.status, "no_mbid");
        assert_eq!(row.mbid, None);
        assert_eq!(row.updated_at, 1000);

        // Replace (e.g. tag MBID appeared, fanart hit).
        upsert_artist_artwork(
            &store,
            "srv",
            "ar-1",
            sk,
            Some("mbid-123"),
            Some("tag"),
            "hit",
            Some("fanart"),
            2000,
        )
        .unwrap();
        let row = get_artist_artwork(&store, "srv", "ar-1", sk).unwrap().unwrap();
        assert_eq!(row.status, "hit");
        assert_eq!(row.mbid.as_deref(), Some("mbid-123"));
        assert_eq!(row.mbid_source.as_deref(), Some("tag"));
        assert_eq!(row.provider.as_deref(), Some("fanart"));
        assert_eq!(row.updated_at, 2000);

        // Clear-per-server removes it.
        assert_eq!(clear_artist_artwork_for_server(&store, "srv").unwrap(), 1);
        assert!(get_artist_artwork(&store, "srv", "ar-1", sk).unwrap().is_none());
    }
}

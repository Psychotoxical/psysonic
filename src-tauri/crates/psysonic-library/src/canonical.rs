//! H1 — `CanonicalMatcher`: cross-server track identity by **strong keys
//! only** (ISRC, then MBID recording), per spec §5.5A / P13.
//!
//! Runs inline on ingest and is O(1) per track — a deterministic canonical
//! id (`{kind}:{value}`) plus `INSERT … ON CONFLICT DO NOTHING`, so there's
//! no lookup-then-create race and no fuzzy loop on the 500k upsert path
//! (the fuzzy / album-similarity layer is search-time only — §5.5B / H3).
//!
//! v1 does **not** merge across kinds (a recording seen with an ISRC on one
//! server and only an MBID on another yields two canonical rows). Spec §5.5A
//! accepts this; a future merge layer would remap ids without a schema break.

use rusqlite::{params, OptionalExtension, Transaction};

pub const KIND_ISRC: &str = "isrc";
pub const KIND_MBID: &str = "mbid_recording";

/// Resolve (create-if-absent) the canonical id for one strong identity.
/// Idempotent: the deterministic id means re-running over an existing
/// identity is a pair of no-op upserts.
pub fn resolve_canonical_id(
    tx: &Transaction<'_>,
    kind: &str,
    value: &str,
    now: i64,
) -> rusqlite::Result<String> {
    let canonical_id = format!("{kind}:{value}");
    tx.execute(
        "INSERT INTO canonical_track (id, created_at, updated_at) VALUES (?1, ?2, ?2) \
         ON CONFLICT(id) DO NOTHING",
        params![canonical_id, now],
    )?;
    tx.execute(
        "INSERT INTO canonical_identity (canonical_id, kind, value, confidence) \
         VALUES (?1, ?2, ?3, 1.0) \
         ON CONFLICT(kind, value) DO NOTHING",
        params![canonical_id, kind, value],
    )?;
    Ok(canonical_id)
}

/// Link `(server_id, track_id)` to its canonical id for whichever strong key
/// it carries — ISRC preferred, then MBID recording (§5.5A). No-op (returns
/// `Ok(None)`) when the track has neither. Idempotent on re-ingest.
pub fn link_track(
    tx: &Transaction<'_>,
    server_id: &str,
    track_id: &str,
    isrc: Option<&str>,
    mbid_recording: Option<&str>,
    now: i64,
) -> rusqlite::Result<Option<String>> {
    let (kind, value) = match (
        isrc.filter(|s| !s.is_empty()),
        mbid_recording.filter(|s| !s.is_empty()),
    ) {
        (Some(isrc), _) => (KIND_ISRC, isrc),
        (None, Some(mbid)) => (KIND_MBID, mbid),
        (None, None) => return Ok(None),
    };

    let canonical_id = resolve_canonical_id(tx, kind, value, now)?;
    tx.execute(
        "INSERT INTO track_canonical_link \
         (server_id, track_id, canonical_id, match_method, confidence, linked_at) \
         VALUES (?1, ?2, ?3, ?4, 1.0, ?5) \
         ON CONFLICT(server_id, track_id) DO UPDATE SET \
           canonical_id = excluded.canonical_id, \
           match_method = excluded.match_method, \
           confidence   = excluded.confidence, \
           linked_at    = excluded.linked_at",
        params![server_id, track_id, canonical_id, kind, now],
    )?;
    Ok(Some(canonical_id))
}

/// Link every track on `server_id` that carries a strong identity key.
/// Used once after IS-3 bulk ingest instead of per-row inline linking.
pub fn link_all_tracks_for_server(
    store: &crate::store::LibraryStore,
    server_id: &str,
    now: i64,
) -> Result<u32, String> {
    store.with_conn_mut("misc", |conn| {
        let tx = conn.transaction()?;
        let mut stmt = tx.prepare(
            "SELECT id, isrc, mbid_recording FROM track \
             WHERE server_id = ?1 AND deleted = 0 \
               AND (\
                 (isrc IS NOT NULL AND isrc != '') \
                 OR (mbid_recording IS NOT NULL AND mbid_recording != '')\
               )",
        )?;
        let rows: Vec<(String, Option<String>, Option<String>)> = stmt
            .query_map(params![server_id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);
        let mut linked = 0u32;
        for (track_id, isrc, mbid) in rows {
            if link_track(
                &tx,
                server_id,
                &track_id,
                isrc.as_deref(),
                mbid.as_deref(),
                now,
            )?
            .is_some()
            {
                linked = linked.saturating_add(1);
            }
        }
        tx.commit()?;
        Ok(linked)
    })
}

/// Read a track's canonical id, if linked. Convenience for tests / callers.
pub fn canonical_id_for(
    tx: &Transaction<'_>,
    server_id: &str,
    track_id: &str,
) -> rusqlite::Result<Option<String>> {
    tx.query_row(
        "SELECT canonical_id FROM track_canonical_link WHERE server_id = ?1 AND track_id = ?2",
        params![server_id, track_id],
        |r| r.get(0),
    )
    .optional()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::LibraryStore;

    fn with_tx<R>(store: &LibraryStore, f: impl FnOnce(&Transaction<'_>) -> R) -> R {
        store
            .with_conn_mut("misc", |conn| {
                let tx = conn.transaction()?;
                let out = f(&tx);
                tx.commit()?;
                Ok(out)
            })
            .unwrap()
    }

    /// `track_canonical_link` has an FK to `track` — seed a minimal row so
    /// the link insert is valid (foreign_keys are ON in-memory).
    fn seed_track(tx: &Transaction<'_>, server: &str, id: &str) {
        tx.execute(
            "INSERT INTO track (server_id, id, title, synced_at, raw_json) \
             VALUES (?1, ?2, 'T', 1, '{}')",
            params![server, id],
        )
        .unwrap();
    }

    #[test]
    fn resolve_is_deterministic_and_idempotent() {
        let store = LibraryStore::open_in_memory();
        let (a, b) = with_tx(&store, |tx| {
            let a = resolve_canonical_id(tx, KIND_ISRC, "USRC123", 1).unwrap();
            let b = resolve_canonical_id(tx, KIND_ISRC, "USRC123", 2).unwrap();
            (a, b)
        });
        assert_eq!(a, "isrc:USRC123");
        assert_eq!(a, b, "same identity → same canonical id");

        let (tracks, identities): (i64, i64) = store
            .with_conn("misc", |c| {
                Ok((
                    c.query_row("SELECT COUNT(*) FROM canonical_track", [], |r| r.get(0))?,
                    c.query_row("SELECT COUNT(*) FROM canonical_identity", [], |r| r.get(0))?,
                ))
            })
            .unwrap();
        assert_eq!(tracks, 1, "idempotent — no duplicate canonical_track");
        assert_eq!(identities, 1);
    }

    #[test]
    fn link_prefers_isrc_over_mbid() {
        let store = LibraryStore::open_in_memory();
        let cid = with_tx(&store, |tx| {
            seed_track(tx, "s1", "t1");
            link_track(tx, "s1", "t1", Some("USRC1"), Some("mbid-1"), 1).unwrap()
        });
        assert_eq!(cid.as_deref(), Some("isrc:USRC1"));
        let stored =
            with_tx(&store, |tx| canonical_id_for(tx, "s1", "t1").unwrap());
        assert_eq!(stored.as_deref(), Some("isrc:USRC1"));
    }

    #[test]
    fn link_uses_mbid_when_no_isrc() {
        let store = LibraryStore::open_in_memory();
        let cid = with_tx(&store, |tx| {
            seed_track(tx, "s1", "t1");
            link_track(tx, "s1", "t1", None, Some("mbid-9"), 1).unwrap()
        });
        assert_eq!(cid.as_deref(), Some("mbid_recording:mbid-9"));
    }

    #[test]
    fn link_is_noop_without_strong_keys() {
        let store = LibraryStore::open_in_memory();
        let cid = with_tx(&store, |tx| {
            // empty strings count as absent
            link_track(tx, "s1", "t1", Some(""), None, 1).unwrap()
        });
        assert!(cid.is_none());
        let count: i64 = store
            .with_conn("misc", |c| c.query_row("SELECT COUNT(*) FROM track_canonical_link", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn same_isrc_across_servers_shares_one_canonical_id() {
        let store = LibraryStore::open_in_memory();
        let (a, b) = with_tx(&store, |tx| {
            seed_track(tx, "s1", "t1");
            seed_track(tx, "s2", "t9");
            let a = link_track(tx, "s1", "t1", Some("USRC7"), None, 1).unwrap();
            let b = link_track(tx, "s2", "t9", Some("USRC7"), None, 1).unwrap();
            (a, b)
        });
        assert_eq!(a, b);
        let canon_count: i64 = store
            .with_conn("misc", |c| c.query_row("SELECT COUNT(*) FROM canonical_track", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(canon_count, 1, "one canonical row shared across two servers");
    }

    #[test]
    fn relink_updates_existing_row_in_place() {
        let store = LibraryStore::open_in_memory();
        with_tx(&store, |tx| {
            seed_track(tx, "s1", "t1");
            link_track(tx, "s1", "t1", None, Some("mbid-old"), 1).unwrap();
            // Later ingest now carries an ISRC — re-link overwrites.
            link_track(tx, "s1", "t1", Some("USRCnew"), Some("mbid-old"), 2).unwrap();
        });
        let (cid, method): (String, String) = store
            .with_conn("misc", |c| {
                c.query_row(
                    "SELECT canonical_id, match_method FROM track_canonical_link \
                     WHERE server_id = 's1' AND track_id = 't1'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
            })
            .unwrap();
        assert_eq!(cid, "isrc:USRCnew");
        assert_eq!(method, "isrc");
        let link_count: i64 = store
            .with_conn("misc", |c| c.query_row("SELECT COUNT(*) FROM track_canonical_link", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(link_count, 1, "re-link updates in place, no duplicate");
    }
}

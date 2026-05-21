//! E4 — `ArtifactRepository`: typed CRUD over `track_artifact` with the
//! §5.11 / §5.12 storage rules.
//!
//! - **Lazy expiry (P34):** no background GC; a `get` first deletes the
//!   track's expired artifacts of that kind (negative-cache rows included),
//!   then returns the best surviving match.
//! - **Size cap (§5.12 write path):** an artifact over 512 KB is rejected
//!   unless it is a user import (`source_kind == "user"`), so a runaway
//!   lyrics/blob fetch can't bloat `library.sqlite`.
//!
//! The Tauri commands (`library_get_artifact` / `library_put_artifact`)
//! delegate here so there's one source of truth for the storage rules.

use rusqlite::types::Value;
use rusqlite::{params, OptionalExtension};

use crate::dto::{ArtifactInputDto, TrackArtifactDto};
use crate::store::LibraryStore;

/// §5.12: cap a single artifact at 512 KB unless the user imported it.
pub const MAX_ARTIFACT_BYTES: usize = 512 * 1024;

pub struct ArtifactRepository<'a> {
    store: &'a LibraryStore,
}

impl<'a> ArtifactRepository<'a> {
    pub fn new(store: &'a LibraryStore) -> Self {
        Self { store }
    }

    /// Lazily drop the track's expired artifacts of this kind (§5.12
    /// read-path GC — negative-cache rows expire too), then return the most
    /// recent surviving match. `source_kind` / `source_id` / `format` narrow
    /// the lookup when provided so the lyrics path can resolve a specific
    /// source or take the first match.
    // Mirrors the flat parameter list of the `library_get_artifact` Tauri
    // command (a fixed public contract); grouping them here would only
    // diverge the two signatures.
    #[allow(clippy::too_many_arguments)]
    pub fn get(
        &self,
        server_id: &str,
        track_id: &str,
        artifact_kind: &str,
        source_kind: Option<&str>,
        source_id: Option<&str>,
        format: Option<&str>,
        now: i64,
    ) -> Result<Option<TrackArtifactDto>, String> {
        if self.store.bulk_ingest_active() {
            return self.get_readonly(
                server_id,
                track_id,
                artifact_kind,
                source_kind,
                source_id,
                format,
            );
        }
        self.store
            .with_conn_mut("artifact.get_gc", |conn| {
                // Lazy TTL cleanup, scoped to the looked-up kind.
                conn.execute(
                    "DELETE FROM track_artifact \
                     WHERE server_id = ?1 AND track_id = ?2 AND artifact_kind = ?3 \
                       AND expires_at IS NOT NULL AND expires_at < ?4",
                    params![server_id, track_id, artifact_kind, now],
                )?;

                Self::query_one(
                    conn,
                    server_id,
                    track_id,
                    artifact_kind,
                    source_kind,
                    source_id,
                    format,
                )
            })
            .map_err(|e| e.to_string())
    }

    fn get_readonly(
        &self,
        server_id: &str,
        track_id: &str,
        artifact_kind: &str,
        source_kind: Option<&str>,
        source_id: Option<&str>,
        format: Option<&str>,
    ) -> Result<Option<TrackArtifactDto>, String> {
        self.store
            .with_read_conn(|conn| {
                Self::query_one(
                    conn,
                    server_id,
                    track_id,
                    artifact_kind,
                    source_kind,
                    source_id,
                    format,
                )
            })
            .map_err(|e| e.to_string())
    }

    fn query_one(
        conn: &rusqlite::Connection,
        server_id: &str,
        track_id: &str,
        artifact_kind: &str,
        source_kind: Option<&str>,
        source_id: Option<&str>,
        format: Option<&str>,
    ) -> rusqlite::Result<Option<TrackArtifactDto>> {
        let mut sql = String::from(
            "SELECT server_id, track_id, artifact_kind, format, source_kind, source_id, \
             language, content_text, content_bytes, not_found, content_hash, fetched_at, \
             expires_at FROM track_artifact \
             WHERE server_id = ?1 AND track_id = ?2 AND artifact_kind = ?3",
        );
        let mut bound: Vec<Value> = vec![
            Value::Text(server_id.to_string()),
            Value::Text(track_id.to_string()),
            Value::Text(artifact_kind.to_string()),
        ];
        let mut next = 4;
        if let Some(sk) = source_kind {
            sql.push_str(&format!(" AND source_kind = ?{next}"));
            bound.push(Value::Text(sk.to_string()));
            next += 1;
        }
        if let Some(si) = source_id {
            sql.push_str(&format!(" AND source_id = ?{next}"));
            bound.push(Value::Text(si.to_string()));
            next += 1;
        }
        if let Some(fmt) = format {
            sql.push_str(&format!(" AND format = ?{next}"));
            bound.push(Value::Text(fmt.to_string()));
        }
        sql.push_str(" ORDER BY fetched_at DESC LIMIT 1");

        let mut stmt = conn.prepare(&sql)?;
        stmt.query_row(rusqlite::params_from_iter(bound.iter()), row_to_artifact_dto)
            .optional()
    }

    /// E3 readiness: is there a valid (non-expired, non-`not_found`) lyrics
    /// artifact for `(server_id, track_id)`? Pure read — no lazy GC, no writes —
    /// so the `library_get_track` enrichment summary stays read-only.
    pub fn lyrics_cached(&self, server_id: &str, track_id: &str, now: i64) -> Result<bool, String> {
        let query = |conn: &rusqlite::Connection| {
            conn.query_row(
                "SELECT EXISTS ( \
                   SELECT 1 FROM track_artifact \
                   WHERE server_id = ?1 AND track_id = ?2 \
                     AND artifact_kind = 'lyrics' \
                     AND not_found = 0 \
                     AND (expires_at IS NULL OR expires_at >= ?3) \
                 )",
                params![server_id, track_id, now],
                |r| r.get::<_, i64>(0),
            )
        };
        let exists = if self.store.bulk_ingest_active() {
            self.store.with_read_conn(query)?
        } else {
            self.store.with_conn("artifact.lyrics_cached", query)?
        };
        Ok(exists != 0)
    }

    /// Upsert an artifact. Rejects content over [`MAX_ARTIFACT_BYTES`] unless
    /// it is a user import (§5.12). A negative-cache row (`not_found`) carries
    /// no content, so it always fits.
    pub fn put(
        &self,
        server_id: &str,
        track_id: &str,
        artifact: &ArtifactInputDto,
        now: i64,
    ) -> Result<(), String> {
        let actual = artifact.content_text.as_ref().map_or(0, |s| s.len())
            + artifact.content_blob.as_ref().map_or(0, |b| b.len());
        let declared = usize::try_from(artifact.content_bytes).unwrap_or(0);
        let size = actual.max(declared);
        if size > MAX_ARTIFACT_BYTES && artifact.source_kind != "user" {
            return Err(format!(
                "artifact too large: {size} bytes exceeds {MAX_ARTIFACT_BYTES} cap \
                 (source_kind={})",
                artifact.source_kind
            ));
        }

        self.store
            .with_conn("artifact.put", |conn| {
                conn.execute(
                    UPSERT_ARTIFACT,
                    params![
                        server_id,
                        track_id,
                        artifact.artifact_kind,
                        artifact.format,
                        artifact.language,
                        artifact.source_kind,
                        artifact.source_id,
                        artifact.content_text,
                        artifact.content_blob,
                        artifact.content_bytes,
                        if artifact.not_found { 1_i64 } else { 0 },
                        artifact.content_hash,
                        now,
                        artifact.expires_at,
                    ],
                )?;
                Ok(())
            })
            .map_err(|e| e.to_string())
    }
}

fn row_to_artifact_dto(row: &rusqlite::Row<'_>) -> rusqlite::Result<TrackArtifactDto> {
    Ok(TrackArtifactDto {
        server_id: row.get(0)?,
        track_id: row.get(1)?,
        artifact_kind: row.get(2)?,
        format: row.get(3)?,
        source_kind: row.get(4)?,
        source_id: row.get(5)?,
        language: row.get(6)?,
        content_text: row.get(7)?,
        content_bytes: row.get(8)?,
        not_found: row.get::<_, i64>(9)? != 0,
        content_hash: row.get(10)?,
        fetched_at: row.get(11)?,
        expires_at: row.get(12)?,
    })
}

const UPSERT_ARTIFACT: &str = "INSERT INTO track_artifact \
  (server_id, track_id, artifact_kind, format, language, source_kind, source_id, \
   content_text, content_blob, content_bytes, not_found, content_hash, fetched_at, expires_at) \
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14) \
  ON CONFLICT(server_id, track_id, artifact_kind, source_kind, source_id, format) DO UPDATE SET \
    language = excluded.language, \
    content_text = excluded.content_text, \
    content_blob = excluded.content_blob, \
    content_bytes = excluded.content_bytes, \
    not_found = excluded.not_found, \
    content_hash = excluded.content_hash, \
    fetched_at = excluded.fetched_at, \
    expires_at = excluded.expires_at";

#[cfg(test)]
mod tests {
    use super::*;

    fn artifact(
        kind: &str,
        format: &str,
        source_kind: &str,
        source_id: &str,
    ) -> ArtifactInputDto {
        ArtifactInputDto {
            artifact_kind: kind.into(),
            format: format.into(),
            source_kind: source_kind.into(),
            source_id: source_id.into(),
            language: None,
            content_text: Some("la la la".into()),
            content_blob: None,
            content_bytes: 0,
            not_found: false,
            content_hash: None,
            expires_at: None,
        }
    }

    fn seed_track(store: &LibraryStore, server: &str, id: &str) {
        store
            .with_conn("misc", |c| {
                c.execute(
                    "INSERT INTO track (server_id, id, title, synced_at, raw_json) \
                     VALUES (?1, ?2, 'T', 1, '{}')",
                    params![server, id],
                )
            })
            .unwrap();
    }

    #[test]
    fn put_then_get_roundtrips() {
        let store = LibraryStore::open_in_memory();
        seed_track(&store, "s1", "t1");
        let repo = ArtifactRepository::new(&store);
        repo.put("s1", "t1", &artifact("lyrics", "plain", "lrclib", "lrclib"), 100)
            .unwrap();
        let got = repo
            .get("s1", "t1", "lyrics", None, None, None, 200)
            .unwrap()
            .expect("artifact present");
        assert_eq!(got.artifact_kind, "lyrics");
        assert_eq!(got.content_text.as_deref(), Some("la la la"));
    }

    #[test]
    fn get_lazily_deletes_expired_artifact() {
        let store = LibraryStore::open_in_memory();
        seed_track(&store, "s1", "t1");
        let repo = ArtifactRepository::new(&store);
        let mut a = artifact("lyrics", "plain", "lrclib", "lrclib");
        a.expires_at = Some(150);
        repo.put("s1", "t1", &a, 100).unwrap();

        // read at t=200 → expired, dropped + treated as a miss.
        let got = repo.get("s1", "t1", "lyrics", None, None, None, 200).unwrap();
        assert!(got.is_none());

        let total: i64 = store
            .with_conn("misc", |c| c.query_row("SELECT COUNT(*) FROM track_artifact", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(total, 0, "expired row deleted, not just filtered");
    }

    #[test]
    fn negative_cache_row_is_returned_until_it_expires() {
        let store = LibraryStore::open_in_memory();
        seed_track(&store, "s1", "t1");
        let repo = ArtifactRepository::new(&store);
        let mut miss = artifact("lyrics", "plain", "lrclib", "lrclib");
        miss.content_text = None;
        miss.not_found = true;
        miss.expires_at = Some(1000);
        repo.put("s1", "t1", &miss, 100).unwrap();

        let got = repo
            .get("s1", "t1", "lyrics", None, None, None, 500)
            .unwrap()
            .expect("negative-cache row still live");
        assert!(got.not_found, "caller sees the cached miss instead of refetching");
    }

    #[test]
    fn lyrics_cached_only_for_live_found_row() {
        // Live lyrics row → cached; nothing / negative-cache / expired → not.
        let live = LibraryStore::open_in_memory();
        seed_track(&live, "s1", "t1");
        let repo = ArtifactRepository::new(&live);
        assert!(!repo.lyrics_cached("s1", "t1", 200).unwrap(), "no row → not cached");
        repo.put("s1", "t1", &artifact("lyrics", "plain", "lrclib", "lrclib"), 100)
            .unwrap();
        assert!(repo.lyrics_cached("s1", "t1", 200).unwrap(), "live row → cached");

        let neg = LibraryStore::open_in_memory();
        seed_track(&neg, "s1", "t1");
        let repo_neg = ArtifactRepository::new(&neg);
        let mut miss = artifact("lyrics", "plain", "lrclib", "lrclib");
        miss.content_text = None;
        miss.not_found = true;
        miss.expires_at = Some(1000);
        repo_neg.put("s1", "t1", &miss, 100).unwrap();
        assert!(
            !repo_neg.lyrics_cached("s1", "t1", 500).unwrap(),
            "negative-cache row is not 'cached'"
        );

        let exp = LibraryStore::open_in_memory();
        seed_track(&exp, "s1", "t1");
        let repo_exp = ArtifactRepository::new(&exp);
        let mut expired = artifact("lyrics", "plain", "lrclib", "lrclib");
        expired.expires_at = Some(150);
        repo_exp.put("s1", "t1", &expired, 100).unwrap();
        assert!(
            !repo_exp.lyrics_cached("s1", "t1", 200).unwrap(),
            "expired lyrics not cached"
        );
    }

    #[test]
    fn get_filters_by_source_id_only() {
        let store = LibraryStore::open_in_memory();
        seed_track(&store, "s1", "t1");
        let repo = ArtifactRepository::new(&store);
        repo.put("s1", "t1", &artifact("lyrics", "plain", "lrclib", "lrclib"), 1)
            .unwrap();
        repo.put("s1", "t1", &artifact("lyrics", "plain", "netease", "netease"), 2)
            .unwrap();

        // source_id without source_kind must bind correctly (running indices).
        let got = repo
            .get("s1", "t1", "lyrics", None, Some("netease"), None, 3)
            .unwrap()
            .expect("netease row");
        assert_eq!(got.source_id, "netease");
    }

    #[test]
    fn get_returns_most_recent_when_unfiltered() {
        let store = LibraryStore::open_in_memory();
        seed_track(&store, "s1", "t1");
        let repo = ArtifactRepository::new(&store);
        repo.put("s1", "t1", &artifact("lyrics", "plain", "lrclib", "lrclib"), 1)
            .unwrap();
        repo.put("s1", "t1", &artifact("lyrics", "plain", "netease", "netease"), 9)
            .unwrap();
        let got = repo
            .get("s1", "t1", "lyrics", None, None, None, 10)
            .unwrap()
            .unwrap();
        assert_eq!(got.source_id, "netease", "ORDER BY fetched_at DESC");
    }

    #[test]
    fn put_rejects_oversized_non_user_artifact() {
        let store = LibraryStore::open_in_memory();
        seed_track(&store, "s1", "t1");
        let repo = ArtifactRepository::new(&store);
        let mut big = artifact("lyrics", "plain", "lrclib", "lrclib");
        big.content_text = Some("x".repeat(MAX_ARTIFACT_BYTES + 1));
        let err = repo.put("s1", "t1", &big, 1).unwrap_err();
        assert!(err.contains("too large"), "got: {err}");
    }

    #[test]
    fn put_allows_oversized_user_import() {
        let store = LibraryStore::open_in_memory();
        seed_track(&store, "s1", "t1");
        let repo = ArtifactRepository::new(&store);
        let mut big = artifact("lyrics", "plain", "user", "user");
        big.content_text = Some("x".repeat(MAX_ARTIFACT_BYTES + 1));
        repo.put("s1", "t1", &big, 1).expect("user import bypasses the cap");
    }

    #[test]
    fn put_is_idempotent_on_same_source_key() {
        let store = LibraryStore::open_in_memory();
        seed_track(&store, "s1", "t1");
        let repo = ArtifactRepository::new(&store);
        repo.put("s1", "t1", &artifact("lyrics", "plain", "lrclib", "lrclib"), 1)
            .unwrap();
        let mut updated = artifact("lyrics", "plain", "lrclib", "lrclib");
        updated.content_text = Some("new words".into());
        repo.put("s1", "t1", &updated, 2).unwrap();
        let count: i64 = store
            .with_conn("misc", |c| c.query_row("SELECT COUNT(*) FROM track_artifact", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(count, 1, "same (kind, source, format) updates in place");
        let got = repo.get("s1", "t1", "lyrics", None, None, None, 3).unwrap().unwrap();
        assert_eq!(got.content_text.as_deref(), Some("new words"));
    }
}

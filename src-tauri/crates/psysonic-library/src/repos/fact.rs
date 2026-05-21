//! E4 — `FactRepository`: typed CRUD over `track_fact` with the §5.12
//! provenance / TTL rules.
//!
//! - **Lazy expiry (P34):** there's no background GC; a `get` first deletes
//!   the track's expired facts, then returns the survivors.
//! - **User override (R6-3.4):** a `user` BPM fact also writes `track.bpm` so
//!   the override wins and survives a server resync.
//!
//! The Tauri commands (`library_get_facts` / `library_put_fact`) delegate
//! here so there's one source of truth for the storage rules.

use rusqlite::params;

use crate::dto::{FactInputDto, TrackFactDto};
use crate::store::LibraryStore;

pub struct FactRepository<'a> {
    store: &'a LibraryStore,
}

impl<'a> FactRepository<'a> {
    pub fn new(store: &'a LibraryStore) -> Self {
        Self { store }
    }

    /// Lazily drop the track's expired facts (§5.12 read-path GC), then
    /// return the survivors — optionally filtered to `fact_kinds`. Ordered
    /// `fact_kind ASC, fetched_at DESC` so the highest-priority source per
    /// kind (caller resolves) comes first within its group.
    pub fn get(
        &self,
        server_id: &str,
        track_id: &str,
        fact_kinds: &[String],
        now: i64,
    ) -> Result<Vec<TrackFactDto>, String> {
        if self.store.bulk_ingest_active() {
            return self.get_readonly(server_id, track_id, fact_kinds);
        }
        self.store
            .with_conn_mut("fact.get_gc", |conn| {
                // Lazy TTL cleanup for this track.
                conn.execute(
                    "DELETE FROM track_fact \
                     WHERE server_id = ?1 AND track_id = ?2 \
                       AND expires_at IS NOT NULL AND expires_at < ?3",
                    params![server_id, track_id, now],
                )?;

                Self::query_facts(conn, server_id, track_id, fact_kinds)
            })
            .map_err(|e| e.to_string())
    }

    fn get_readonly(
        &self,
        server_id: &str,
        track_id: &str,
        fact_kinds: &[String],
    ) -> Result<Vec<TrackFactDto>, String> {
        self.store
            .with_read_conn(|conn| Self::query_facts(conn, server_id, track_id, fact_kinds))
            .map_err(|e| e.to_string())
    }

    fn query_facts(
        conn: &rusqlite::Connection,
        server_id: &str,
        track_id: &str,
        fact_kinds: &[String],
    ) -> rusqlite::Result<Vec<TrackFactDto>> {
        if fact_kinds.is_empty() {
            let mut stmt = conn.prepare(SELECT_FACTS)?;
            let rows: rusqlite::Result<Vec<TrackFactDto>> = stmt
                .query_map(params![server_id, track_id], row_to_fact_dto)?
                .collect();
            rows
        } else {
            let placeholders = (0..fact_kinds.len())
                .map(|i| format!("?{}", i + 3))
                .collect::<Vec<_>>()
                .join(", ");
            let sql = format!(
                "{SELECT_FACTS_BASE} AND fact_kind IN ({placeholders}) \
                 ORDER BY fact_kind ASC, fetched_at DESC"
            );
            let mut bound: Vec<rusqlite::types::Value> = vec![
                rusqlite::types::Value::Text(server_id.to_string()),
                rusqlite::types::Value::Text(track_id.to_string()),
            ];
            for k in fact_kinds {
                bound.push(rusqlite::types::Value::Text(k.clone()));
            }
            let mut stmt = conn.prepare(&sql)?;
            let rows: rusqlite::Result<Vec<TrackFactDto>> = stmt
                .query_map(rusqlite::params_from_iter(bound.iter()), row_to_fact_dto)?
                .collect();
            rows
        }
    }

    /// Upsert a fact. A `user` BPM fact also writes the hot `track.bpm`
    /// column so the manual override beats the server tag and survives a
    /// resync (§5.12 write path / R6-3.4).
    pub fn put(
        &self,
        server_id: &str,
        track_id: &str,
        fact: &FactInputDto,
        now: i64,
    ) -> Result<(), String> {
        self.store
            .with_conn("fact.put", |conn| {
                conn.execute(
                    UPSERT_FACT,
                    params![
                        server_id,
                        track_id,
                        fact.fact_kind,
                        fact.value_real,
                        fact.value_int,
                        fact.value_text,
                        fact.unit,
                        fact.source_kind,
                        fact.source_id,
                        fact.confidence,
                        fact.content_hash,
                        now,
                        fact.expires_at,
                    ],
                )?;
                if fact.fact_kind == "bpm" && fact.source_kind == "user" {
                    if let Some(bpm) = fact.value_int {
                        conn.execute(
                            "UPDATE track SET bpm = ?3 WHERE server_id = ?1 AND id = ?2",
                            params![server_id, track_id, bpm],
                        )?;
                    }
                }
                Ok(())
            })
            .map_err(|e| e.to_string())
    }
}

fn row_to_fact_dto(row: &rusqlite::Row<'_>) -> rusqlite::Result<TrackFactDto> {
    Ok(TrackFactDto {
        server_id: row.get(0)?,
        track_id: row.get(1)?,
        fact_kind: row.get(2)?,
        value_real: row.get(3)?,
        value_int: row.get(4)?,
        value_text: row.get(5)?,
        unit: row.get(6)?,
        source_kind: row.get(7)?,
        source_id: row.get(8)?,
        confidence: row.get(9)?,
        content_hash: row.get(10)?,
        fetched_at: row.get(11)?,
        expires_at: row.get(12)?,
    })
}

const SELECT_FACTS_BASE: &str = "SELECT server_id, track_id, fact_kind, value_real, value_int, \
  value_text, unit, source_kind, source_id, confidence, content_hash, fetched_at, expires_at \
  FROM track_fact WHERE server_id = ?1 AND track_id = ?2";

const SELECT_FACTS: &str = "SELECT server_id, track_id, fact_kind, value_real, value_int, \
  value_text, unit, source_kind, source_id, confidence, content_hash, fetched_at, expires_at \
  FROM track_fact WHERE server_id = ?1 AND track_id = ?2 \
  ORDER BY fact_kind ASC, fetched_at DESC";

const UPSERT_FACT: &str = "INSERT INTO track_fact \
  (server_id, track_id, fact_kind, value_real, value_int, value_text, unit, \
   source_kind, source_id, source_detail, confidence, content_hash, fetched_at, expires_at) \
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10, ?11, ?12, ?13) \
  ON CONFLICT(server_id, track_id, fact_kind, source_kind, source_id) DO UPDATE SET \
    value_real = excluded.value_real, \
    value_int = excluded.value_int, \
    value_text = excluded.value_text, \
    unit = excluded.unit, \
    confidence = excluded.confidence, \
    content_hash = excluded.content_hash, \
    fetched_at = excluded.fetched_at, \
    expires_at = excluded.expires_at";

#[cfg(test)]
mod tests {
    use super::*;

    fn fact(kind: &str, source_kind: &str, value_int: Option<i64>, expires_at: Option<i64>) -> FactInputDto {
        FactInputDto {
            fact_kind: kind.into(),
            value_real: None,
            value_int,
            value_text: None,
            unit: None,
            source_kind: source_kind.into(),
            source_id: "seed".into(),
            confidence: 1.0,
            content_hash: None,
            expires_at,
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
        let repo = FactRepository::new(&store);
        repo.put("s1", "t1", &fact("bpm", "analysis", Some(120), None), 100).unwrap();
        let facts = repo.get("s1", "t1", &[], 200).unwrap();
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].fact_kind, "bpm");
        assert_eq!(facts[0].value_int, Some(120));
    }

    #[test]
    fn get_lazily_deletes_expired_facts() {
        let store = LibraryStore::open_in_memory();
        seed_track(&store, "s1", "t1");
        let repo = FactRepository::new(&store);
        // expires at t=150
        repo.put("s1", "t1", &fact("energy", "external_api", Some(5), Some(150)), 100).unwrap();
        repo.put("s1", "t1", &fact("bpm", "analysis", Some(120), None), 100).unwrap();

        // read at t=200 → energy expired, dropped + excluded; bpm survives.
        let facts = repo.get("s1", "t1", &[], 200).unwrap();
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].fact_kind, "bpm");

        // and it was actually deleted from the table (not just filtered).
        let total: i64 = store
            .with_conn("misc", |c| c.query_row("SELECT COUNT(*) FROM track_fact", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(total, 1);
    }

    #[test]
    fn get_filters_by_kind() {
        let store = LibraryStore::open_in_memory();
        seed_track(&store, "s1", "t1");
        let repo = FactRepository::new(&store);
        repo.put("s1", "t1", &fact("bpm", "analysis", Some(120), None), 1).unwrap();
        repo.put("s1", "t1", &fact("energy", "analysis", Some(7), None), 1).unwrap();
        let facts = repo.get("s1", "t1", &["bpm".into()], 2).unwrap();
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].fact_kind, "bpm");
    }

    #[test]
    fn user_bpm_fact_also_writes_hot_track_column() {
        let store = LibraryStore::open_in_memory();
        seed_track(&store, "s1", "t1");
        let repo = FactRepository::new(&store);
        repo.put("s1", "t1", &fact("bpm", "user", Some(128), None), 1).unwrap();
        let bpm: Option<i64> = store
            .with_conn("misc", |c| {
                c.query_row("SELECT bpm FROM track WHERE server_id='s1' AND id='t1'", [], |r| r.get(0))
            })
            .unwrap();
        assert_eq!(bpm, Some(128), "user bpm override must write track.bpm");
    }

    #[test]
    fn analysis_bpm_fact_does_not_touch_hot_track_column() {
        let store = LibraryStore::open_in_memory();
        seed_track(&store, "s1", "t1");
        let repo = FactRepository::new(&store);
        repo.put("s1", "t1", &fact("bpm", "analysis", Some(99), None), 1).unwrap();
        let bpm: Option<i64> = store
            .with_conn("misc", |c| {
                c.query_row("SELECT bpm FROM track WHERE server_id='s1' AND id='t1'", [], |r| r.get(0))
            })
            .unwrap();
        assert_eq!(bpm, None, "only a user override writes the hot column (§5.12)");
    }

    #[test]
    fn put_is_idempotent_on_same_source_key() {
        let store = LibraryStore::open_in_memory();
        seed_track(&store, "s1", "t1");
        let repo = FactRepository::new(&store);
        repo.put("s1", "t1", &fact("bpm", "analysis", Some(120), None), 1).unwrap();
        repo.put("s1", "t1", &fact("bpm", "analysis", Some(124), None), 2).unwrap();
        let facts = repo.get("s1", "t1", &[], 3).unwrap();
        assert_eq!(facts.len(), 1, "same (kind, source) updates in place");
        assert_eq!(facts[0].value_int, Some(124));
    }
}

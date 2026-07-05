//! ATTACH wiring for the rebuildable `library-cluster.db` sidecar.

use std::path::{Path, PathBuf};

use rusqlite::Connection;

/// Fixed SQLite schema name for the attached identity database.
pub const CLUSTER_SCHEMA: &str = "cluster";

pub const CLUSTER_DB_FILENAME: &str = "library-cluster.db";

const CLUSTER_SCHEMA_SQL: &str = "
CREATE TABLE IF NOT EXISTS cluster.track_cluster_key (
  server_id    TEXT NOT NULL,
  library_id   TEXT NOT NULL,
  track_id     TEXT NOT NULL,
  cluster_key  TEXT,
  album_key    TEXT,
  artist_key   TEXT,
  duration_sec INTEGER,
  PRIMARY KEY (server_id, track_id)
);
CREATE INDEX IF NOT EXISTS cluster.idx_ck_scope_album
  ON track_cluster_key(server_id, library_id, album_key);
CREATE INDEX IF NOT EXISTS cluster.idx_ck_scope_artist
  ON track_cluster_key(server_id, library_id, artist_key);
CREATE INDEX IF NOT EXISTS cluster.idx_ck_scope_track
  ON track_cluster_key(server_id, library_id, cluster_key);
CREATE TABLE IF NOT EXISTS cluster.cluster_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
";

pub fn cluster_db_path_for_library(library_db_path: &Path) -> PathBuf {
    library_db_path
        .parent()
        .map(|dir| dir.join(CLUSTER_DB_FILENAME))
        .unwrap_or_else(|| PathBuf::from(CLUSTER_DB_FILENAME))
}

fn escape_sqlite_literal(path: &str) -> String {
    path.replace('\'', "''")
}

fn attach_file_write(conn: &Connection, cluster_path: &Path) -> rusqlite::Result<()> {
    if let Some(parent) = cluster_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            rusqlite::Error::ToSqlConversionFailure(Box::new(e))
        })?;
    }
    let literal = escape_sqlite_literal(&cluster_path.display().to_string());
    conn.execute_batch(&format!(
        "ATTACH DATABASE '{literal}' AS {CLUSTER_SCHEMA}"
    ))?;
    conn.execute_batch(CLUSTER_SCHEMA_SQL)?;
    Ok(())
}

/// Read-only attach — only after the write connection has created the file + schema.
fn attach_file_read(conn: &Connection, cluster_path: &Path) -> rusqlite::Result<()> {
    let literal = escape_sqlite_literal(&cluster_path.display().to_string());
    conn.execute_batch(&format!(
        "ATTACH DATABASE 'file:{literal}?mode=ro' AS {CLUSTER_SCHEMA}"
    ))?;
    Ok(())
}

/// In-memory cluster DB uses `cache=shared` so the read/write library pair see one identity store.
fn attach_memory(conn: &Connection, cluster_uri: &str) -> rusqlite::Result<()> {
    let literal = escape_sqlite_literal(cluster_uri);
    conn.execute_batch(&format!(
        "ATTACH DATABASE '{literal}' AS {CLUSTER_SCHEMA}"
    ))?;
    Ok(())
}

pub fn attach_cluster_write_file(
    conn: &Connection,
    library_db_path: &Path,
) -> rusqlite::Result<()> {
    attach_file_write(conn, &cluster_db_path_for_library(library_db_path))
}

pub fn attach_cluster_read_file(
    conn: &Connection,
    library_db_path: &Path,
) -> rusqlite::Result<()> {
    attach_file_read(conn, &cluster_db_path_for_library(library_db_path))
}

pub fn attach_cluster_write_memory(conn: &Connection, cluster_uri: &str) -> rusqlite::Result<()> {
    attach_memory(conn, cluster_uri)?;
    conn.execute_batch(CLUSTER_SCHEMA_SQL)?;
    Ok(())
}

/// Shared-cache in-memory identity DB — attach after write side created schema.
pub fn attach_cluster_read_memory(conn: &Connection, cluster_uri: &str) -> rusqlite::Result<()> {
    attach_memory(conn, cluster_uri)
}

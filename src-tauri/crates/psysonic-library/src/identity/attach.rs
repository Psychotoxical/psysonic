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

/// Build a well-formed SQLite `file:` URI for a filesystem path so URI-mode
/// ATTACH works on every platform. A raw Windows path (`D:\dir\library-cluster.db`)
/// is not a valid URI — backslashes and the bare drive letter must become
/// `file:///D:/dir/library-cluster.db`. Query-significant characters are
/// percent-encoded so a path containing `?`/`#`/spaces cannot corrupt the URI.
fn file_uri(cluster_path: &Path, query: &str) -> String {
    let normalized = cluster_path.display().to_string().replace('\\', "/");
    let encoded: String = normalized
        .chars()
        .map(|c| match c {
            '%' => "%25".to_string(),
            '?' => "%3F".to_string(),
            '#' => "%23".to_string(),
            ' ' => "%20".to_string(),
            other => other.to_string(),
        })
        .collect();
    // Unix paths already start with `/` (→ `file://` + `/abs`); Windows paths
    // start with a drive letter and need the extra slash (`file:///C:/…`).
    let prefix = if encoded.starts_with('/') { "file://" } else { "file:///" };
    if query.is_empty() {
        format!("{prefix}{encoded}")
    } else {
        format!("{prefix}{encoded}?{query}")
    }
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
    // Bind the URI as a parameter (no literal quoting) and build it as a proper
    // `file:` URI so read-only attach also works on Windows.
    let uri = file_uri(cluster_path, "mode=ro");
    conn.execute(
        &format!("ATTACH DATABASE ?1 AS {CLUSTER_SCHEMA}"),
        rusqlite::params![uri],
    )?;
    Ok(())
}

/// Delete the cluster sidecar and its WAL/SHM siblings. Safe to call when they
/// do not exist. The identity DB is fully rebuildable, so removing it only costs
/// the next lazy rebuild.
pub fn remove_cluster_files(cluster_path: &Path) {
    let _ = std::fs::remove_file(cluster_path);
    let _ = std::fs::remove_file(cluster_path.with_extension("db-wal"));
    let _ = std::fs::remove_file(cluster_path.with_extension("db-shm"));
}

/// Remove the rebuildable cluster sidecar for a library DB path (swap / restore /
/// import must invalidate it — see store/backup). No-op if absent.
pub fn remove_cluster_files_for_library(library_db_path: &Path) {
    remove_cluster_files(&cluster_db_path_for_library(library_db_path));
}

/// Attach the identity sidecar on both handles with one-shot recovery: a corrupt
/// or partially-attached `library-cluster.db` is detached, deleted and recreated
/// (the file is fully rebuildable), so it can never block the library from
/// opening. Returns the second attach error only if recreation also fails.
pub fn attach_cluster_pair_file(
    write_conn: &Connection,
    read_conn: &Connection,
    library_db_path: &Path,
) -> rusqlite::Result<()> {
    let cluster_path = cluster_db_path_for_library(library_db_path);
    match attach_pair_once(write_conn, read_conn, &cluster_path) {
        Ok(()) => Ok(()),
        Err(first) => {
            crate::app_eprintln!(
                "[library-cluster] attach failed ({first}); recreating rebuildable sidecar"
            );
            let _ = write_conn.execute_batch(&format!("DETACH DATABASE {CLUSTER_SCHEMA}"));
            let _ = read_conn.execute_batch(&format!("DETACH DATABASE {CLUSTER_SCHEMA}"));
            remove_cluster_files(&cluster_path);
            attach_pair_once(write_conn, read_conn, &cluster_path)
        }
    }
}

fn attach_pair_once(
    write_conn: &Connection,
    read_conn: &Connection,
    cluster_path: &Path,
) -> rusqlite::Result<()> {
    attach_file_write(write_conn, cluster_path)?;
    attach_file_read(read_conn, cluster_path)?;
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

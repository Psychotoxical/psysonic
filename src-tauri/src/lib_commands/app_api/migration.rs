use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use rusqlite::{params_from_iter, Connection, OpenFlags};
use tauri::{AppHandle, Emitter, Manager};

const LIBRARY_TABLES: &[&str] = &[
    "track_extension",
    "track_fact",
    "track_artifact",
    "track_canonical_link",
    "track_id_history",
    "play_session",
    "track_offline",
    "track",
    "album",
    "artist",
    "sync_state",
];

const ANALYSIS_TABLES: &[&str] = &["analysis_track", "waveform_cache", "loudness_cache"];

fn migration_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ServerIndexMapping {
    pub legacy_id: String,
    pub index_key: String,
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MigrationScopeInspect {
    pub total_legacy_rows: u64,
    pub skipped_unknown_server_rows: u64,
    pub tables: HashMap<String, u64>,
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MigrationInspectReport {
    pub needs_migration: bool,
    pub has_skipped_unknown_server_rows: bool,
    pub can_run: bool,
    pub warnings: Vec<String>,
    pub unmapped_empty_bucket: bool,
    pub library: MigrationScopeInspect,
    pub analysis: MigrationScopeInspect,
    pub mappings: Vec<ServerIndexMapping>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationProgressEvent {
    pub stage: String,
    pub table: String,
    pub done: u64,
    pub total: u64,
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MigrationRunScope {
    pub imported_rows: u64,
    pub source_rows: u64,
    pub skipped_unknown_server_rows: u64,
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MigrationRunResult {
    pub library: MigrationRunScope,
    pub analysis: MigrationRunScope,
    pub has_skipped_unknown_server_rows: bool,
    pub switched: bool,
    pub backup_removed: bool,
}

#[tauri::command]
#[specta::specta]
pub fn migration_inspect(
    app: AppHandle,
    mappings: Vec<ServerIndexMapping>,
) -> Result<MigrationInspectReport, String> {
    inspect_internal(&app, mappings)
}

#[tauri::command]
#[specta::specta]
pub fn migration_run(
    app: AppHandle,
    mappings: Vec<ServerIndexMapping>,
) -> Result<MigrationRunResult, String> {
    let _guard = migration_lock()
        .lock()
        .map_err(|_| "migration lock poisoned".to_string())?;
    run_internal(&app, mappings)
}

fn inspect_internal(
    app: &AppHandle,
    mappings: Vec<ServerIndexMapping>,
) -> Result<MigrationInspectReport, String> {
    let normalized = normalize_mappings(mappings);
    let legacy_ids: Vec<String> = normalized.iter().map(|m| m.legacy_id.clone()).collect();
    let index_keys: Vec<String> = normalized.iter().map(|m| m.index_key.clone()).collect();
    let paths = migration_paths(app)?;

    let (library_tables, library_total, library_skipped_unknown_rows) = inspect_tables(
        &paths.library_active,
        LIBRARY_TABLES,
        &legacy_ids,
        &index_keys,
    )?;
    let (analysis_tables, mut analysis_total, analysis_skipped_unknown_rows) = inspect_tables(
        &paths.analysis_active,
        ANALYSIS_TABLES,
        &legacy_ids,
        &index_keys,
    )?;
    let mut analysis_tables = analysis_tables;
    let mut warnings = Vec::new();
    let mut unmapped_empty_bucket = false;
    let mut has_empty_bucket_rows = false;
    if paths.analysis_active.exists() {
        let conn = open_readonly(&paths.analysis_active)?;
        for table in ANALYSIS_TABLES {
            let empty_count = count_rows_eq(&conn, table, "")?;
            if empty_count > 0 {
                has_empty_bucket_rows = true;
                if normalized.len() == 1 {
                    let entry = analysis_tables.entry((*table).to_string()).or_insert(0);
                    *entry = entry.saturating_add(empty_count as u64);
                    analysis_total = analysis_total.saturating_add(empty_count as u64);
                }
            }
        }
        if normalized.len() > 1 && has_empty_bucket_rows {
            unmapped_empty_bucket = true;
            warnings.push("analysis empty server bucket kept for multi-server install".to_string());
        }
    }

    let needs_migration = library_total > 0 || analysis_total > 0;
    let can_run = !normalized.is_empty();
    if needs_migration && !can_run {
        warnings.push("no server mappings available".to_string());
    }
    let has_skipped_unknown_server_rows =
        library_skipped_unknown_rows > 0 || analysis_skipped_unknown_rows > 0;
    if has_skipped_unknown_server_rows {
        warnings.push("rows for removed servers were skipped".to_string());
    }

    Ok(MigrationInspectReport {
        needs_migration,
        has_skipped_unknown_server_rows,
        can_run,
        warnings,
        unmapped_empty_bucket,
        library: MigrationScopeInspect {
            total_legacy_rows: library_total,
            skipped_unknown_server_rows: library_skipped_unknown_rows,
            tables: library_tables,
        },
        analysis: MigrationScopeInspect {
            total_legacy_rows: analysis_total,
            skipped_unknown_server_rows: analysis_skipped_unknown_rows,
            tables: analysis_tables,
        },
        mappings: normalized,
    })
}

fn run_internal(app: &AppHandle, mappings: Vec<ServerIndexMapping>) -> Result<MigrationRunResult, String> {
    let inspect = inspect_internal(app, mappings)?;
    if !inspect.needs_migration {
        return Ok(MigrationRunResult {
            library: MigrationRunScope {
                imported_rows: 0,
                source_rows: 0,
                skipped_unknown_server_rows: inspect.library.skipped_unknown_server_rows,
            },
            analysis: MigrationRunScope {
                imported_rows: 0,
                source_rows: 0,
                skipped_unknown_server_rows: inspect.analysis.skipped_unknown_server_rows,
            },
            has_skipped_unknown_server_rows: inspect.has_skipped_unknown_server_rows,
            switched: false,
            backup_removed: false,
        });
    }
    if !inspect.can_run {
        return Err("migration requires at least one server mapping".to_string());
    }

    let paths = migration_paths(app)?;
    let mappings = inspect.mappings;
    let single_mapping = if mappings.len() == 1 {
        Some(mappings[0].index_key.clone())
    } else {
        None
    };

    emit_progress(
        app,
        "library",
        "prepare",
        0,
        LIBRARY_TABLES.len() as u64,
    )?;
    let (library_source_rows, library_imported_rows, library_skipped_unknown_rows) =
        run_library_import(app, &paths, &mappings)?;
    let (analysis_source_rows, analysis_imported_rows, analysis_skipped_unknown_rows) =
        run_analysis_import(app, &paths, &mappings, single_mapping.as_deref())?;

    let mut backup_removed = false;
    let mut library_backup: Option<PathBuf> = None;
    let mut analysis_backup: Option<PathBuf> = None;

    if paths.library_v2.exists() {
        if let Some(runtime) = app.try_state::<psysonic_library::LibraryRuntime>() {
            library_backup = runtime
                .store
                .swap_database_file(&paths.library_active, &paths.library_v2)?;
        } else {
            library_backup = Some(switch_file(&paths.library_active, &paths.library_v2)?);
        }
    }
    if paths.analysis_v2.exists() {
        if let Some(cache) = app.try_state::<psysonic_analysis::analysis_cache::AnalysisCache>() {
            analysis_backup = cache.swap_database_file(&paths.analysis_active, &paths.analysis_v2)?;
        } else {
            analysis_backup = Some(switch_file(&paths.analysis_active, &paths.analysis_v2)?);
        }
    }
    let switched = library_backup.is_some() || analysis_backup.is_some();

    if let Err(err) = health_check(&paths.library_active, &paths.analysis_active) {
        if let Some(ref backup) = library_backup {
            if let Some(runtime) = app.try_state::<psysonic_library::LibraryRuntime>() {
                let _ = runtime
                    .store
                    .restore_database_backup(backup, &paths.library_active);
            } else {
                let _ = restore_backup(backup, &paths.library_active);
            }
        }
        if let Some(ref backup) = analysis_backup {
            if let Some(cache) = app.try_state::<psysonic_analysis::analysis_cache::AnalysisCache>() {
                let _ = cache.restore_database_backup(backup, &paths.analysis_active);
            } else {
                let _ = restore_backup(backup, &paths.analysis_active);
            }
        }
        return Err(err);
    }

    if let Some(backup) = library_backup {
        remove_db_with_sidecars(&backup)?;
        backup_removed = true;
    }
    if let Some(backup) = analysis_backup {
        remove_db_with_sidecars(&backup)?;
        backup_removed = true;
    }

    Ok(MigrationRunResult {
        library: MigrationRunScope {
            imported_rows: library_imported_rows,
            source_rows: library_source_rows,
            skipped_unknown_server_rows: library_skipped_unknown_rows,
        },
        analysis: MigrationRunScope {
            imported_rows: analysis_imported_rows,
            source_rows: analysis_source_rows,
            skipped_unknown_server_rows: analysis_skipped_unknown_rows,
        },
        has_skipped_unknown_server_rows: library_skipped_unknown_rows > 0 || analysis_skipped_unknown_rows > 0,
        switched,
        backup_removed,
    })
}

fn run_library_import(
    app: &AppHandle,
    paths: &MigrationPaths,
    mappings: &[ServerIndexMapping],
) -> Result<(u64, u64, u64), String> {
    if !paths.library_active.exists() {
        return Ok((0, 0, 0));
    }
    remove_db_with_sidecars(&paths.library_v2).ok();
    vacuum_copy(&paths.library_active, &paths.library_v2)?;

    let source = open_readonly(&paths.library_active)?;
    let dest = Connection::open(&paths.library_v2).map_err(|e| e.to_string())?;
    let legacy_ids: Vec<String> = mappings.iter().map(|m| m.legacy_id.clone()).collect();
    let index_keys: Vec<String> = mappings.iter().map(|m| m.index_key.clone()).collect();
    let total = LIBRARY_TABLES.len() as u64;
    let mut done = 0_u64;
    with_foreign_keys_disabled(&dest, || {
        for table in LIBRARY_TABLES {
            purge_unknown_rows(&dest, table, &legacy_ids, &index_keys)?;
            for mapping in mappings {
                dest.execute(
                    &format!("UPDATE OR REPLACE {table} SET server_id = ?2 WHERE server_id = ?1"),
                    [&mapping.legacy_id, &mapping.index_key],
                )
                .map_err(|e| e.to_string())?;
            }
            done = done.saturating_add(1);
            emit_progress(app, "library", table, done, total)?;
        }
        Ok(())
    })?;
    let source_rows = sum_table_rows(&source, LIBRARY_TABLES)?;
    let imported_rows = sum_table_rows(&dest, LIBRARY_TABLES)?;
    let skipped_unknown_server_rows = sum_unknown_rows(&source, LIBRARY_TABLES, &legacy_ids, &index_keys)?;
    Ok((source_rows, imported_rows, skipped_unknown_server_rows))
}

fn run_analysis_import(
    app: &AppHandle,
    paths: &MigrationPaths,
    mappings: &[ServerIndexMapping],
    single_mapping: Option<&str>,
) -> Result<(u64, u64, u64), String> {
    if !paths.analysis_active.exists() {
        return Ok((0, 0, 0));
    }
    remove_db_with_sidecars(&paths.analysis_v2).ok();
    vacuum_copy(&paths.analysis_active, &paths.analysis_v2)?;

    let source = open_readonly(&paths.analysis_active)?;
    let dest = Connection::open(&paths.analysis_v2).map_err(|e| e.to_string())?;
    let legacy_ids: Vec<String> = mappings.iter().map(|m| m.legacy_id.clone()).collect();
    let index_keys: Vec<String> = mappings.iter().map(|m| m.index_key.clone()).collect();
    let total = ANALYSIS_TABLES.len() as u64;
    let mut done = 0_u64;
    with_foreign_keys_disabled(&dest, || {
        for table in ANALYSIS_TABLES {
            purge_unknown_rows(&dest, table, &legacy_ids, &index_keys)?;
            for mapping in mappings {
                dest.execute(
                    &format!("UPDATE OR REPLACE {table} SET server_id = ?2 WHERE server_id = ?1"),
                    [&mapping.legacy_id, &mapping.index_key],
                )
                .map_err(|e| e.to_string())?;
            }
            if let Some(index_key) = single_mapping {
                dest.execute(
                    &format!("UPDATE OR REPLACE {table} SET server_id = ?2 WHERE server_id = ?1"),
                    ["", index_key],
                )
                .map_err(|e| e.to_string())?;
            }
            done = done.saturating_add(1);
            emit_progress(app, "analysis", table, done, total)?;
        }
        Ok(())
    })?;
    let source_rows = sum_table_rows(&source, ANALYSIS_TABLES)?;
    let imported_rows = sum_table_rows(&dest, ANALYSIS_TABLES)?;
    let skipped_unknown_server_rows = sum_unknown_rows(&source, ANALYSIS_TABLES, &legacy_ids, &index_keys)?;
    Ok((source_rows, imported_rows, skipped_unknown_server_rows))
}

fn normalize_mappings(mappings: Vec<ServerIndexMapping>) -> Vec<ServerIndexMapping> {
    let mut out: Vec<ServerIndexMapping> = Vec::new();
    for mapping in mappings {
        let legacy_id = mapping.legacy_id.trim().to_string();
        let index_key = mapping.index_key.trim().to_string();
        if legacy_id.is_empty() || index_key.is_empty() {
            continue;
        }
        if let Some(existing) = out.iter_mut().find(|v| v.legacy_id == legacy_id) {
            existing.index_key = index_key;
        } else {
            out.push(ServerIndexMapping {
                legacy_id,
                index_key,
            });
        }
    }
    out
}

fn inspect_tables(
    db_path: &Path,
    tables: &[&str],
    legacy_ids: &[String],
    known_index_keys: &[String],
) -> Result<(HashMap<String, u64>, u64, u64), String> {
    let mut counts = HashMap::new();
    if !db_path.exists() {
        return Ok((counts, 0, 0));
    }
    let conn = open_readonly(db_path)?;
    let mut total = 0_u64;
    let mut skipped_unknown_server_rows = 0_u64;
    for table in tables {
        let count = count_rows_in(&conn, table, legacy_ids)? as u64;
        if count > 0 {
            counts.insert((*table).to_string(), count);
            total = total.saturating_add(count);
        }
        let unknown =
            count_unknown_rows(&conn, table, legacy_ids, known_index_keys)? as u64;
        skipped_unknown_server_rows = skipped_unknown_server_rows.saturating_add(unknown);
    }
    Ok((counts, total, skipped_unknown_server_rows))
}

fn count_rows_in(conn: &Connection, table: &str, values: &[String]) -> Result<i64, String> {
    if values.is_empty() {
        return Ok(0);
    }
    let placeholders = std::iter::repeat_n("?", values.len()).collect::<Vec<_>>().join(",");
    let sql = format!("SELECT COUNT(*) FROM {table} WHERE server_id IN ({placeholders})");
    conn.query_row(&sql, params_from_iter(values.iter()), |row| row.get(0))
        .map_err(|e| e.to_string())
}

fn count_rows_eq(conn: &Connection, table: &str, value: &str) -> Result<i64, String> {
    conn.query_row(
        &format!("SELECT COUNT(*) FROM {table} WHERE server_id = ?1"),
        [&value],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

fn count_unknown_rows(
    conn: &Connection,
    table: &str,
    known_legacy_ids: &[String],
    known_index_keys: &[String],
) -> Result<i64, String> {
    let known = known_server_ids(known_legacy_ids, known_index_keys);
    if known.is_empty() {
        return conn
            .query_row(
                &format!("SELECT COUNT(*) FROM {table} WHERE server_id <> ''"),
                [],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string());
    }
    let placeholders = std::iter::repeat_n("?", known.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql =
        format!("SELECT COUNT(*) FROM {table} WHERE server_id <> '' AND server_id NOT IN ({placeholders})");
    conn.query_row(&sql, params_from_iter(known.iter()), |row| row.get(0))
        .map_err(|e| e.to_string())
}

fn purge_unknown_rows(
    conn: &Connection,
    table: &str,
    known_legacy_ids: &[String],
    known_index_keys: &[String],
) -> Result<(), String> {
    let known = known_server_ids(known_legacy_ids, known_index_keys);
    if known.is_empty() {
        conn.execute(&format!("DELETE FROM {table} WHERE server_id <> ''"), [])
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    let placeholders = std::iter::repeat_n("?", known.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql =
        format!("DELETE FROM {table} WHERE server_id <> '' AND server_id NOT IN ({placeholders})");
    conn.execute(&sql, params_from_iter(known.iter()))
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn known_server_ids(known_legacy_ids: &[String], known_index_keys: &[String]) -> Vec<String> {
    let mut known: Vec<String> = Vec::new();
    known.extend(known_legacy_ids.iter().cloned());
    known.extend(known_index_keys.iter().cloned());
    known.sort();
    known.dedup();
    known
}

fn sum_table_rows(conn: &Connection, tables: &[&str]) -> Result<u64, String> {
    let mut total = 0_u64;
    for table in tables {
        let rows: i64 = conn
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        total = total.saturating_add(rows.max(0) as u64);
    }
    Ok(total)
}

fn sum_unknown_rows(
    conn: &Connection,
    tables: &[&str],
    known_legacy_ids: &[String],
    known_index_keys: &[String],
) -> Result<u64, String> {
    let mut total = 0_u64;
    for table in tables {
        let rows = count_unknown_rows(conn, table, known_legacy_ids, known_index_keys)?;
        total = total.saturating_add(rows.max(0) as u64);
    }
    Ok(total)
}

fn with_foreign_keys_disabled<T>(
    conn: &Connection,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    conn.execute_batch("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;")
        .map_err(|e| e.to_string())?;
    let result = operation();
    match result {
        Ok(value) => {
            if let Err(err) = conn
                .execute_batch("COMMIT; PRAGMA foreign_keys = ON;")
                .map_err(|e| e.to_string())
            {
                let _ = conn.execute_batch("ROLLBACK; PRAGMA foreign_keys = ON;");
                return Err(err);
            }
            ensure_foreign_keys_clean(conn)?;
            Ok(value)
        }
        Err(err) => {
            let _ = conn.execute_batch("ROLLBACK; PRAGMA foreign_keys = ON;");
            Err(err)
        }
    }
}

fn ensure_foreign_keys_clean(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare("PRAGMA foreign_key_check")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
    if let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let table: String = row.get(0).map_err(|e| e.to_string())?;
        let rowid: i64 = row.get(1).map_err(|e| e.to_string())?;
        let parent: String = row.get(2).map_err(|e| e.to_string())?;
        let fkid: i64 = row.get(3).map_err(|e| e.to_string())?;
        return Err(format!(
            "foreign key check failed table={table} rowid={rowid} parent={parent} fkid={fkid}"
        ));
    }
    Ok(())
}

fn emit_progress(app: &AppHandle, stage: &str, table: &str, done: u64, total: u64) -> Result<(), String> {
    app.emit(
        "migration:progress",
        MigrationProgressEvent {
            stage: stage.to_string(),
            table: table.to_string(),
            done,
            total,
        },
    )
    .map_err(|e| e.to_string())
}

fn open_readonly(path: &Path) -> Result<Connection, String> {
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| e.to_string())
}

fn vacuum_copy(source: &Path, destination: &Path) -> Result<(), String> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let conn = Connection::open(source).map_err(|e| e.to_string())?;
    let sql = format!(
        "VACUUM INTO '{}';",
        destination.to_string_lossy().replace('\'', "''")
    );
    conn.execute_batch(&sql).map_err(|e| e.to_string())
}

fn switch_file(active: &Path, destination: &Path) -> Result<PathBuf, String> {
    let backup = active.with_file_name(format!(
        "{}.backup-pre-indexkey",
        active
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("db.sqlite")
    ));
    remove_db_with_sidecars(&backup).ok();
    if active.exists() {
        fs::rename(active, &backup).map_err(|e| e.to_string())?;
    }
    fs::rename(destination, active).map_err(|e| e.to_string())?;
    Ok(backup)
}

fn restore_backup(backup: &Path, active: &Path) -> Result<(), String> {
    if active.exists() {
        fs::remove_file(active).map_err(|e| e.to_string())?;
    }
    if backup.exists() {
        fs::rename(backup, active).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn health_check(library_active: &Path, analysis_active: &Path) -> Result<(), String> {
    if library_active.exists() {
        let conn = open_readonly(library_active)?;
        conn.query_row("SELECT COUNT(*) FROM track", [], |_row| Ok(()))
            .map_err(|e| e.to_string())?;
    }
    if analysis_active.exists() {
        let conn = open_readonly(analysis_active)?;
        conn.query_row("SELECT COUNT(*) FROM analysis_track", [], |_row| Ok(()))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn remove_db_with_sidecars(path: &Path) -> Result<(), String> {
    remove_if_exists(path)?;
    let wal = PathBuf::from(format!("{}-wal", path.to_string_lossy()));
    let shm = PathBuf::from(format!("{}-shm", path.to_string_lossy()));
    remove_if_exists(&wal)?;
    remove_if_exists(&shm)?;
    Ok(())
}

fn remove_if_exists(path: &Path) -> Result<(), String> {
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

struct MigrationPaths {
    library_active: PathBuf,
    library_v2: PathBuf,
    analysis_active: PathBuf,
    analysis_v2: PathBuf,
}

fn migration_paths(app: &AppHandle) -> Result<MigrationPaths, String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let library_dir = base.join("databases").join("library");
    let analysis_dir = base.join("databases").join("analysis");
    fs::create_dir_all(&library_dir).map_err(|e| e.to_string())?;
    fs::create_dir_all(&analysis_dir).map_err(|e| e.to_string())?;
    Ok(MigrationPaths {
        library_active: library_dir.join("library.sqlite"),
        library_v2: library_dir.join("library-v2.sqlite"),
        analysis_active: analysis_dir.join("audio-analysis.sqlite"),
        analysis_v2: analysis_dir.join("analysis-v2.sqlite"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inspect_reports_skipped_unknown_rows() {
        let conn = Connection::open_in_memory().expect("in-memory sqlite");
        conn.execute_batch("CREATE TABLE track (server_id TEXT NOT NULL);")
            .expect("create table");
        conn.execute("INSERT INTO track(server_id) VALUES (?1)", ["legacy-a"])
            .expect("insert known legacy");
        conn.execute("INSERT INTO track(server_id) VALUES (?1)", ["removed-x"])
            .expect("insert unknown");

        let known_legacy_ids = vec!["legacy-a".to_string()];
        let known_index_keys = vec!["idx-a".to_string()];
        let unknown = count_unknown_rows(&conn, "track", &known_legacy_ids, &known_index_keys)
            .expect("unknown count");
        assert_eq!(unknown, 1);
    }

    #[test]
    fn run_reports_skipped_unknown_rows_without_failure() {
        let conn = Connection::open_in_memory().expect("in-memory sqlite");
        conn.execute_batch("CREATE TABLE analysis_track (server_id TEXT NOT NULL);")
            .expect("create table");
        conn.execute("INSERT INTO analysis_track(server_id) VALUES (?1)", ["legacy-a"])
            .expect("insert known legacy");
        conn.execute("INSERT INTO analysis_track(server_id) VALUES (?1)", ["removed-x"])
            .expect("insert unknown");

        let known_legacy_ids = vec!["legacy-a".to_string()];
        let known_index_keys = vec!["idx-a".to_string()];
        let skipped = sum_unknown_rows(&conn, &["analysis_track"], &known_legacy_ids, &known_index_keys)
            .expect("sum unknown rows");
        assert_eq!(skipped, 1);
    }

    #[test]
    fn needs_migration_false_when_only_unknown_rows_present() {
        let conn = Connection::open_in_memory().expect("in-memory sqlite");
        conn.execute_batch("CREATE TABLE track (server_id TEXT NOT NULL);")
            .expect("create table");
        conn.execute("INSERT INTO track(server_id) VALUES (?1)", ["removed-x"])
            .expect("insert unknown");

        let known_legacy_ids = vec!["legacy-a".to_string()];
        let known_index_keys = vec!["idx-a".to_string()];
        let legacy = count_rows_in(&conn, "track", &known_legacy_ids).expect("legacy count");
        let unknown = count_unknown_rows(&conn, "track", &known_legacy_ids, &known_index_keys)
            .expect("unknown count");
        assert_eq!(legacy, 0);
        assert_eq!(unknown, 1);
    }

    #[test]
    fn purge_unknown_rows_removes_only_removed_servers() {
        let conn = Connection::open_in_memory().expect("in-memory sqlite");
        conn.execute_batch("CREATE TABLE track (server_id TEXT NOT NULL);")
            .expect("create table");
        conn.execute("INSERT INTO track(server_id) VALUES (?1)", ["legacy-a"])
            .expect("insert legacy");
        conn.execute("INSERT INTO track(server_id) VALUES (?1)", ["idx-a"])
            .expect("insert index key");
        conn.execute("INSERT INTO track(server_id) VALUES (?1)", [""])
            .expect("insert empty bucket");
        conn.execute("INSERT INTO track(server_id) VALUES (?1)", ["removed-x"])
            .expect("insert removed server");

        let known_legacy_ids = vec!["legacy-a".to_string()];
        let known_index_keys = vec!["idx-a".to_string()];
        purge_unknown_rows(&conn, "track", &known_legacy_ids, &known_index_keys)
            .expect("purge unknown rows");

        let remaining: i64 = conn
            .query_row("SELECT COUNT(*) FROM track", [], |row| row.get(0))
            .expect("count remaining");
        let removed_left: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM track WHERE server_id = 'removed-x'",
                [],
                |row| row.get(0),
            )
            .expect("count removed server rows");
        assert_eq!(remaining, 3);
        assert_eq!(removed_left, 0);
    }
}

use rusqlite::Connection;
use tauri::AppHandle;

use super::files::{open_readonly, remove_db_with_sidecars, vacuum_copy, MigrationPaths};
use super::rewrite::{
    rewrite_scoped_tables, sum_table_rows, sum_unknown_rows, with_foreign_keys_disabled,
};
use super::{emit_progress, ServerIndexMapping, LIBRARY_TABLES};

pub(super) fn run_library_import(
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
        rewrite_scoped_tables(&dest, LIBRARY_TABLES, mappings, None, |table| {
            done = done.saturating_add(1);
            emit_progress(app, "library", table, done, total)
        })
    })?;
    let source_rows = sum_table_rows(&source, LIBRARY_TABLES)?;
    let imported_rows = sum_table_rows(&dest, LIBRARY_TABLES)?;
    let skipped_unknown_server_rows =
        sum_unknown_rows(&source, LIBRARY_TABLES, &legacy_ids, &index_keys)?;
    Ok((source_rows, imported_rows, skipped_unknown_server_rows))
}

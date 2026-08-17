use rusqlite::Connection;

use super::rewrite::{
    count_rows_in, count_unknown_rows, ensure_foreign_keys_clean, purge_unknown_rows,
    rewrite_scoped_tables, sum_unknown_rows, with_foreign_keys_disabled,
};
use super::{count_rows_eq, ScopedTable, ServerIndexMapping, ANALYSIS_TABLES, LIBRARY_TABLES};

const TEST_TRACK_TABLE: ScopedTable = ScopedTable {
    table: "track",
    column: "server_id",
};

mod counts;
mod full_schema;

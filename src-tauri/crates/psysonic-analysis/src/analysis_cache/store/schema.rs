use rusqlite::Connection;

use super::{AnalysisCache, ANALYSIS_DB_SCHEMA_VERSION};

struct OperationalTable {
    name: &'static str,
    columns: &'static [&'static str],
    primary_key: &'static [&'static str],
}

const OPERATIONAL_TABLES: [OperationalTable; 3] = [
    OperationalTable {
        name: "analysis_track",
        columns: &[
            "server_id",
            "track_id",
            "md5_16kb",
            "status",
            "waveform_algo_version",
            "loudness_algo_version",
            "updated_at",
        ],
        primary_key: &["server_id", "track_id", "md5_16kb"],
    },
    OperationalTable {
        name: "waveform_cache",
        columns: &[
            "server_id",
            "track_id",
            "md5_16kb",
            "bins",
            "bin_count",
            "is_partial",
            "known_until_sec",
            "duration_sec",
            "updated_at",
        ],
        primary_key: &["server_id", "track_id", "md5_16kb"],
    },
    OperationalTable {
        name: "loudness_cache",
        columns: &[
            "server_id",
            "track_id",
            "md5_16kb",
            "integrated_lufs",
            "true_peak",
            "recommended_gain_db",
            "target_lufs",
            "updated_at",
        ],
        primary_key: &["server_id", "track_id", "md5_16kb", "target_lufs"],
    },
];
const OPERATIONAL_INDEXES: [&str; 1] = ["idx_analysis_track_status"];

impl AnalysisCache {
    /// Verify the migration head and objects required by runtime reads/writes.
    pub fn verify_operational_schema(&self) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "analysis_cache lock poisoned".to_string())?;
        verify_operational_schema_conn(&conn)
    }
}

pub(super) fn verify_operational_schema_conn(conn: &Connection) -> Result<(), String> {
    let migration_head = conn
        .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
            row.get::<_, Option<i64>>(0)
        })
        .map_err(|error| format!("analysis migration history unavailable: {error}"))?;
    if migration_head != Some(ANALYSIS_DB_SCHEMA_VERSION) {
        return Err(format!(
            "analysis schema migration head mismatch: expected {}, found {}",
            ANALYSIS_DB_SCHEMA_VERSION,
            migration_head
                .map(|version| version.to_string())
                .unwrap_or_else(|| "none".to_string())
        ));
    }

    let mut missing = Vec::new();
    for table in &OPERATIONAL_TABLES {
        let present = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
                [table.name],
                |row| row.get::<_, bool>(0),
            )
            .map_err(|error| error.to_string())?;
        if !present {
            missing.push(format!("table {}", table.name));
            continue;
        }

        let mut statement = conn
            .prepare("SELECT name, pk FROM pragma_table_info(?1)")
            .map_err(|error| error.to_string())?;
        let columns: Vec<(String, i64)> = statement
            .query_map([table.name], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|error| error.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|error| error.to_string())?;
        for required in table.columns {
            if !columns.iter().any(|(name, _)| name == *required) {
                missing.push(format!("column {}.{required}", table.name));
            }
        }
        let mut actual_primary_key: Vec<(i64, String)> = columns
            .iter()
            .filter(|(_, ordinal)| *ordinal > 0)
            .map(|(name, ordinal)| (*ordinal, name.clone()))
            .collect();
        actual_primary_key.sort_by_key(|(ordinal, _)| *ordinal);
        let actual_primary_key: Vec<String> = actual_primary_key
            .into_iter()
            .map(|(_, name)| name)
            .collect();
        if actual_primary_key
            != table
                .primary_key
                .iter()
                .map(|column| (*column).to_string())
                .collect::<Vec<_>>()
        {
            missing.push(format!(
                "primary key {} expected ({}) found ({})",
                table.name,
                table.primary_key.join(", "),
                actual_primary_key.join(", ")
            ));
        }
    }
    for index in OPERATIONAL_INDEXES {
        let present = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?1)",
                [index],
                |row| row.get::<_, bool>(0),
            )
            .map_err(|error| error.to_string())?;
        if !present {
            missing.push(format!("index {index}"));
        }
    }
    if !missing.is_empty() {
        return Err(format!(
            "analysis schema missing operational objects: {}",
            missing.join(", ")
        ));
    }
    Ok(())
}

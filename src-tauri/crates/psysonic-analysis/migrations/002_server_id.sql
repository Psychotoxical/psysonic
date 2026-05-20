-- Add `server_id` to the analysis cache so waveform/loudness rows are scoped
-- per server (E1 / R7-16). SQLite cannot change a PRIMARY KEY in place, so each
-- table is rebuilt: create the v2 shape, copy every row with server_id = '',
-- drop the old table, rename. Existing rows become legacy ('') rows that the
-- read path still finds (server -> legacy -> lazy re-tag, added in 6c-2).
--
-- Atomicity: the migration runner wraps this whole file plus the
-- schema_migrations marker in one transaction, so any failure or crash rolls
-- everything back to the original tables — DROP never runs unless the copy
-- before it succeeded. No BEGIN/COMMIT here (that would nest).
--
-- These three tables have no foreign keys between them or from any other table,
-- so the drop/rename needs no `PRAGMA foreign_keys` toggle (which is a no-op
-- inside a transaction anyway).

-- analysis_track
CREATE TABLE analysis_track_v2 (
    server_id TEXT NOT NULL DEFAULT '',
    track_id TEXT NOT NULL,
    md5_16kb TEXT NOT NULL,
    status TEXT NOT NULL,
    waveform_algo_version INTEGER NOT NULL,
    loudness_algo_version INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (server_id, track_id, md5_16kb)
);
INSERT INTO analysis_track_v2
    (server_id, track_id, md5_16kb, status, waveform_algo_version, loudness_algo_version, updated_at)
    SELECT '', track_id, md5_16kb, status, waveform_algo_version, loudness_algo_version, updated_at
    FROM analysis_track;
DROP TABLE analysis_track;
ALTER TABLE analysis_track_v2 RENAME TO analysis_track;
CREATE INDEX IF NOT EXISTS idx_analysis_track_status
    ON analysis_track(status);

-- waveform_cache
CREATE TABLE waveform_cache_v2 (
    server_id TEXT NOT NULL DEFAULT '',
    track_id TEXT NOT NULL,
    md5_16kb TEXT NOT NULL,
    bins BLOB NOT NULL,
    bin_count INTEGER NOT NULL,
    is_partial INTEGER NOT NULL,
    known_until_sec REAL NOT NULL,
    duration_sec REAL NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (server_id, track_id, md5_16kb)
);
INSERT INTO waveform_cache_v2
    (server_id, track_id, md5_16kb, bins, bin_count, is_partial, known_until_sec, duration_sec, updated_at)
    SELECT '', track_id, md5_16kb, bins, bin_count, is_partial, known_until_sec, duration_sec, updated_at
    FROM waveform_cache;
DROP TABLE waveform_cache;
ALTER TABLE waveform_cache_v2 RENAME TO waveform_cache;

-- loudness_cache
CREATE TABLE loudness_cache_v2 (
    server_id TEXT NOT NULL DEFAULT '',
    track_id TEXT NOT NULL,
    md5_16kb TEXT NOT NULL,
    integrated_lufs REAL NOT NULL,
    true_peak REAL NOT NULL,
    recommended_gain_db REAL NOT NULL,
    target_lufs REAL NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (server_id, track_id, md5_16kb, target_lufs)
);
INSERT INTO loudness_cache_v2
    (server_id, track_id, md5_16kb, integrated_lufs, true_peak, recommended_gain_db, target_lufs, updated_at)
    SELECT '', track_id, md5_16kb, integrated_lufs, true_peak, recommended_gain_db, target_lufs, updated_at
    FROM loudness_cache;
DROP TABLE loudness_cache;
ALTER TABLE loudness_cache_v2 RENAME TO loudness_cache;

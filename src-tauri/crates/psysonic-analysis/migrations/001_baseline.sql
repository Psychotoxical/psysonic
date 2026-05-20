-- Baseline: the pre-versioning analysis cache schema.
--
-- This is the exact shape every existing user DB already carries (created by
-- the old `CREATE TABLE IF NOT EXISTS` bootstrap). `IF NOT EXISTS` keeps it a
-- no-op on those DBs and creates the tables on a fresh one, so "migration 1
-- applied" means "the schema that shipped before versioned migrations".
--
-- Server-scoping (server_id) is added additively in 002.

CREATE TABLE IF NOT EXISTS analysis_track (
    track_id TEXT NOT NULL,
    md5_16kb TEXT NOT NULL,
    status TEXT NOT NULL,
    waveform_algo_version INTEGER NOT NULL,
    loudness_algo_version INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (track_id, md5_16kb)
);

CREATE TABLE IF NOT EXISTS waveform_cache (
    track_id TEXT NOT NULL,
    md5_16kb TEXT NOT NULL,
    bins BLOB NOT NULL,
    bin_count INTEGER NOT NULL,
    is_partial INTEGER NOT NULL,
    known_until_sec REAL NOT NULL,
    duration_sec REAL NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (track_id, md5_16kb)
);

CREATE TABLE IF NOT EXISTS loudness_cache (
    track_id TEXT NOT NULL,
    md5_16kb TEXT NOT NULL,
    integrated_lufs REAL NOT NULL,
    true_peak REAL NOT NULL,
    recommended_gain_db REAL NOT NULL,
    target_lufs REAL NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (track_id, md5_16kb, target_lufs)
);

CREATE INDEX IF NOT EXISTS idx_analysis_track_status
    ON analysis_track(status);

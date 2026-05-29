-- psysonic-library v1 schema — see implementation-spec.ru.md §5.1–§5.3
-- Tables are ordered so FK targets exist before their referrers.

-- Migration-runner bookkeeping (§5.7). Defined here so the schema file is
-- self-describing — `LibraryStore::run_migrations` also creates this table
-- defensively before applying migrations, which keeps both paths idempotent.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE canonical_track (
  id          TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE canonical_identity (
  canonical_id  TEXT NOT NULL,
  kind          TEXT NOT NULL,
  value         TEXT NOT NULL,
  confidence    REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (kind, value),
  FOREIGN KEY (canonical_id) REFERENCES canonical_track(id)
);

CREATE TABLE sync_state (
  server_id                TEXT NOT NULL,
  library_scope            TEXT NOT NULL DEFAULT '',
  normalized_base_url      TEXT NOT NULL DEFAULT '',
  server_fingerprint_ok    INTEGER,
  fingerprint_checked_at   INTEGER,
  capability_flags         INTEGER NOT NULL DEFAULT 0,
  last_full_sync_at        INTEGER,
  last_delta_sync_at       INTEGER,
  server_last_scan_iso     TEXT,
  indexes_last_modified_ms INTEGER,
  artists_last_modified_ms INTEGER,
  server_track_count       INTEGER,
  local_track_count        INTEGER,
  artist_count             INTEGER,
  library_tier             TEXT NOT NULL DEFAULT 'unknown',
  poll_stats_json          TEXT NOT NULL DEFAULT '{}',
  next_poll_at             INTEGER,
  initial_sync_cursor_json TEXT NOT NULL DEFAULT '{}',
  sync_phase               TEXT NOT NULL DEFAULT 'idle',
  last_error               TEXT,
  n1_bulk_unreliable       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (server_id, library_scope)
);

CREATE TABLE artist (
  server_id    TEXT NOT NULL,
  id           TEXT NOT NULL,
  name         TEXT NOT NULL,
  album_count  INTEGER,
  synced_at    INTEGER NOT NULL,
  raw_json     TEXT,
  PRIMARY KEY (server_id, id)
);

CREATE TABLE album (
  server_id     TEXT NOT NULL,
  id            TEXT NOT NULL,
  name          TEXT NOT NULL,
  artist        TEXT,
  artist_id     TEXT,
  song_count    INTEGER,
  duration_sec  INTEGER,
  year          INTEGER,
  genre         TEXT,
  cover_art_id  TEXT,
  starred_at    INTEGER,
  synced_at     INTEGER NOT NULL,
  raw_json      TEXT,
  PRIMARY KEY (server_id, id)
);

CREATE TABLE track (
  server_id            TEXT NOT NULL,
  id                   TEXT NOT NULL,
  title                TEXT NOT NULL,
  title_sort           TEXT,
  artist               TEXT,
  artist_id            TEXT,
  album                TEXT NOT NULL DEFAULT '',
  album_id             TEXT,
  album_artist         TEXT,
  duration_sec         INTEGER NOT NULL DEFAULT 0,
  track_number         INTEGER,
  disc_number          INTEGER,
  year                 INTEGER,
  genre                TEXT,
  suffix               TEXT,
  bit_rate             INTEGER,
  size_bytes           INTEGER,
  cover_art_id         TEXT,
  starred_at           INTEGER,
  user_rating          INTEGER,
  play_count           INTEGER,
  played_at            INTEGER,
  server_path          TEXT,
  library_id           TEXT,
  isrc                 TEXT,
  mbid_recording       TEXT,
  bpm                  INTEGER,
  replay_gain_track_db REAL,
  replay_gain_album_db REAL,
  content_hash         TEXT,
  server_updated_at    INTEGER,
  server_created_at    INTEGER,
  resync_gen           INTEGER NOT NULL DEFAULT 0,
  deleted              INTEGER NOT NULL DEFAULT 0,
  synced_at            INTEGER NOT NULL,
  raw_json             TEXT NOT NULL,
  PRIMARY KEY (server_id, id)
);

CREATE VIRTUAL TABLE track_fts USING fts5(
  title, artist, album, album_artist, genre,
  content='track', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER track_ai AFTER INSERT ON track BEGIN
  INSERT INTO track_fts(rowid, title, artist, album, album_artist, genre)
  VALUES (new.rowid, new.title, new.artist, new.album, new.album_artist, new.genre);
END;

CREATE TRIGGER track_ad AFTER DELETE ON track BEGIN
  INSERT INTO track_fts(track_fts, rowid, title, artist, album, album_artist, genre)
  VALUES ('delete', old.rowid, old.title, old.artist, old.album, old.album_artist, old.genre);
END;

CREATE TRIGGER track_au AFTER UPDATE ON track BEGIN
  INSERT INTO track_fts(track_fts, rowid, title, artist, album, album_artist, genre)
  VALUES ('delete', old.rowid, old.title, old.artist, old.album, old.album_artist, old.genre);
  INSERT INTO track_fts(rowid, title, artist, album, album_artist, genre)
  VALUES (new.rowid, new.title, new.artist, new.album, new.album_artist, new.genre);
END;

CREATE TABLE track_extension (
  server_id   TEXT NOT NULL,
  track_id    TEXT NOT NULL,
  kind        TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  payload     BLOB NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (server_id, track_id, kind),
  FOREIGN KEY (server_id, track_id) REFERENCES track(server_id, id)
);

-- NO FK to track: survives library purge when user keeps the cached file (§5.14).
CREATE TABLE track_offline (
  server_id         TEXT NOT NULL,
  track_id          TEXT NOT NULL,
  local_path        TEXT NOT NULL,
  file_size_bytes   INTEGER,
  suffix            TEXT,
  content_hash      TEXT NOT NULL DEFAULT '',
  server_path       TEXT,
  cached_at         INTEGER NOT NULL,
  last_verified_at  INTEGER,
  PRIMARY KEY (server_id, track_id)
);

CREATE TABLE track_id_history (
  server_id    TEXT NOT NULL,
  old_id       TEXT NOT NULL,
  new_id       TEXT NOT NULL,
  content_hash TEXT,
  server_path  TEXT,
  remapped_at  INTEGER NOT NULL,
  PRIMARY KEY (server_id, old_id)
);

CREATE TABLE track_fact (
  server_id     TEXT NOT NULL,
  track_id      TEXT NOT NULL,
  fact_kind     TEXT NOT NULL,
  value_real    REAL,
  value_int     INTEGER,
  value_text    TEXT,
  unit          TEXT,
  source_kind   TEXT NOT NULL,
  source_id     TEXT NOT NULL,
  source_detail TEXT,
  confidence    REAL NOT NULL DEFAULT 1.0,
  content_hash  TEXT,
  fetched_at    INTEGER NOT NULL,
  expires_at    INTEGER,
  PRIMARY KEY (server_id, track_id, fact_kind, source_kind, source_id),
  FOREIGN KEY (server_id, track_id) REFERENCES track(server_id, id)
);

CREATE TABLE track_artifact (
  server_id     TEXT NOT NULL,
  track_id      TEXT NOT NULL,
  artifact_kind TEXT NOT NULL,
  format        TEXT NOT NULL,
  language      TEXT,
  source_kind   TEXT NOT NULL,
  source_id     TEXT NOT NULL,
  content_text  TEXT,
  content_blob  BLOB,
  content_bytes INTEGER NOT NULL DEFAULT 0,
  not_found     INTEGER NOT NULL DEFAULT 0,
  content_hash  TEXT,
  fetched_at    INTEGER NOT NULL,
  expires_at    INTEGER,
  PRIMARY KEY (server_id, track_id, artifact_kind, source_kind, source_id, format),
  FOREIGN KEY (server_id, track_id) REFERENCES track(server_id, id)
);

CREATE TABLE track_canonical_link (
  server_id     TEXT NOT NULL,
  track_id      TEXT NOT NULL,
  canonical_id  TEXT NOT NULL,
  match_method  TEXT NOT NULL,
  confidence    REAL NOT NULL,
  linked_at     INTEGER NOT NULL,
  PRIMARY KEY (server_id, track_id),
  FOREIGN KEY (server_id, track_id) REFERENCES track(server_id, id),
  FOREIGN KEY (canonical_id) REFERENCES canonical_track(id)
);

CREATE TABLE canonical_enrichment_link (
  canonical_id    TEXT NOT NULL,
  enrichment_kind TEXT NOT NULL,
  owner_server_id TEXT NOT NULL,
  owner_track_id  TEXT NOT NULL,
  share_policy    TEXT NOT NULL DEFAULT 'isrc_match',
  linked_at       INTEGER NOT NULL,
  PRIMARY KEY (canonical_id, enrichment_kind, owner_server_id, owner_track_id),
  FOREIGN KEY (canonical_id) REFERENCES canonical_track(id)
);

CREATE TABLE play_session (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id        TEXT NOT NULL,
  track_id         TEXT NOT NULL,
  started_at_ms    INTEGER NOT NULL,
  listened_sec     REAL NOT NULL,
  position_max_sec REAL NOT NULL,
  completion       TEXT NOT NULL,
  end_reason       TEXT NOT NULL,
  FOREIGN KEY (server_id, track_id) REFERENCES track(server_id, id),
  CHECK (completion IN ('partial', 'full'))
);

CREATE INDEX idx_track_album   ON track(server_id, album_id)               WHERE deleted = 0;
CREATE INDEX idx_track_artist  ON track(server_id, artist_id)              WHERE deleted = 0;
CREATE INDEX idx_track_updated ON track(server_id, server_updated_at DESC) WHERE deleted = 0;
CREATE INDEX idx_track_starred ON track(server_id, starred_at)             WHERE deleted = 0 AND starred_at IS NOT NULL;
CREATE INDEX idx_track_library ON track(server_id, library_id)             WHERE deleted = 0;
CREATE INDEX idx_track_bpm     ON track(server_id, bpm)                    WHERE deleted = 0 AND bpm IS NOT NULL;
CREATE INDEX idx_track_isrc    ON track(isrc)                              WHERE deleted = 0 AND isrc IS NOT NULL;
CREATE INDEX idx_track_fact_lookup     ON track_fact(server_id, track_id, fact_kind);
CREATE INDEX idx_track_artifact_lookup ON track_artifact(server_id, track_id, artifact_kind);
CREATE INDEX idx_track_offline_hash    ON track_offline(server_id, content_hash);
CREATE INDEX idx_track_id_history_new  ON track_id_history(server_id, new_id);
CREATE INDEX idx_canonical_identity_lookup ON canonical_identity(kind, value);

CREATE INDEX idx_track_remap_path
  ON track(server_id, server_path)
  WHERE deleted = 0 AND server_path IS NOT NULL AND server_path != '';

CREATE INDEX idx_track_remap_hash
  ON track(server_id, content_hash)
  WHERE deleted = 0 AND content_hash IS NOT NULL AND content_hash != '';

CREATE INDEX idx_track_title
  ON track(server_id, title COLLATE NOCASE)
  WHERE deleted = 0;

CREATE INDEX idx_track_genre
  ON track(server_id, genre COLLATE NOCASE)
  WHERE deleted = 0 AND genre IS NOT NULL;

CREATE INDEX idx_track_year
  ON track(server_id, year)
  WHERE deleted = 0 AND year IS NOT NULL;

CREATE INDEX idx_play_session_server_time
  ON play_session(server_id, started_at_ms DESC);

CREATE INDEX idx_play_session_track
  ON play_session(server_id, track_id, started_at_ms DESC);

CREATE INDEX idx_play_session_started
  ON play_session(started_at_ms DESC);

CREATE INDEX idx_track_fact_mood_tag
  ON track_fact(server_id, fact_kind, value_text, track_id)
  WHERE fact_kind = 'mood_tag';

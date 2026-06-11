-- Repair for DBs that recorded legacy migrations 002–011 (removed) before
-- multi-genre tables shipped. Safe on fresh installs (IF NOT EXISTS).
CREATE TABLE IF NOT EXISTS track_genre (
  server_id  TEXT NOT NULL,
  track_id   TEXT NOT NULL,
  genre      TEXT NOT NULL,
  album_id   TEXT,
  library_id TEXT,
  PRIMARY KEY (server_id, track_id, genre COLLATE NOCASE),
  FOREIGN KEY (server_id, track_id) REFERENCES track(server_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_track_genre_browse
  ON track_genre(server_id, genre COLLATE NOCASE, album_id, track_id)
  WHERE album_id IS NOT NULL AND album_id != '';

CREATE TABLE IF NOT EXISTS library_data_migration (
  id            TEXT PRIMARY KEY,
  cursor_rowid  INTEGER NOT NULL DEFAULT 0,
  completed_at  INTEGER,
  started_at    INTEGER
);

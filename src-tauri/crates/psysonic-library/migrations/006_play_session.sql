-- Player listening history — see workdocs player-stats spec §3.1
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

CREATE INDEX idx_play_session_server_time
  ON play_session(server_id, started_at_ms DESC);

CREATE INDEX idx_play_session_track
  ON play_session(server_id, track_id, started_at_ms DESC);

CREATE INDEX idx_play_session_started
  ON play_session(started_at_ms DESC);

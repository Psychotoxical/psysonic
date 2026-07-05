-- Layer-1 scoped browse indexes: (server_id, library_id, …) for sargable IN filters.
CREATE INDEX IF NOT EXISTS idx_track_library_album
  ON track(server_id, library_id, album_id)
  WHERE deleted = 0;

CREATE INDEX IF NOT EXISTS idx_track_library_artist
  ON track(server_id, library_id, artist_id)
  WHERE deleted = 0;

CREATE INDEX IF NOT EXISTS idx_track_library_title
  ON track(server_id, library_id, title COLLATE NOCASE)
  WHERE deleted = 0;

CREATE INDEX IF NOT EXISTS idx_track_library_genre
  ON track(server_id, library_id, genre)
  WHERE deleted = 0;

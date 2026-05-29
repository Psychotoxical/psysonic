-- Advanced search filters on genre and year (partial indexes — only non-null rows).
CREATE INDEX IF NOT EXISTS idx_track_genre
  ON track(server_id, genre COLLATE NOCASE)
  WHERE deleted = 0 AND genre IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_track_year
  ON track(server_id, year)
  WHERE deleted = 0 AND year IS NOT NULL;

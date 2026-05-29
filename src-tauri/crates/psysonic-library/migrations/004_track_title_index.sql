-- Browse / sort-by-title without sorting the full server slice on every page.
CREATE INDEX IF NOT EXISTS idx_track_title
  ON track(server_id, title COLLATE NOCASE)
  WHERE deleted = 0;

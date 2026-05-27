-- Artist-level favorites for local browse / advanced search (§6.5 patch-on-use).
ALTER TABLE artist ADD COLUMN starred_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_artist_starred
  ON artist(server_id, starred_at)
  WHERE starred_at IS NOT NULL;

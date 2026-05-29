-- Remap detection (§6.9) and unstable-id servers: without these indexes
-- each upsert in a 500-row batch can scan the whole track table.

CREATE INDEX IF NOT EXISTS idx_track_remap_path
  ON track(server_id, server_path)
  WHERE deleted = 0 AND server_path IS NOT NULL AND server_path != '';

CREATE INDEX IF NOT EXISTS idx_track_remap_hash
  ON track(server_id, content_hash)
  WHERE deleted = 0 AND content_hash IS NOT NULL AND content_hash != '';

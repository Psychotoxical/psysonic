-- Text keyset cursor for bounded inactive-alias baseline scans.
ALTER TABLE library_data_migration ADD COLUMN cursor_text TEXT;

CREATE INDEX IF NOT EXISTS idx_album_artist_ref
  ON album(server_id, artist_id)
  WHERE artist_id IS NOT NULL AND artist_id != '';

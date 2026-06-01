-- Genre album browse: filter by (server, genre) then group by album_id.
CREATE INDEX IF NOT EXISTS idx_track_genre_album_browse
  ON track(server_id, genre COLLATE NOCASE, album_id)
  WHERE deleted = 0
    AND genre IS NOT NULL
    AND TRIM(genre) != ''
    AND album_id IS NOT NULL
    AND album_id != '';

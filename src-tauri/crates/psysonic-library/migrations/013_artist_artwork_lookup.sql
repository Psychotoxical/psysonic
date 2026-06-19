-- External artist artwork lookup (fanart.tv etc.) — image-scraper design-review §12.
-- Render NEVER reads this table; only the on-demand cover ensure path + the
-- negative cache (`mbid_ambiguous` 24h backoff) use it. `server_id` is the
-- serverIndexKey (same key as coverStorageKey / the on-disk cover path, §27),
-- NOT the auth-profile UUID.
CREATE TABLE IF NOT EXISTS artist_artwork_lookup (
  server_id     TEXT    NOT NULL,
  artist_id     TEXT    NOT NULL,
  surface_kind  TEXT    NOT NULL,            -- 'fanart' (| 'thumb' later)
  mbid          TEXT,                        -- nullable; from tag or MusicBrainz
  mbid_source   TEXT,                        -- 'tag' | 'musicbrainz' | NULL
  status        TEXT    NOT NULL,            -- pending|hit|miss|skipped|no_mbid|mbid_ambiguous|error
  provider      TEXT,                        -- hit source (e.g. 'fanart'); NULL for miss/skipped
  updated_at    INTEGER NOT NULL,            -- unix ms
  PRIMARY KEY (server_id, artist_id, surface_kind)
);

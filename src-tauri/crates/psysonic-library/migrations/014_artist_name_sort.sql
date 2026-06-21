-- Artist browse sort key (Navidrome OrderArtistName parity) + server ignoredArticles watermark.
-- Applied idempotently from store.rs `apply_migration_14` (per-column guard) so a
-- partial apply recovers; keep this file in sync as the canonical DDL.
ALTER TABLE artist ADD COLUMN name_sort TEXT;
ALTER TABLE sync_state ADD COLUMN ignored_articles TEXT;
CREATE INDEX IF NOT EXISTS idx_artist_name_sort ON artist(server_id, name_sort);

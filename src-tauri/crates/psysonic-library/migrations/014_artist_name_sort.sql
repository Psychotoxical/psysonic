-- Artist browse sort key (Navidrome OrderArtistName parity) + server ignoredArticles watermark.
ALTER TABLE artist ADD COLUMN name_sort TEXT;
ALTER TABLE sync_state ADD COLUMN ignored_articles TEXT;

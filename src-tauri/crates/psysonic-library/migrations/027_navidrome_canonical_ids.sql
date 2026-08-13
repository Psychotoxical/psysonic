-- Durable state and finite old->new journal for the stop-the-world Navidrome
-- canonical-ID migration. Journal rows remain only until final verification.
CREATE TABLE IF NOT EXISTS navidrome_canonical_migration (
  server_id            TEXT PRIMARY KEY,
  canonical_version    INTEGER NOT NULL DEFAULT 1,
  state                TEXT NOT NULL,
  probe_kind           TEXT,
  probe_old_id         TEXT,
  probe_new_id         TEXT,
  detected_at          INTEGER NOT NULL,
  native_migrated_at   INTEGER,
  frontend_migrated_at INTEGER,
  full_sync_started_at INTEGER,
  verified_at          INTEGER,
  last_error           TEXT,
  CHECK (state IN (
    'checking', 'not_applicable', 'legacy', 'required', 'rewriting', 'frontend',
    'resyncing', 'ready', 'retryable', 'blocked'
  )),
  CHECK (probe_kind IS NULL OR probe_kind IN ('track', 'album'))
);

CREATE TABLE IF NOT EXISTS navidrome_canonical_journal (
  server_id   TEXT NOT NULL,
  entity_kind TEXT NOT NULL,
  old_id      TEXT NOT NULL,
  new_id      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  error       TEXT,
  PRIMARY KEY (server_id, entity_kind, old_id),
  CHECK (entity_kind IN ('artist', 'album', 'track', 'folder')),
  CHECK (status IN ('pending', 'applied', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_navidrome_canonical_journal_new
  ON navidrome_canonical_journal(server_id, entity_kind, new_id);

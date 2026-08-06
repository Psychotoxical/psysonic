CREATE TABLE IF NOT EXISTS server_identity_transition (
  server_id            TEXT PRIMARY KEY,
  canonical_version    INTEGER NOT NULL DEFAULT 1,
  state                TEXT NOT NULL,
  probe_old_id         TEXT,
  probe_new_id         TEXT,
  detected_at          INTEGER NOT NULL,
  native_migrated_at   INTEGER,
  frontend_acked_at    INTEGER,
  last_error           TEXT,
  CHECK (state IN (
    'legacy',
    'no_legacy_ids',
    'awaiting_supplemental_probe',
    'transition_detected',
    'retryable',
    'pending_frontend',
    'ready',
    'blocked'
  ))
);

CREATE TABLE IF NOT EXISTS entity_id_remap (
  server_id    TEXT NOT NULL,
  entity_kind  TEXT NOT NULL,
  old_id       TEXT NOT NULL,
  new_id       TEXT NOT NULL,
  remapped_at  INTEGER NOT NULL,
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  PRIMARY KEY (server_id, entity_kind, old_id),
  CHECK (entity_kind IN ('artist', 'album', 'track', 'folder'))
);

CREATE INDEX IF NOT EXISTS idx_entity_id_remap_new
  ON entity_id_remap(server_id, entity_kind, new_id);

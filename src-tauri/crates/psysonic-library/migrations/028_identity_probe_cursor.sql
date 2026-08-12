-- JSON-encoded keyset cursor for bounded canonical-ID candidate discovery.
-- Applied idempotently by store.rs so a crash after this single ALTER but
-- before schema_migrations is recorded recovers on the next open.
ALTER TABLE server_identity_transition ADD COLUMN probe_cursor TEXT;

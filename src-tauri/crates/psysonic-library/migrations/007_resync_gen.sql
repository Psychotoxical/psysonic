-- Full-resync orphan sweep (mark-and-sweep via generation stamp).
-- Rows ingested during a resync pass carry the active `resync_gen`; after
-- IS-6 succeeds, live rows with a stale generation are soft-deleted.
ALTER TABLE track ADD COLUMN resync_gen INTEGER NOT NULL DEFAULT 0;

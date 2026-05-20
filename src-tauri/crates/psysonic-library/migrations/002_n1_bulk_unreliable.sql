-- psysonic-library schema v2 — large-library ingest policy (R7-15).
-- Per-server learned flag: when N1 (`/api/song`) returns HTTP 500 beyond a
-- deep offset on a large catalog, the strategy selector stops choosing N1 for
-- that server on future initial syncs (spec §6.3 / R7-15 Q1/Q5). Additive
-- column, DEFAULT 0 → existing rows keep N1 eligible until they hit the wall.
ALTER TABLE sync_state ADD COLUMN n1_bulk_unreliable INTEGER NOT NULL DEFAULT 0;

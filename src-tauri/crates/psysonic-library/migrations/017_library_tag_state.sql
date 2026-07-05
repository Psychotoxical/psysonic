-- Per-server library tagging pass state (post-sync album-membership tagging).
CREATE TABLE IF NOT EXISTS library_tag_state (
  server_id TEXT PRIMARY KEY,
  folders_hash TEXT NOT NULL,
  last_untagged_count INTEGER NOT NULL DEFAULT 0,
  completed_at INTEGER NOT NULL
);

-- Atomic mood tags for Advanced Search (EXISTS on track_fact).
CREATE INDEX IF NOT EXISTS idx_track_fact_mood_tag
  ON track_fact(server_id, fact_kind, value_text, track_id)
  WHERE fact_kind = 'mood_tag';

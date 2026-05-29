-- Oximedia mood heuristics were misleading; drop accumulated mood facts.
DELETE FROM track_fact
 WHERE fact_kind IN ('mood_tag', 'moods', 'valence', 'arousal', 'mood_labels');

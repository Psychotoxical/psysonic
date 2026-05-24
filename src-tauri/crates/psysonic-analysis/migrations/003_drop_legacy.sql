-- Drop legacy analysis rows (empty server_id + scheme-scoped keys).
--
-- We now use a scheme-less key (host + optional path), so any rows keyed by
-- `http://` / `https://` or by the pre-002 empty scope are invalid and must be
-- rebuilt by analysis.

DELETE FROM analysis_track
WHERE server_id = ''
   OR server_id LIKE 'http://%'
   OR server_id LIKE 'https://%';

DELETE FROM waveform_cache
WHERE server_id = ''
   OR server_id LIKE 'http://%'
   OR server_id LIKE 'https://%';

DELETE FROM loudness_cache
WHERE server_id = ''
   OR server_id LIKE 'http://%'
   OR server_id LIKE 'https://%';

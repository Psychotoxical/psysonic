-- Drop legacy library rows keyed by scheme URLs (http/https).
-- Server keys are now scheme-less (host + optional path).

DELETE FROM track_extension WHERE server_id LIKE 'http://%' OR server_id LIKE 'https://%';
DELETE FROM track_fact WHERE server_id LIKE 'http://%' OR server_id LIKE 'https://%';
DELETE FROM track_artifact WHERE server_id LIKE 'http://%' OR server_id LIKE 'https://%';
DELETE FROM track_canonical_link WHERE server_id LIKE 'http://%' OR server_id LIKE 'https://%';
DELETE FROM track_id_history WHERE server_id LIKE 'http://%' OR server_id LIKE 'https://%';
DELETE FROM play_session WHERE server_id LIKE 'http://%' OR server_id LIKE 'https://%';
DELETE FROM track_offline WHERE server_id LIKE 'http://%' OR server_id LIKE 'https://%';
DELETE FROM track WHERE server_id LIKE 'http://%' OR server_id LIKE 'https://%';
DELETE FROM album WHERE server_id LIKE 'http://%' OR server_id LIKE 'https://%';
DELETE FROM artist WHERE server_id LIKE 'http://%' OR server_id LIKE 'https://%';
DELETE FROM sync_state WHERE server_id LIKE 'http://%' OR server_id LIKE 'https://%';

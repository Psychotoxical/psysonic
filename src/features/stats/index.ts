/**
 * Statistics feature — listening stats dashboard (player-stats heatmap, recent
 * days, library aggregates) and its recording-enabled gate. The `Statistics`
 * page is loaded lazily by the router via its deep path, so it is intentionally
 * not re-exported here.
 */
export { usePlayerStatsRecordingEnabled } from './hooks/usePlayerStatsRecordingEnabled';

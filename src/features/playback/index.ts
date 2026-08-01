/**
 * Playback feature public surface. Cross-feature consumers import from here
 * (not deep module paths) so the dependency-cruiser layering guard stays green.
 * Kept intentionally small — extend as other features need a symbol.
 */
export { usePlayerStore } from './store/playerStore';
export { seedQueueResolver } from './store/queueTrackResolver';
export { queueSongStar } from './store/pendingStarSync';
export { getPlaybackProgressSnapshot, subscribePlaybackProgress } from './store/playbackProgress';
export type { PlaybackProgressSnapshot } from './store/playbackProgress';
export {
  playbackCacheKeyForTrack,
  playbackCoverArtForAlbum,
  playbackProfileIdForTrack,
} from './utils/playback/playbackServer';
export { useVolumeToggle } from './hooks/useVolumeToggle';
export { usePlaybackLibraryNavigate } from './hooks/usePlaybackLibraryNavigate';
export { TrackArtistLinks } from './components/TrackArtistLinks';
export { sameQueueTrack } from './utils/playback/queueIdentity';
export { queueTrackIdsForServerProfile } from './utils/playback/trackServerScope';

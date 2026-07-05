/**
 * Unified cover art pipeline — see workdocs tasks/2026-05-cover-art-pipeline/contracts.md
 */
export * from './types';
export { coverServerScopeForServerId } from './serverScope';
export * from './tiers';
export * from './ids';
export * from './storageKeys';
export * from './reachability';
export * from './layoutSizes';
export * from './resolveEntry';
export * from './resolveEntryLibrary';
export * from './ref';
export { useCoverArt } from './useCoverArt';
export {
  useAlbumCoverRef,
  useArtistCoverRef,
  usePlaybackTrackCoverRef,
  useTrackCoverRef,
} from './useLibraryCoverRef';
export { CoverArtImage } from './CoverArtImage';
export { AlbumCoverArtImage } from './AlbumCoverArtImage';
export { ArtistCoverArtImage } from './ArtistCoverArtImage';
export { TrackCoverArtImage } from './TrackCoverArtImage';
export { useLibraryCoverPrefetch } from './useLibraryCoverPrefetch';
export {
  clearAllDiskSrcCache,
  forgetDiskSrc,
  forgetDiskSrcPrefix,
  getDiskSrc,
  rememberDiskSrc,
} from './diskSrcCache';
export { usePlaybackCoverArt } from './usePlaybackCoverArt';
export {
  resolveAlbumCoverEntry,
  resolveArtistCoverEntry,
  resolveArtistPageSongFetchCoverArtId,
  resolveTrackCoverEntry,
  resolveSongFetchCoverArtId,
  coverEntryToRef,
} from './resolveEntry';
export {
  resolveAlbumCoverRefsFromLibrary,
  resolveArtistCoverRefsFromLibrary,
  resolveTrackCoverRefsFromLibrary,
} from './resolveEntryLibrary';
export {
  resolveArtistPageSongCoverArtId,
  resolvePlaybackTrackCoverArtId,
  resolveSubsonicSongCoverArtId,
} from './resolveCoverArtId';
export { ensureCoverTierJs } from './resolveJs';
export { ensureCoverTierDiskSrc, ensureCoverTierDiskBlob } from './resolveDisk';
export { buildCoverArtFetchUrl } from './fetchUrl';
export {
  coverStorageKey,
  coverIndexKeyFromScope,
  coverIndexKeyFromRef,
} from './storageKeys';
export {
  acquireUrl,
  releaseUrl,
  getCachedBlob,
  getImageCacheSize,
  subscribeCoverUpgraded,
  invalidateCacheKey,
  invalidateCoverArt,
  clearImageCache,
} from './imageCache';
export { STORE_NAME } from './imageCache/constants';
export { openDB } from './imageCache/idbStore';

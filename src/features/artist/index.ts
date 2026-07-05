/**
 * Artist feature — the Artists overview + ArtistDetail (both lazy via their deep
 * `pages/*` paths, not re-exported), artist cards/rows/avatars, the detail hero +
 * similar-artists + top-tracks UI, the artist Subsonic API, browse catalog/
 * filter/scroll hooks, and per-artist offline status. `sortArtistAlbums` moved
 * in from `lib/library/` (artist-only sort, not the shared index query engine).
 * `OpenArtistRefInline` moved out to `ui/` (a shared presentational primitive,
 * consumed by ~10 features) to break the album ⇄ artist import cycle.
 *
 * Stays OUT (other owners): `deriveAlbumHeaderArtistRefs` (album header),
 * `playArtistShuffled` + `trackArtistRefs` (playback/track helpers), the
 * `*ContextItems`/`*ToPlaylistSubmenu` items (the cross-cutting context-menu
 * subsystem, shared with album), and `PlaylistArtistCell` (playlist).
 */
export * from './hooks/useArtistDetailData';
export * from './hooks/useArtistInfoBatch';
export * from './hooks/useArtistOfflineState';
export * from './hooks/useArtistsBrowseCatalog';
export * from './hooks/useArtistsBrowseFilters';
export * from './hooks/useArtistsBrowseScrollReset';
export * from './hooks/useArtistsBrowseScrollRestore';
export * from './hooks/useArtistsFiltering';
export * from './hooks/useArtistSimilarArtists';
export * from './hooks/useArtistsInfiniteScroll';
export * from './hooks/useBrowseArtistTextSearch';
export * from './hooks/useNavigateToArtist';
export * from './store/artistAlbumYearSortStore';
export * from './store/artistBrowseSessionStore';
export * from './store/artistLayoutStore';
export * from './utils/artistsHelpers';
export * from './utils/runArtistDetailActions';
export * from './utils/runArtistDetailPlay';
export * from './utils/sortArtistAlbums';
export { default as ArtistCardLocal } from './components/ArtistCardLocal';
export { default as ArtistDetailHero } from './components/ArtistDetailHero';
export { default as ArtistDetailSimilarArtists } from './components/ArtistDetailSimilarArtists';
export { default as ArtistDetailTopTracks } from './components/ArtistDetailTopTracks';
export { default as ArtistRow } from './components/ArtistRow';
export { default as ArtistTopTrackCover } from './components/ArtistTopTrackCover';

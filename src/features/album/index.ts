/**
 * Album feature — the Albums/Random/Lossless/Label browse pages + AlbumDetail
 * (all lazy via deep `pages/*`, not re-exported), album cards/rows/header, the
 * album track list + its mobile/header/row pieces, album detail + browse hooks,
 * the album session store, per-album offline status, and album export helpers.
 *
 * Stays OUT (library-core / cross-cutting, consumed by this feature, not owned):
 * the `lib/library/album*` browse query engine (shared with offline + other
 * browse surfaces → M4), `albumDetailNavigation` (cross-cutting nav → M4),
 * `playAlbum` (playback action → playback), `starredAlbumIndexSync` (index
 * sync, core), the album context-menu items (context-menu subsystem), the
 * shared `TracklistColumnPicker` (also used by favorites), and `cover/*`.
 */
export * from './hooks/useAlbumBrowseData';
export * from './hooks/useAlbumBrowseFilters';
export * from './hooks/useAlbumBrowseScrollReset';
export * from './hooks/useAlbumBrowseScrollRestore';
export * from './hooks/useAlbumCatalogYearBounds';
export * from './hooks/useAlbumDetailBack';
export * from './hooks/useAlbumDetailData';
export * from './hooks/useAlbumDetailSort';
export * from './hooks/useAlbumGridBrowseFilters';
export * from './hooks/useAlbumOfflineState';
export * from './hooks/useAlbumTrackListSelection';
export * from './hooks/useBrowseAlbumTextSearch';
export * from './hooks/useGenreAlbumBrowse';
export * from './hooks/useNavigateToAlbum';
export * from './store/albumBrowseSessionStore';
export * from './utils/albumDetailHelpers';
export * from './utils/albumRecency';
export * from './utils/albumTrackListHelpers';
export * from './utils/deriveAlbumHeaderArtistRefs';
export * from './utils/exportAlbumCard';
export * from './utils/exportNewAlbums';
export { default as AlbumCard } from './components/AlbumCard';
export { default as AlbumHeader } from './components/AlbumHeader';
export { default as AlbumRow } from './components/AlbumRow';
export { default as AlbumTrackList } from './components/AlbumTrackList';
export { default as LosslessAlbumsRail } from './components/LosslessAlbumsRail';

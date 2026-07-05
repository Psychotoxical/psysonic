/**
 * Offline feature — offline mode + the downloaded/pinned-library machinery:
 * the offline/job/zip-download/download-modal stores, the offline-browse and
 * media-resolution utils, pin-queue + sync engines, the offline overlays/banner,
 * and the OfflineLibrary page (lazy via the deep path `pages/OfflineLibrary`, so
 * it is not re-exported here). The favorites-offline integration layer
 * (`favoritesOffline*`, `favoritesOfflineSyncStore`) lives here too — the
 * offline core owns it; the favorites feature consumes it through this barrel.
 *
 * Stays OUT (consumed by, not owned by, offline): the per-entity offline-status
 * hooks `useAlbumOfflineState` / `useArtistOfflineState` (album/artist),
 * `runPlaylistZipDownload` (playlist), `ensureQueueServerPinned` (playback), and
 * the `localPlayback*` byte-store substrate (decided with playback, which moves
 * last). Playback-core (`playTrackAction`) and the server key-remigration infra
 * consume this barrel — the correct feature→feature edge, realized early.
 */
export * from './hooks/useOfflineAutoNav';
export * from './hooks/useOfflineBrowseContext';
export * from './hooks/useOfflineBrowseReloadToken';
export * from './hooks/useOfflineLibraryFilterSuspend';
export * from './hooks/useZipDownloadBridge';
export * from '@/store/devOfflineBrowseStore';
export * from './store/downloadModalStore';
export * from './store/favoritesOfflineSyncStore';
export * from './store/offlineJobStore';
export * from './store/offlineStore';
export * from './store/zipDownloadStore';
export * from './utils/favoritesOfflineBrowse';
export * from './utils/favoritesOfflineConstants';
export * from './utils/favoritesOfflineSync';
export * from './utils/legacyOfflineFileMigration';
export * from './utils/libraryTierReconcile';
export * from './utils/offlineActionPolicy';
export * from './utils/offlineAlbumBrowseCatalog';
export * from './utils/offlineBrowseContext';
export * from './utils/offlineBrowseMode';
export * from './utils/offlineBrowseRouting';
export * from './utils/offlineLibraryFilterSuspend';
export * from './utils/offlineLibraryHelpers';
export * from './utils/offlineLibraryIndexLoad';
export * from './utils/offlineLocalBrowse';
export * from './utils/offlineMediaResolve';
export * from './utils/offlineNavPolicy';
export * from './utils/offlinePinQueue';
export * from './utils/offlinePlaylistBrowse';
export * from './utils/offlineStarredLoad';
export * from './utils/pinnedOfflineSync';
export * from './utils/resumeIncompleteOfflinePins';
// `OfflinePinKind` (= PinSource['kind']) is declared in both pin modules; the
// explicit re-export resolves the `export *` ambiguity (TS2308).
export type { OfflinePinKind } from './utils/offlinePinQueue';
export { OfflineLibraryDiskStat } from './components/OfflineLibraryDiskStat';
export { default as DownloadFolderModal } from './components/DownloadFolderModal';
export { default as OfflineBanner } from './components/OfflineBanner';
export { default as ZipDownloadOverlay } from './components/ZipDownloadOverlay';

// Offline feature UI — import from here, not `@/features/offline`, so utils/stores
// loaded at boot never pull lucide-react through the root barrel.

export { OfflineLibraryDiskStat } from '../components/OfflineLibraryDiskStat';
export { default as DownloadFolderModal } from '../components/DownloadFolderModal';
export { default as OfflineBanner } from '../components/OfflineBanner';
export { default as ZipDownloadOverlay } from '../components/ZipDownloadOverlay';

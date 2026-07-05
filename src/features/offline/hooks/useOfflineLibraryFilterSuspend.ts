import { useEffect, useRef } from 'react';
import { useOfflineBrowseContext } from '@/features/offline/hooks/useOfflineBrowseContext';
import {
  restoreMusicLibraryFiltersAfterOffline,
  suspendMusicLibraryFiltersForOffline,
} from '@/features/offline/utils/offlineLibraryFilterSuspend';

/** Disable scoped library browse offline; restore the picker value when back online. */
export function useOfflineLibraryFilterSuspend(): void {
  const offlineBrowseActive = useOfflineBrowseContext().active;
  const prevOfflineRef = useRef<boolean | null>(null);

  useEffect(() => {
    const prev = prevOfflineRef.current;
    prevOfflineRef.current = offlineBrowseActive;

    if (prev === null) {
      if (offlineBrowseActive) suspendMusicLibraryFiltersForOffline();
      return;
    }
    if (offlineBrowseActive && !prev) {
      suspendMusicLibraryFiltersForOffline();
    } else if (!offlineBrowseActive && prev) {
      restoreMusicLibraryFiltersAfterOffline();
    }
  }, [offlineBrowseActive]);
}

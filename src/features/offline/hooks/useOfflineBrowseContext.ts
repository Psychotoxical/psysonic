import { useAuthStore } from '@/store/authStore';
import { useOfflineStore } from '@/features/offline/store/offlineStore';
import { useConnectionStatus } from '@/lib/hooks/useConnectionStatus';
import { usePlayerStatsRecordingEnabled } from '@/features/stats';
import { hasOfflineBrowsingContent } from '@/features/offline/utils/favoritesOfflineBrowse';
import { useOfflineBrowseActive } from '@/features/offline/utils/offlineBrowseMode';
import {
  buildOfflineBrowseContext,
  computeOfflineBrowseCapabilities,
  type OfflineBrowseContext,
} from '@/features/offline/utils/offlineBrowseContext';

/** Single subscription for shell and pages: offline browse mode + capabilities. */
export function useOfflineBrowseContext(): OfflineBrowseContext {
  const active = useOfflineBrowseActive();
  const serverId = useAuthStore(s => s.activeServerId);
  const favoritesOfflineEnabled = useAuthStore(s => s.favoritesOfflineEnabled);
  const offlineAlbums = useOfflineStore(s => s.albums);
  const playerStats = usePlayerStatsRecordingEnabled();
  const { status: connStatus } = useConnectionStatus();

  const capabilities = computeOfflineBrowseCapabilities({
    activeServerId: serverId,
    favoritesOfflineEnabled,
    offlineAlbums,
    playerStats,
  });

  return buildOfflineBrowseContext({
    active,
    serverId,
    capabilities,
    connStatus,
    hasBrowsingContent: hasOfflineBrowsingContent(offlineAlbums),
  });
}
